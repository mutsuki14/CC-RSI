// Interactive task state machine (SPEC §11.2) and verification-job file helpers (SPEC §11.5).
//
// `task.json` is changed only under the session LeaseLock (`<sl>/.lock`), held for a state
// transition only (hooks wait at most 5 s for it, then fail open). The verdict fields are written
// by the verification job and the MCP server, never from conversation text (SPEC §2 boundary 2;
// PR §4.7). This module is imported by hooks, so it stays light: node:*, lib/core and
// ./session.mjs.
//
// Ports: dsh-rsi src/host/task-state.ts (per-session task and verdict bookkeeping) with the cc-rsi
// changes of PR §4.4: one Verifier context per task across turns, confirm codes, prevTask.

import { readFileSync } from 'node:fs'
import { readdir, rename } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { readJson, readJsonSafe, readJsonSafeSync, writeJsonAtomic } from '../core/atomic.mjs'
import { compactStamp } from '../core/ids.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { createLogger } from '../core/log.mjs'
import { pidAlive, spawnDetached } from '../core/proc.mjs'
import { CODE_ROOT } from './session.mjs'

/** A job whose heartbeat is older than this (and whose pid cannot be shown alive) is dead (SPEC §11.5). */
export const HEARTBEAT_STALE_MS = 30000
/** A live pid with a heartbeat this old is checked for pid reuse (Linux /proc cmdline). */
const REUSE_CHECK_MS = 120000
const NUDGE_KEEP = 64

const TERMINAL = new Set(['PASS', 'FAIL'])

/** Whether a verdict can be learned (PASS or FAIL; UNVERIFIED and infra never are). */
export function isTerminal(verdict) {
  return TERMINAL.has(verdict)
}

/** The initial task.json state of a session (SPEC §11.2). */
export function emptyState(sid) {
  return {
    v: 1,
    sessionId: sid ?? null,
    taskSeq: 0,
    task: null,
    prevTask: null,
    job: null,
    learning: null,
    stop: { nudged: [], gate: null, unverifiedStops: 0 },
    lastDeliveredJob: null,
  }
}

function normalize(state, sid) {
  const base = emptyState(sid)
  if (!state || typeof state !== 'object' || Array.isArray(state)) return base
  const out = { ...base, ...state, v: 1 }
  if (!out.stop || typeof out.stop !== 'object') out.stop = base.stop
  if (!Array.isArray(out.stop.nudged)) out.stop.nudged = []
  if (!Number.isInteger(out.stop.unverifiedStops)) out.stop.unverifiedStops = 0
  if (!Number.isInteger(out.taskSeq) || out.taskSeq < 0) out.taskSeq = 0
  return out
}

function sidOf(sl, sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : basename(sl.dir)
}

/** Reads task.json without the lock (hooks' read-only view). Missing or unreadable → emptyState. */
export async function readTask(sl, { sessionId } = {}) {
  return normalize(await readJsonSafe(sl.task, null), sidOf(sl, sessionId))
}

/** Synchronous `readTask`. */
export function readTaskSync(sl, { sessionId } = {}) {
  return normalize(readJsonSafeSync(sl.task, null), sidOf(sl, sessionId))
}

async function loadLocked(sl, sid) {
  try {
    return normalize(await readJson(sl.task, null), sid)
  } catch (error) {
    // A corrupt state file is kept aside (never silently overwritten) and the session starts afresh.
    const aside = `${sl.task}.corrupt-${compactStamp()}`
    await rename(sl.task, aside).catch(() => undefined)
    createLogger(join(sl.dir, 'task-errors.log'), 'task').error('task.json was unreadable; moved aside', { aside, error: error?.message })
    return emptyState(sid)
  }
}

/**
 * Runs `fn(state)` under the session LeaseLock and writes the result atomically when it changed
 * (SPEC §11.2). `fn` may mutate `state` in place or return a new state; it may be async but must
 * stay short (hooks wait at most `waitMs` for the lock). Returns the resulting state. Throws
 * LockTimeoutError when the lock stays held for `waitMs`.
 */
export async function withTask(sl, fn, { waitMs = 5000, sessionId } = {}) {
  const sid = sidOf(sl, sessionId)
  const lock = new LeaseLock(sl.lock, { waitMs, leaseMs: 30000, heartbeatMs: 2000, pollMs: 25, owner: { kind: 'session-task', sessionId: sid } })
  await lock.acquire()
  try {
    const state = await loadLocked(sl, sid)
    const before = JSON.stringify(state)
    const result = await fn(state)
    const next = normalize(result && typeof result === 'object' ? result : state, sid)
    if (next.stop.nudged.length > NUDGE_KEEP) next.stop.nudged = next.stop.nudged.slice(-NUDGE_KEEP)
    if (JSON.stringify(next) !== before) await writeJsonAtomic(sl.task, next)
    return next
  } finally {
    await lock.release()
  }
}

/** The Verifier context key of a task: `task-<seq>-v<ctxIndex>`. */
export function ctxKeyFor(taskSeq, ctxIndex) {
  return `task-${taskSeq}-v${ctxIndex}`
}

function newTask({ seq, requestSeq, openDigest, openRoot, baselineFile, now }) {
  return {
    seq,
    firstRequestSeq: Number.isInteger(requestSeq) && requestSeq > 0 ? requestSeq : null,
    openedAt: now.toISOString(),
    openDigest: typeof openDigest === 'string' ? openDigest : null,
    openRoot: typeof openRoot === 'string' ? openRoot : null,
    baselineFile: typeof baselineFile === 'string' ? baselineFile : null,
    candidateRoot: null,
    verifier: { ctxIndex: 0, ctxKey: null, sessionId: null, model: null, modelSource: null, lastUsed: null, retired: false },
    generation: 0,
    reports: [],
    lastVerdict: null,
    lastVerdictGen: null,
    lastVerdictRequestSeq: null,
    learned: false,
    closed: false,
  }
}

/**
 * Opens a new task (SPEC §11.2): `taskSeq++`; the previous task becomes `prevTask` when it holds an
 * unlearned PASS/FAIL, otherwise `prevTask = null`. Mutates and returns `state`.
 */
export function openTask(state, { requestSeq = null, openDigest = null, openRoot = null, baselineFile = null, now = new Date() } = {}) {
  const old = state.task
  state.prevTask = old && isTerminal(old.lastVerdict) && !old.learned ? old : null
  state.taskSeq = (Number.isInteger(state.taskSeq) ? state.taskSeq : 0) + 1
  state.task = newTask({ seq: state.taskSeq, requestSeq, openDigest, openRoot, baselineFile, now })
  return state
}

/** Whether a UserPromptSubmit may open a task now (SPEC §11.2 first row). */
export function mayOpenOnPrompt(state) {
  if (state.learning != null || state.job != null) return false
  const t = state.task
  return t == null || t.closed === true || t.lastVerdict === 'PASS'
}

/** The task to learn from: terminal (PASS|FAIL) and not learned; `task` first, then `prevTask` (SPEC §11.2). */
export function learnTarget(state) {
  for (const which of ['task', 'prevTask']) {
    const t = state?.[which]
    if (t && isTerminal(t.lastVerdict) && t.learned !== true) return { which, t }
  }
  return null
}

/** The report entry of a task's last verdict, or null. */
export function lastReport(t) {
  if (!t || !Array.isArray(t.reports) || t.reports.length === 0) return null
  return t.reports.find(r => r.gen === t.lastVerdictGen) ?? t.reports[t.reports.length - 1]
}

/** `task` or `prevTask` with this seq, as `{ which, t }`, or null. */
export function taskBySeq(state, seq) {
  if (state?.task?.seq === seq) return { which: 'task', t: state.task }
  if (state?.prevTask?.seq === seq) return { which: 'prevTask', t: state.prevTask }
  return null
}

/**
 * Job result: verdict (SPEC §11.2): pushes the report onto the job's task (or prevTask; when
 * neither matches only verdicts.jsonl records it), sets the last-verdict fields, `learned = false`,
 * the Verifier session and lastUsed, and clears `job` when it is this job. Idempotent per jobId.
 */
export function applyVerdict(state, { jobId, taskSeq, generation, verdict, reportSha, statusDigest = null, candidateDigest = null,
  isolation = null, model = null, verifierSessionId = null, requestSeq = null, at = new Date().toISOString() } = {}) {
  const hit = taskBySeq(state, taskSeq)
  // Applied once per job: a repeated application (recovery, delivery healing) never resets
  // `learned` or the last-verdict fields of a task that has moved on.
  if (hit && !(Array.isArray(hit.t.reports) && hit.t.reports.some(r => r.jobId === jobId))) {
    const t = hit.t
    if (!Array.isArray(t.reports)) t.reports = []
    t.reports.push({ gen: generation, jobId, verdict, reportSha, statusDigest, candidateDigest, isolation, model, at })
    t.lastVerdict = verdict
    t.lastVerdictGen = generation
    t.lastVerdictRequestSeq = Number.isInteger(requestSeq) ? requestSeq : null
    t.learned = false
    if (t.verifier && typeof verifierSessionId === 'string') {
      t.verifier.sessionId = verifierSessionId
      t.verifier.lastUsed = at
    }
  }
  if (state.job && state.job.id === jobId) state.job = null
  return state
}

/** Classes after which the task's Verifier context is not resumed again (SPEC §10.12, §11.2). */
export function retiresContext(cls, established) {
  return cls === 'context_overflow' || (cls === 'session_missing' && established === true)
}

/** Job result: infra (SPEC §11.2): no verdict; `job = null`; retire the Verifier context on overflow or a lost transcript. */
export function applyInfra(state, { jobId, taskSeq, cls, established = false } = {}) {
  if (state.job && state.job.id === jobId) state.job = null
  const hit = taskBySeq(state, taskSeq)
  if (hit && hit.t.verifier && retiresContext(cls, established)) hit.t.verifier.retired = true
  return state
}

// ---------------------------------------------------------------- job files (SPEC §11.5)

/** `<sl.jobs>/<jobId>.json`. */
export function jobPath(sl, jobId) {
  return join(sl.jobs, `${jobId}.json`)
}

/** A job file, or null. */
export async function readJob(path) {
  const job = await readJsonSafe(path, null)
  return job && typeof job === 'object' && typeof job.id === 'string' ? job : null
}

/** Synchronous `readJob`. */
export function readJobSync(path) {
  const job = readJsonSafeSync(path, null)
  return job && typeof job === 'object' && typeof job.id === 'string' ? job : null
}

/** Every job of a session, oldest first (by createdAt, then id). */
export async function listJobs(sl) {
  const names = await readdir(sl.jobs).catch(() => [])
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const job = await readJob(join(sl.jobs, name))
    if (job) out.push(job)
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))
}

/** On Linux, whether a live `pid` no longer runs the verification job (pid reuse). Unknown → false. */
function pidReused(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return !cmdline.includes('verify-job')
  } catch {
    return false
  }
}

/**
 * Whether a queued or running job has died (SPEC §11.5 recovery). A job is dead when its pid (the
 * job file's, else `pid` from the caller, e.g. `task.job.pid`) is known on this host and gone, or
 * when its heartbeat is older than 30 s and no live pid can be attributed to it. A live pid keeps a
 * job alive (unattended recovery never runs while the job runs) unless Linux shows the pid now runs
 * another program.
 */
export function jobIsDead(job, { now = Date.now(), pid: fallbackPid = null } = {}) {
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return false
  const beat = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.createdAt ?? '')
  const age = Number.isFinite(beat) ? now - beat : Infinity
  const pid = Number.isInteger(job.pid) && job.pid > 0 ? job.pid : Number.isInteger(fallbackPid) && fallbackPid > 0 ? fallbackPid : null
  const sameHost = typeof job.host !== 'string' || job.host === hostname()
  if (pid !== null && sameHost) {
    if (!pidAlive(pid)) return true
    return age > REUSE_CHECK_MS && pidReused(pid)
  }
  return age > HEARTBEAT_STALE_MS
}

/** The verification job program (spawned by path; hooks never import it). */
export const VERIFY_JOB_PATH = join(CODE_ROOT, 'lib', 'interactive', 'verify-job.mjs')

/**
 * Spawns `verify-job.mjs recover <jobFile>` detached (SPEC §11.5 recovery). Recovery takes its own
 * lock, so duplicate spawns are harmless. Returns the pid, or null when the spawn failed.
 */
export function spawnRecovery(jobFile, { env = process.env } = {}) {
  try {
    const childEnv = { ...env }
    delete childEnv.CC_RSI_ROLE
    return spawnDetached(process.execPath, [VERIFY_JOB_PATH, 'recover', jobFile], { env: childEnv, logFile: jobFile.replace(/\.json$/, '.log') })
  } catch {
    return null
  }
}

/** Spawns recovery for every dead queued/running job of a session. Returns the job ids. */
export async function recoverDeadJobs(sl, { env = process.env, taskJob = null } = {}) {
  const out = []
  for (const job of await listJobs(sl)) {
    const pid = taskJob && taskJob.id === job.id ? taskJob.pid : null
    if (jobIsDead(job, { pid })) {
      spawnRecovery(jobPath(sl, job.id), { env })
      out.push(job.id)
    }
  }
  return out
}

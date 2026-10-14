// Interactive task state machine (SPEC §11.2) and verification-job file helpers (SPEC §11.5).
//
// `task.json` is changed only under the session LeaseLock (`<sl>/.lock`), held for a state
// transition only (hooks wait at most 5 s for it, then fail open). The verdict fields are written
// by the verification job and the MCP server, never from conversation text (SPEC §2 boundary 2;
// PR §4.7). This module is imported by hooks, so it stays light: node:*, lib/core, ./session.mjs
// and lib/runtime/models.mjs (node:* only).
//
// Ports: dsh-rsi src/host/task-state.ts (per-session task and verdict bookkeeping) with the cc-rsi
// changes of PR §4.4: one Verifier context per task across turns, confirm codes, prevTask.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readJson, readJsonSafe, readJsonSafeSync, writeJsonAtomic } from '../core/atomic.mjs'
import { compactStamp } from '../core/ids.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { sameMachine } from '../core/machine.mjs'
import { createLogger } from '../core/log.mjs'
import { pidAlive, spawnDetached } from '../core/proc.mjs'
import { claudeConfigDir } from '../runtime/models.mjs'
import { CODE_ROOT } from './session.mjs'

/** A job whose heartbeat is older than this (and whose pid cannot be shown alive) is dead (SPEC §11.5). */
export const HEARTBEAT_STALE_MS = 30000
/** A live pid with a heartbeat this old is checked for pid reuse (Linux /proc cmdline). */
const REUSE_CHECK_MS = 120000
/**
 * A live pid whose process identity cannot be established (no start token recorded or readable)
 * no longer keeps a job or lock alive once its heartbeat is this old (portability-2: a pid reused
 * after a crash or reboot, where /proc is unavailable).
 */
export const IDENTITY_STALE_MS = 600000
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
    verifierSessionIds: [],
    verifierCandidateRoots: [],
  }
}

const usableId = id => typeof id === 'string' && id !== ''

const usableRoot = root => typeof root === 'string' && root.startsWith('/')

/**
 * Records a Verifier context's Claude Code session id in the session-wide, append-only
 * `verifierSessionIds` list (security-3), and the candidate root it inspects (its cwd, which names
 * its Claude Code transcript directory) in the append-only `verifierCandidateRoots`. The
 * main-session guard keeps every listed transcript and those directories private; nothing is ever
 * removed (also not on a context restart, a new task or a retired context). Mutates and returns
 * `state`.
 */
export function noteVerifierSession(state, id, candidateRoot = null) {
  if (usableId(id)) {
    if (!Array.isArray(state.verifierSessionIds)) state.verifierSessionIds = []
    if (!state.verifierSessionIds.includes(id)) state.verifierSessionIds.push(id)
  }
  if (usableRoot(candidateRoot)) {
    if (!Array.isArray(state.verifierCandidateRoots)) state.verifierCandidateRoots = []
    if (!state.verifierCandidateRoots.includes(candidateRoot)) state.verifierCandidateRoots.push(candidateRoot)
  }
  return state
}

function normalize(state, sid) {
  const base = emptyState(sid)
  if (!state || typeof state !== 'object' || Array.isArray(state)) return base
  const out = { ...base, ...state, v: 1 }
  if (!out.stop || typeof out.stop !== 'object') out.stop = base.stop
  if (!Array.isArray(out.stop.nudged)) out.stop.nudged = []
  if (!Number.isInteger(out.stop.unverifiedStops)) out.stop.unverifiedStops = 0
  if (!Number.isInteger(out.taskSeq) || out.taskSeq < 0) out.taskSeq = 0
  // The id list is append-only; ids known from the task records (states written before the list
  // existed) are folded in, never dropped.
  out.verifierSessionIds = Array.isArray(out.verifierSessionIds) ? out.verifierSessionIds.filter(usableId) : []
  out.verifierCandidateRoots = Array.isArray(out.verifierCandidateRoots) ? out.verifierCandidateRoots.filter(usableRoot) : []
  for (const t of [out.task, out.prevTask]) {
    noteVerifierSession(out, t?.verifier?.sessionId, usableId(t?.verifier?.sessionId) ? t?.candidateRoot : null)
  }
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
    if (JSON.stringify(next) !== before) {
      // Fencing (memory-crash-1/-9): a lock taken over while this holder was stopped or slow never
      // lets two writers race task.json. Throws LockTimeoutError('lock_lost'); nothing is written.
      await lock.assertHeld()
      await writeJsonAtomic(sl.task, next)
    }
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
  isolation = null, model = null, verifierModel, verifierSessionId = null, requestSeq = null, transcript = null, at = new Date().toISOString() } = {}) {
  const hit = taskBySeq(state, taskSeq)
  noteVerifierSession(state, verifierSessionId)
  // Applied once per job: a repeated application (recovery, delivery healing) never resets
  // `learned` or the last-verdict fields of a task that has moved on.
  if (hit && !(Array.isArray(hit.t.reports) && hit.t.reports.some(r => r.jobId === jobId))) {
    const t = hit.t
    if (!Array.isArray(t.reports)) t.reports = []
    // `verifierModel`: the model configured for the publishing context (the Verifier model chain's
    // result), so a later fresh context on another model is told the reports are not its own.
    t.reports.push({ gen: generation, jobId, verdict, reportSha, statusDigest, candidateDigest, isolation, model, ...(verifierModel !== undefined ? { verifierModel } : {}), at })
    t.lastVerdict = verdict
    t.lastVerdictGen = generation
    t.lastVerdictRequestSeq = Number.isInteger(requestSeq) ? requestSeq : null
    t.learned = false
    if (t.verifier && typeof verifierSessionId === 'string') {
      t.verifier.sessionId = verifierSessionId
      t.verifier.lastUsed = at
      t.verifier.transcript = transcript && transcript.sessionId === verifierSessionId ? transcript : null
    }
  }
  if (state.job && state.job.id === jobId) state.job = null
  return state
}

/** Classes after which the task's Verifier context is not resumed again (SPEC §10.12, §11.2). */
export function retiresContext(cls, established) {
  return cls === 'context_overflow' || (cls === 'session_missing' && established === true)
}

/**
 * Job result: infra (SPEC §11.2): no verdict; `job = null`; retire the Verifier context on overflow
 * or a lost transcript. A job that conversed with the task's current context records the new
 * transcript fingerprint (`transcript`), so its growth is not later mistaken for tampering.
 */
export function applyInfra(state, { jobId, taskSeq, cls, established = false, transcript = null } = {}) {
  if (state.job && state.job.id === jobId) state.job = null
  const hit = taskBySeq(state, taskSeq)
  noteVerifierSession(state, transcript?.sessionId)
  if (hit && hit.t.verifier && retiresContext(cls, established)) hit.t.verifier.retired = true
  if (hit && hit.t.verifier && transcript && usableId(transcript.sessionId) && hit.t.verifier.sessionId === transcript.sessionId) {
    hit.t.verifier.transcript = transcript
  }
  return state
}

// ---------------------------------------------------------------- Verifier transcripts (security-3)

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/

/**
 * Every Claude Code transcript of `sessionId`: `<configDir>/projects/<any>/<sessionId>.jsonl`
 * (`--resume <id>` searches all projects, so every match counts). Sorted absolute paths.
 */
export function transcriptPaths(sessionId, { env = process.env } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return []
  const projects = join(claudeConfigDir(env), 'projects')
  let names = []
  try {
    names = readdirSync(projects)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const path = join(projects, name, `${sessionId}.jsonl`)
    try {
      lstatSync(path)
      out.push(path)
    } catch {
      // no transcript of this session in that project
    }
  }
  return out.sort()
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * The fingerprint of a Verifier context's transcript(s): `{ sessionId, files: [{ path, size,
 * sha256, link }] }` (security-3: recorded after each job in `task.verifier.transcript`, compared
 * before the context is resumed). An unreadable file is recorded with `sha256: null`. Null for an
 * unusable id.
 */
export async function transcriptFingerprint(sessionId, { env = process.env } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null
  const files = []
  for (const path of transcriptPaths(sessionId, { env })) {
    let link = false
    let size = null
    let sha256 = null
    try {
      link = lstatSync(path).isSymbolicLink()
      size = statSync(path).size
      sha256 = await sha256File(path)
    } catch {
      sha256 = null
    }
    files.push({ path, size, sha256, link })
  }
  return { sessionId, files }
}

/** Whether two transcript fingerprints describe the same transcript state. */
export function sameTranscript(a, b) {
  if (!a || !b || a.sessionId !== b.sessionId) return false
  return JSON.stringify(a.files ?? null) === JSON.stringify(b.files ?? null)
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

// ---------------------------------------------------------------- process identity (portability-2)

let bootIdCache = null
function bootId() {
  if (bootIdCache === null) {
    try {
      bootIdCache = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    } catch {
      bootIdCache = ''
    }
  }
  return bootIdCache
}

function psField(pid, field) {
  if (process.platform === 'win32') return null
  try {
    const r = spawnSync('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })
    const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
    return out === '' ? null : out
  } catch {
    return null
  }
}

/**
 * A token naming the process that holds `pid` now, from its start time: Linux
 * `linux:<boot_id>:<starttime>` (/proc/<pid>/stat field 22), elsewhere `ps:<lstart>`
 * (`ps -o lstart=`). Null when it cannot be read (no such process, no /proc and no ps).
 */
export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const start = fields[19] // field 22 (fields[0] is field 3, the state)
    if (/^\d+$/.test(start ?? '')) return `linux:${bootId()}:${start}`
  } catch {
    // no /proc (macOS) or masked: fall back to ps
  }
  const lstart = psField(pid, 'lstart')
  return lstart === null ? null : `ps:${lstart}`
}

/**
 * Whether the process holding `pid` now is the one whose start token was recorded: true, false, or
 * null when unknown (no token recorded, the token cannot be read now, or the two were taken by
 * different methods).
 */
export function sameProcess(pid, token) {
  if (typeof token !== 'string' || token === '') return null
  const now = processStartToken(pid)
  if (now === null) return null
  const scheme = t => t.slice(0, t.indexOf(':'))
  if (scheme(now) !== scheme(token)) return null
  return now === token
}

/** Whether a live `pid` no longer runs the verification job (pid reuse; /proc cmdline, else ps). Unknown → false. */
function pidReused(pid) {
  let cmdline = null
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    cmdline = psField(pid, 'command')
  }
  return cmdline === null ? false : !cmdline.includes('verify-job')
}

/**
 * Whether a queued or running job has died (SPEC §11.5 recovery). A job is dead when its pid (the
 * job file's, else `pid` from the caller, e.g. `task.job.pid`) is known on this host and gone, or
 * when its heartbeat is older than 30 s and no live pid can be attributed to it. A live pid keeps a
 * job alive (unattended recovery never runs while the job runs) unless it is shown to be another
 * process: the job's recorded start token (`pidStart`) differs, or (no identity available) the pid
 * now runs another program, or its heartbeat is older than IDENTITY_STALE_MS (portability-2: a pid
 * reused after a crash on a system without /proc). `identityOf` is injectable for tests.
 */
export function jobIsDead(job, { now = Date.now(), pid: fallbackPid = null, identityOf = sameProcess } = {}) {
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return false
  const beat = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.createdAt ?? '')
  const age = Number.isFinite(beat) ? now - beat : Infinity
  const own = Number.isInteger(job.pid) && job.pid > 0
  const pid = own ? job.pid : Number.isInteger(fallbackPid) && fallbackPid > 0 ? fallbackPid : null
  const sameHost = typeof job.host !== 'string' || sameMachine(job)
  if (pid !== null && sameHost) {
    if (!pidAlive(pid)) return true
    // A fresh heartbeat proves the job runs, whatever holds the pid.
    if (age <= HEARTBEAT_STALE_MS) return false
    const same = own ? identityOf(pid, job.pidStart) : null
    if (same === true) return false
    if (same === false) return true
    if (age > REUSE_CHECK_MS && pidReused(pid)) return true
    return age > IDENTITY_STALE_MS
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

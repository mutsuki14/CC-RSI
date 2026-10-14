// The five cc-rsi MCP tools (SPEC §11.11): submit, wait_verdict, learn, memory_commit, status.
//
// State-changing tools are bound to the calling Claude Code conversation by PreToolUse attestation
// keyed by tool_use_id (SPEC §11.4, J1-1) and refuse subagents. `submit` starts a detached
// verification job and waits for it for at most ~100 s (SPEC §11.5 server side, J2-12); the job
// alone writes the verdict. Learning is the Actor's own distill → reconcile → promote sequence on a
// draft directory, gated by confirmation codes (PR §4.4) and committed only through the store
// (SPEC §2 boundary 5).
//
// Ports: dsh-rsi src/index.ts:560-791 (rsi_submit, rsi_learn, rsi_memory_commit results and
// refusals) with the cc-rsi tool names, attestation, the detached job and confirm codes.

import { join } from 'node:path'
import { readJsonSafe, readJsonSafeSync, writeJsonAtomic } from '../core/atomic.mjs'
import { confirmCode, interactiveEpisode, newJobId, pad3, uuid } from '../core/ids.mjs'
import { createLogger } from '../core/log.mjs'
import { ccRsiHome, globalLayout, safeName } from '../core/paths.mjs'
import { spawnDetached } from '../core/proc.mjs'
import { guidanceCommitResult, guidanceInfra, guidanceLearnStart, guidanceRefusal, guidanceRunning, guidanceVerdict } from '../prompts/guidance.mjs'
import { renderSection } from '../prompts/render.mjs'
import { formatLeads, validateLeadArgs } from '../protocol/leads.mjs'
import { decideIsolation, effectiveProbe, readProbe, staticProbe } from '../runtime/sandbox.mjs'
import { takeAttestation } from '../interactive/attest.mjs'
import { refreshView } from '../interactive/memview.mjs'
import { lastRequestSeq, readRequests, taskMessagesFor } from '../interactive/requests.mjs'
import {
  MCP_OPT_PREFIX, developsPlugin, lineageCounters, lineageStates, openStore, peekStore, pluginCodeChanged, pluginRootOf, readSessionByEnv,
  recordTranscriptModel, resolveVerifierModel, sessionContext, workspaceDigest, workspaceRootFor,
} from '../interactive/session.mjs'
import {
  VERIFY_JOB_PATH, applyInfra, applyVerdict, ctxKeyFor, isTerminal, jobIsDead, jobPath, lastReport, learnTarget, listJobs, noteVerifierSession,
  openTask, readJob, readTask, sameTranscript, spawnRecovery, taskBySeq, transcriptFingerprint, withTask,
} from '../interactive/task.mjs'
import { listLocksSync, lockCovering, recoverPendingLocks } from '../interactive/wslock.mjs'

/** Prefix of the tool names the model and the hooks see (claude-code-experiments.md e). */
export const TOOL_PREFIX = 'mcp__plugin_cc-rsi_rsi__'

const RESULT_META = Object.freeze({ 'anthropic/maxResultSizeChars': 200000 })
const WRITE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false })
const NO_ARGS = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })

const SUBMIT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    evidence_leads: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', minLength: 1, maxLength: 2000 },
          probe: { type: 'string', minLength: 1, maxLength: 4000 },
        },
        required: ['claim', 'probe'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
})

// `confirm` is required unless `abandon` is true (checked in memory_commit: the small validator and
// the tool schema shown to the model carry no conditional requirements). Abandoning only discards
// the draft, so it needs no code (cc-integration-5: a code lost to compaction must not trap the Actor).
const COMMIT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    confirm: { type: 'string', pattern: '^[0-9a-f]{6}$' },
    abandon: { type: 'boolean' },
  },
  additionalProperties: false,
})

/** The tool catalog (SPEC §11.11 table; descriptions adapted from dsh-host-messages.md). */
export const TOOLS = Object.freeze([
  {
    name: 'submit',
    description: 'Submit the current workspace for independent verification when a non-trivial task is complete. A separate Verifier (another Claude Code process) inspects the live workspace against the user\'s own recent messages; it never sees your reasoning. File edits and shell commands are paused until the verdict. After an UNVERIFIED verdict, pass evidence_leads: CLAIM/PROBE pairs where each probe is one read-only command that prints PASS only when the claim holds.',
    inputSchema: SUBMIT_SCHEMA,
    annotations: WRITE_ANNOTATIONS,
    _meta: RESULT_META,
  },
  {
    name: 'wait_verdict',
    description: 'Wait for (up to ~100 s) and receive the verdict of a running verification.',
    inputSchema: NO_ARGS,
    annotations: WRITE_ANNOTATIONS,
    _meta: RESULT_META,
  },
  {
    name: 'learn',
    description: 'After a terminal verdict (PASS or FAIL), open a learning phase: distill what a future agent should reuse into a draft of the project memory, then call memory_commit twice (reconcile, then promote) with the confirmation codes you are given.',
    inputSchema: NO_ARGS,
    annotations: WRITE_ANNOTATIONS,
    _meta: RESULT_META,
  },
  {
    name: 'memory_commit',
    description: 'Advance the open learning phase. Pass confirm: the confirmation code from the latest stage message (call learn to re-show the current stage message and its code). abandon:true discards the draft and needs no code.',
    inputSchema: COMMIT_SCHEMA,
    annotations: WRITE_ANNOTATIONS,
    _meta: RESULT_META,
  },
  {
    name: 'status',
    description: 'Show cc-rsi state for this session and project.',
    inputSchema: NO_ARGS,
    annotations: Object.freeze({ readOnlyHint: true }),
    _meta: RESULT_META,
  },
])

const STATE_CHANGING = new Set(['submit', 'wait_verdict', 'learn', 'memory_commit'])
const POLL_MS = 250
const PROGRESS_MS = 5000
/** Store lock wait of calls that wait for a job (cc-integration-8): storeFlags tolerates a busy store. */
const WAITING_STORE_LOCK_MS = 3000
/** Time kept back for delivering a result after the wait (store, digest, task transition). */
const DELIVER_RESERVE_MS = 8000
const MIN_WAIT_MS = 1000
const AUTO_BACKGROUND_DEFAULT_MS = 120000

/** The way out of a learning phase whose stage message was lost (cc-integration-5). */
const LEARN_HINT = 'Call learn to re-show the current stage message and its confirmation code; memory_commit with abandon:true discards the draft without a code.'

const text = (body, isError = false) => (isError ? { content: [{ type: 'text', text: body }], isError: true } : { content: [{ type: 'text', text: body }] })
const refusal = kind => text(guidanceRefusal(kind), true)

/** A learning refusal that also names the way out, unless its text already does. */
function learningRefusal(kind) {
  const result = refusal(kind)
  return /call learn\b/i.test(result.content[0].text) ? result : withNotes(result, [LEARN_HINT])
}

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve()
  const timer = setTimeout(done, ms)
  function done() {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', done)
    resolve()
  }
  signal?.addEventListener?.('abort', done, { once: true })
})

// ---------------------------------------------------------------- argument validation

function checkString(value, spec, where) {
  if (typeof value !== 'string') return `${where} must be a string`
  if (Number.isInteger(spec.minLength) && value.length < spec.minLength) return `${where} must not be empty`
  if (Number.isInteger(spec.maxLength) && value.length > spec.maxLength) return `${where} must be at most ${spec.maxLength} characters`
  if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(value)) return `${where} must match ${spec.pattern}`
  return null
}

/** Validates `args` against the (small) JSON schemas above. Returns a problem sentence or null. */
export function validateArgs(schema, args) {
  const value = args === undefined || args === null ? {} : args
  if (typeof value !== 'object' || Array.isArray(value)) return 'arguments must be an object'
  const props = schema.properties ?? {}
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(props, key) && schema.additionalProperties === false) return `unknown argument "${key}"`
  }
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) return `argument "${key}" is required`
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = value[key]
    if (v === undefined) continue
    if (spec.type === 'string') {
      const problem = checkString(v, spec, `"${key}"`)
      if (problem) return problem
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') return `"${key}" must be a boolean`
    } else if (spec.type === 'array') {
      if (!Array.isArray(v)) return `"${key}" must be an array`
      if (Number.isInteger(spec.maxItems) && v.length > spec.maxItems) return `"${key}" holds at most ${spec.maxItems} items`
      for (let i = 0; i < v.length; i++) {
        const problem = validateArgs(spec.items, v[i])
        if (problem) return `"${key}"[${i}]: ${problem}`
      }
    } else if (spec.type === 'object') {
      const problem = validateArgs(spec, v)
      if (problem) return `"${key}": ${problem}`
    }
  }
  return null
}

// ---------------------------------------------------------------- shared helpers

/** waitSeconds(config, env) (SPEC §11.11, J2-12): min(waitSeconds ≤ 110, auto-background − 10 s), floor 10. */
export function waitSeconds(config, env = process.env) {
  const configured = Number(config?.interactive?.waitSeconds)
  let secs = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 110) : 100
  const auto = Number(env?.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)
  if (Number.isFinite(auto) && auto > 0) secs = Math.min(secs, auto / 1000 - 10)
  return Math.max(10, secs)
}

/**
 * How long a call may still wait for a job, in ms (cc-integration-8): waitSeconds, but the whole
 * call (from `receivedAt`, when tools/call arrived) stays 10 s under Claude Code's auto-background
 * threshold (CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, default 120 s) with a reserve for delivering the
 * result. Floor 1 s. Without `receivedAt` it is waitSeconds.
 */
export function waitBudgetMs(config, env = process.env, { receivedAt = null, now = Date.now() } = {}) {
  const configured = waitSeconds(config, env) * 1000
  if (!Number.isFinite(receivedAt)) return configured
  const auto = Number(env?.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)
  const threshold = Number.isFinite(auto) && auto > 0 ? auto : AUTO_BACKGROUND_DEFAULT_MS
  const left = threshold - 10000 - Math.max(0, now - receivedAt) - DELIVER_RESERVE_MS
  return Math.max(MIN_WAIT_MS, Math.min(configured, left))
}

const REMEDIES = {
  workspace_busy: 'Another verification holds this workspace: call wait_verdict, or call submit again after it finishes.',
  sandbox_required: 'isolation.sandbox is "require" but no OS sandbox is available here: ask the user to run cc-rsi doctor in a terminal.',
  auth: 'Ask the user to run cc-rsi doctor --live in a terminal; apiKeyHelper/env from ~/.claude/settings.json are forwarded automatically.',
  restore_failed: 'The workspace stays locked: ask the user to inspect the displaced copies and run cc-rsi doctor --release-lock <root> in a terminal.',
  cancelled: 'Call submit again when you want an independent verdict.',
  job_died: 'Call submit again.',
  checkpoint_failed: 'Call submit again; if this repeats, ask the user to run cc-rsi doctor in a terminal.',
  candidate_changed_during_inspection: 'Stop every background process that can change the workspace (TaskStop), then call submit again.',
}

/** The INFRASTRUCTURE result of an infra job (SPEC §11.13). */
function infraResult(job) {
  const cls = job?.infra?.cls ?? 'error'
  let remedy = REMEDIES[cls] ?? 'Call submit again; if this repeats, ask the user to run cc-rsi doctor in a terminal.'
  if (cls === 'config') {
    const model = job?.verifier?.model
    remedy = `The Verifier model${model ? ` "${model}"` : ''} or its configuration was rejected: check the verifier_model setting (models.verifier) and ask the user to run cc-rsi doctor.`
  }
  if (cls === 'restore_failed') remedy = remedy.replace('<root>', job?.candidateRoot ?? '<root>')
  // Paths the restore could not roll back (detect-only checkpoint) or that changed again afterwards
  // (memory-crash-7): the Actor must not assume the workspace is clean.
  const notes = []
  const notRestored = Array.isArray(job?.infra?.notRestored) ? job.infra.notRestored.map(String) : []
  if (notRestored.length > 0) {
    notes.push(renderSection('guidance-harness-note', 'detect-only', { COUNT: notRestored.length, PATHS: pathList(notRestored) }).trim())
  }
  const unstable = Array.isArray(job?.infra?.unstable) ? job.infra.unstable.map(String) : []
  if (unstable.length > 0) notes.push(`HARNESS NOTE: ${unstable.length} path(s) were changed by something outside the inspection after the restore: ${pathList(unstable)}`)
  return withNotes(text(guidanceInfra({ cls, detail: job?.infra?.detail ?? '', remedy }), true), notes)
}

function pathList(paths) {
  return `${paths.slice(0, 20).join(', ')}${paths.length > 20 ? ', …' : ''}`
}

/** The note of a PASS whose inspection saw pre-existing files change (security-2, rollback mode). */
function notCurrentNote(notCurrent) {
  const paths = Array.isArray(notCurrent?.paths) ? notCurrent.paths.map(String) : []
  return `NOTE: ${paths.length} pre-existing path(s) changed while the Verifier inspected the workspace and were restored afterwards (${pathList(paths)}), so the Verifier may have judged a different tree than your candidate. This verdict does not count as current: it cannot be learned and does not cover the workspace. If something outside the inspection changed them (for example a background process), stop it (TaskStop) and call submit again.`
}

function withNotes(result, notes) {
  const extra = notes.filter(Boolean)
  if (extra.length === 0) return result
  return { ...result, content: [{ type: 'text', text: `${result.content[0].text}\n\n${extra.join('\n')}` }] }
}

const LEADS_IGNORED_NOTE = 'NOTE: evidence_leads are forwarded only after an UNVERIFIED verdict; they were ignored for this submission.'

function storeDirOf(ctx) {
  return typeof ctx.config?.memory?.dir === 'string' && ctx.config.memory.dir !== '' ? ctx.config.memory.dir : undefined
}

/**
 * Store flags without failing the call: `{store, frozen, sealed, tamper}` (store null when it cannot
 * be opened). Calls that wait for a job pass a short `lockWaitMs` (cc-integration-8).
 */
async function storeFlags(ctx, logger, { lockWaitMs = 15000 } = {}) {
  let store = null
  try {
    store = await openStore(ctx.config, ctx.pl, { lockWaitMs, logger })
  } catch (error) {
    logger.warn('memory store unavailable', { error: error?.message })
    return { store: null, frozen: false, sealed: null, tamper: false }
  }
  let tamper = false
  try {
    await store.assertCanonicalIntact()
  } catch (error) {
    if (error?.code === 'memory_tamper') tamper = true
    else logger.warn('memory integrity check failed', { error: error?.message })
  }
  return { store, frozen: Boolean(await store.frozen()), sealed: await store.sealed(), tamper }
}

function modeOf(ctx, frozen) {
  return frozen || ctx.config?.mode === 'frozen' ? 'frozen' : 'learn'
}

// ---------------------------------------------------------------- delivery and waiting

/**
 * Marks a finished job delivered (SPEC §11.5 `deliver`) and heals the task transition when the
 * job's own write was lost. With `mark: false` only the (idempotent) transition is healed: the
 * result could not reach the Actor (a cancelled request, an unreadable store), so a later
 * wait_verdict still delivers it.
 */
async function markDelivered(ctx, job, { mark = true } = {}) {
  const path = jobPath(ctx.sl, job.id)
  if (mark) {
    const current = await readJob(path)
    if (current && (current.status === 'done' || current.status === 'infra') && current.delivered !== true) {
      await writeJsonAtomic(path, { ...current, delivered: true, deliveredAt: new Date().toISOString() })
    }
  }
  await withTask(ctx.sl, s => {
    if (mark) s.lastDeliveredJob = job.id
    if (job.status === 'done' && job.result) {
      applyVerdict(s, {
        jobId: job.id, taskSeq: job.taskSeq, generation: job.generation, verdict: job.result.verdict, reportSha: job.result.reportSha,
        statusDigest: job.result.statusDigest ?? null, candidateDigest: job.result.candidateDigest ?? null, isolation: job.result.isolation?.mode ?? null,
        model: job.result.model ?? null, verifierSessionId: job.result.verifierSessionId ?? null, transcript: job.result.transcript ?? null,
        at: job.result.finishedAt,
      })
    } else {
      applyInfra(s, { jobId: job.id, taskSeq: job.taskSeq, cls: job.infra?.cls ?? 'error' })
    }
  }, { waitMs: 10000, sessionId: ctx.sid }).catch(() => undefined)
}

/** The result text of a finished job (verdict guidance or INFRASTRUCTURE). */
async function deliver(c, job, notes = []) {
  const { ctx, logger } = c
  let result
  let mark = true
  if (job.status === 'done' && job.result) {
    const flags = await storeFlags(ctx, logger, { lockWaitMs: WAITING_STORE_LOCK_MS })
    const report = flags.store ? await flags.store.getReport(job.result.reportSha) : undefined
    if (!flags.store) {
      // Transient: the verdict stays undelivered, so wait_verdict delivers it later.
      mark = false
      result = text(guidanceInfra({ cls: 'store_unavailable', detail: 'the project memory store holding the report could not be opened', remedy: 'Call wait_verdict again.' }), true)
    } else if (report === undefined) {
      result = text(guidanceInfra({ cls: 'report_unavailable', detail: 'the stored Verifier report is missing or failed its integrity check', remedy: 'Call submit again.' }), true)
    } else {
      const current = await workspaceDigest(job.candidateRoot, { home: ctx.home, storeDir: storeDirOf(ctx) })
      const stale = typeof job.result.statusDigest === 'string' && typeof current === 'string' && current !== job.result.statusDigest
      let memoryNonEmpty = false
      try {
        memoryNonEmpty = (await flags.store.inventory()).files.length > 0
      } catch { /* treat as empty */ }
      result = text(guidanceVerdict({
        verdict: job.result.verdict,
        report,
        generation: job.generation,
        isolation: job.result.isolation,
        model: job.result.model ?? job.verifier?.model ?? null,
        memoryNonEmpty,
        memoryDir: ctx.sl.viewDir,
        mode: modeOf(ctx, flags.frozen || (flags.sealed && flags.sealed.learningAfterSealed !== true)),
        restored: job.result.restored ?? [],
        displaced: job.result.displaced ?? [],
        detectOnly: job.result.detectOnly === true,
        staleDigestNote: job.result.notCurrent ? notCurrentNote(job.result.notCurrent) : stale ? true : undefined,
        tamperNote: flags.tamper ? true : undefined,
      }))
    }
  } else {
    result = infraResult(job)
  }
  // A cancelled request gets no response (jsonrpc.mjs): its verdict stays undelivered.
  await markDelivered(ctx, job, { mark: mark && !c.signal?.aborted })
  return withNotes(result, [...notes, job.leadsIgnored ? LEADS_IGNORED_NOTE : null])
}

/**
 * Waits for a job to finish for at most `waitSeconds` (SPEC §11.5 step 5), sending progress every
 * 5 s, spawning recovery once when its process died. Returns the verdict/infra result, or
 * VERIFICATION RUNNING on timeout.
 */
async function waitForJob(c, jobId, { taskJobPid = null, notes = [] } = {}) {
  const { ctx, signal, progress } = c
  const path = jobPath(ctx.sl, jobId)
  const waitMs = Number.isFinite(c.waitMs) ? c.waitMs : waitBudgetMs(ctx.config, c.env, { receivedAt: c.receivedAt })
  const totalSec = Math.round(waitMs / 1000)
  const start = Date.now()
  let lastProgress = start
  let recovering = false
  for (;;) {
    const job = await readJob(path)
    if (!job) {
      // A task entry without a job record can never finish: release the session from it.
      await withTask(ctx.sl, s => applyInfra(s, { jobId, taskSeq: s.job?.taskSeq ?? null, cls: 'job_missing' }), { waitMs: 10000, sessionId: ctx.sid }).catch(() => undefined)
      return text(guidanceInfra({ cls: 'job_missing', detail: `the record of verification job ${jobId} is missing`, remedy: 'Call submit again.' }), true)
    }
    if (job.status === 'done' || job.status === 'infra') return deliver(c, job, notes)
    if (!recovering && jobIsDead(job, { pid: taskJobPid })) {
      recovering = true
      spawnRecovery(path, { env: c.env })
    }
    const now = Date.now()
    if (now - start >= waitMs || signal?.aborted) {
      const startedMs = Date.parse(job.startedAt ?? job.createdAt ?? '')
      const elapsedSec = Number.isFinite(startedMs) ? (now - startedMs) / 1000 : (now - start) / 1000
      return withNotes(text(guidanceRunning({ jobId, generation: job.generation, elapsedSec })), [...notes, job.leadsIgnored ? LEADS_IGNORED_NOTE : null])
    }
    if (progress && now - lastProgress >= PROGRESS_MS) {
      lastProgress = now
      const elapsed = Math.round((now - start) / 1000)
      try {
        progress(elapsed, totalSec, `independent verification running (${elapsed} s)`)
      } catch { /* progress is best effort */ }
    }
    await sleep(Math.min(POLL_MS, Math.max(1, waitMs - (now - start))), signal)
  }
}

/** The newest finished job of the session that was never delivered, or null. */
async function undeliveredJob(sl) {
  const jobs = await listJobs(sl)
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i]
    if ((job.status === 'done' || job.status === 'infra') && job.delivered !== true) return job
  }
  return null
}

function lastVerdictLine(state) {
  const t = state.task
  if (!t || !t.lastVerdict) return 'none'
  return `${t.lastVerdict} (task ${t.seq}, generation ${t.lastVerdictGen})`
}

// ---------------------------------------------------------------- submit

/** The newest manifest of an earlier generation of this task (CHANGED SINCE YOUR LAST INSPECTION), or null. */
function prevManifestFor(sl, taskSeq, generation) {
  for (let g = generation - 1; g >= 1; g--) {
    const path = join(sl.manifests, `t${pad3(taskSeq)}-g${pad3(g)}.json`)
    if (readJsonSafeSync(path, null) !== null) return path
  }
  return null
}

async function submit(c, args) {
  const { ctx, env, logger, att } = c
  const { sl, sid, config } = ctx
  const flags = await storeFlags(ctx, logger, { lockWaitMs: WAITING_STORE_LOCK_MS })
  const notes = []
  if (flags.tamper) notes.push('WARNING: canonical memory changed outside a commit; learning is refused until the user runs cc-rsi memory verify in a terminal.')
  const peek = await readTask(sl, { sessionId: sid })
  if (peek.job) return waitForJob(c, peek.job.id, { taskJobPid: peek.job.pid, notes })
  if (peek.learning) return learningRefusal('learning_open')
  const pendingDelivery = await undeliveredJob(sl)
  if (pendingDelivery && pendingDelivery.status === 'done' && pendingDelivery.result
    && pendingDelivery.taskSeq === peek.task?.seq && pendingDelivery.generation === peek.task?.generation) {
    // The verdict of the last submission was never delivered. While it still covers the workspace
    // it is delivered instead of a redundant inspection; a stale one is superseded by a new one.
    const current = await workspaceDigest(pendingDelivery.candidateRoot, { home: ctx.home, storeDir: storeDirOf(ctx) })
    const still = pendingDelivery.result.statusDigest == null ? current === null : current === pendingDelivery.result.statusDigest
    if (still) return deliver(c, pendingDelivery, notes)
  }
  // The plugin code must still be the code this session started with (security-4): each submit
  // spawns verify-job.mjs from disk, so changed code would judge the candidate. Infra-class: no job,
  // no verdict.
  const changed = pluginCodeChanged(ctx.session, { projectRoot: ctx.projectRoot, env })
  if (changed) {
    logger.warn('plugin code changed since SessionStart; submit refused', { sessionId: sid, recorded: changed.recorded, current: changed.current })
    return withNotes(text(guidanceInfra({
      cls: 'plugin_changed',
      detail: 'the cc-rsi plugin code changed during this session; no verification was started',
      remedy: 'Restart Claude Code, or ask the user to run cc-rsi doctor in a terminal.',
    }), true), notes)
  }
  const pluginFingerprint = typeof ctx.session?.pluginFingerprint === 'string' && !developsPlugin(ctx.projectRoot, { env }) ? ctx.session.pluginFingerprint : null
  const candidateRoot = await workspaceRootFor(att?.cwd ?? ctx.projectDir, { projectDir: ctx.projectDir })
  const lastSeq = await lastRequestSeq(sl)
  const requests = await readRequests(sl)
  // The session model from the transcript when no hook reported one (cc-integration-3; the attest
  // hook already does this before every attested call).
  await recordTranscriptModel(ctx, att?.transcript_path).catch(() => null)
  const resolved = resolveVerifierModel(config, ctx.session, env)
  const given = Array.isArray(args?.evidence_leads) ? args.evidence_leads : []
  // The task context's transcript as it is now (security-3), hashed outside the session lock.
  const peekSid = peek.task?.verifier?.sessionId
  const transcriptNow = typeof peekSid === 'string' && peekSid !== '' ? await transcriptFingerprint(peekSid, { env }).catch(() => null) : null
  const jobId = newJobId()
  const file = jobPath(sl, jobId)
  let outcome = null
  await withTask(sl, async s => {
    if (s.job) { outcome = { wait: s.job }; return }
    if (s.learning) { outcome = { refuse: 'learning_open' }; return }
    const t0 = s.task
    const needNew = !t0 || t0.closed === true
      || (typeof t0.candidateRoot === 'string' && t0.candidateRoot !== candidateRoot)
      || (t0.lastVerdict === 'PASS' && lastSeq > (Number.isInteger(t0.lastVerdictRequestSeq) ? t0.lastVerdictRequestSeq : lastSeq))
    // Leads are validated before any state change (SPEC §11.5 step 3).
    const lastVerdict = needNew ? null : t0.lastVerdict
    let leadsText = null
    let leadsIgnored = false
    if (lastVerdict === 'UNVERIFIED') {
      if (given.length > 0) {
        const checked = validateLeadArgs(given)
        if (checked.problems.length > 0) { outcome = { invalidLeads: checked.problems }; return }
        leadsText = formatLeads(checked.leads)
      }
    } else if (given.length > 0) {
      leadsIgnored = true
    }
    if (needNew) openTask(s, { requestSeq: lastSeq > 0 ? lastSeq : null, openRoot: candidateRoot })
    const t = s.task
    // Step 0: reuse the task's Verifier context, or open a fresh one seeded with the prior reports.
    const v = t.verifier
    const idleMs = (Number(config.interactive?.verifierIdleHours) || 24) * 3600000
    const lastUsedMs = Date.parse(v.lastUsed ?? '')
    let reuse = typeof v.sessionId === 'string' && v.sessionId !== '' && v.retired !== true
      && (v.model ?? null) === (resolved.model ?? null)
      && Number.isFinite(lastUsedMs) && Date.now() - lastUsedMs <= idleMs
    // A context is resumed only when its transcript is exactly what its last job left (security-3):
    // an edited, replaced or planted history is not the Verifier's own. Unverifiable → fresh context.
    let retired = null
    if (reuse) {
      const stored = v.transcript
      const intact = Boolean(stored) && stored.sessionId === v.sessionId && Boolean(transcriptNow) && sameTranscript(stored, transcriptNow)
      if (!intact) {
        reuse = false
        retired = { sessionId: v.sessionId, ctxKey: v.ctxKey, reason: stored ? 'transcript_changed' : 'transcript_unverified', at: new Date().toISOString() }
      }
    }
    let verifierSessionId
    if (reuse) {
      verifierSessionId = v.sessionId
    } else {
      v.ctxIndex = (Number.isInteger(v.ctxIndex) ? v.ctxIndex : 0) + 1
      v.ctxKey = ctxKeyFor(t.seq, v.ctxIndex)
      v.sessionId = null
      v.retired = false
      v.lastUsed = null
      v.model = resolved.model
      v.modelSource = resolved.source
      verifierSessionId = uuid()
    }
    // Recorded before the job is spawned, so the guard hides the transcript from its first byte.
    noteVerifierSession(s, verifierSessionId, candidateRoot)
    t.candidateRoot = candidateRoot
    t.generation = (Number.isInteger(t.generation) ? t.generation : 0) + 1
    const createdAt = new Date().toISOString()
    const taskReports = (t.reports ?? []).map(r => ({ gen: r.gen, sha: r.reportSha }))
    // Reports a context on another Verifier model published are handed over as another Verifier's
    // (protocol-6: a fresh context must never be told they are its own).
    const handover = (t.reports ?? []).some(r => r && Object.hasOwn(r, 'verifierModel') && (r.verifierModel ?? null) !== (resolved.model ?? null))
      ? 'other-verifier'
      : 'self'
    const job = {
      v: 1,
      id: jobId,
      status: 'queued',
      sessionId: sid,
      projectKey: ctx.key,
      taskSeq: t.seq,
      generation: t.generation,
      candidateRoot,
      pluginRoot: pluginRootOf(env),
      pluginFingerprint,
      home: ctx.home,
      verifier: {
        ctxKey: v.ctxKey, sessionId: verifierSessionId, fresh: !reuse, model: resolved.model, modelSource: resolved.source,
        transcript: reuse ? v.transcript : null, retired, handover,
      },
      taskMessages: taskMessagesFor(requests, t.firstRequestSeq, config.interactive?.taskMessages ?? 3),
      leadsText,
      leadsIgnored,
      priorReportShas: reuse ? [] : taskReports.map(r => r.sha),
      taskReports,
      baselineFile: t.baselineFile ?? null,
      prevManifest: prevManifestFor(sl, t.seq, t.generation),
      config,
      isolationWant: config.isolation?.sandbox ?? 'auto',
      createdAt,
      startedAt: null,
      pid: null,
      heartbeatAt: null,
      checkpoint: null,
      result: null,
      infra: null,
      delivered: false,
    }
    await writeJsonAtomic(file, job)
    s.job = { id: jobId, pid: null, gen: t.generation, taskSeq: t.seq, startedAt: createdAt }
    outcome = { job, retired }
  }, { waitMs: 10000, sessionId: sid })

  if (outcome?.wait) return waitForJob(c, outcome.wait.id, { taskJobPid: outcome.wait.pid, notes })
  if (outcome?.refuse) return learningRefusal(outcome.refuse)
  if (outcome?.retired) {
    logger.warn('ROLE_CONTEXT_RETIRED', { jobId, sessionId: sid, ...outcome.retired, newSessionId: outcome.job.verifier.sessionId, newCtxKey: outcome.job.verifier.ctxKey })
  }
  if (outcome?.invalidLeads) {
    return text(`evidence_leads were not accepted: ${outcome.invalidLeads.join('; ')}. No verification was started; fix the leads and call submit again.`, true)
  }
  const job = outcome.job
  let pid = null
  try {
    const childEnv = { ...env }
    delete childEnv.CC_RSI_ROLE
    pid = spawnDetached(process.execPath, [VERIFY_JOB_PATH, 'run', file], { cwd: ctx.home, env: childEnv, logFile: file.replace(/\.json$/, '.log') })
  } catch (error) {
    // The job never ran: the server records the infra outcome itself.
    const infra = { cls: 'spawn', detail: `the verification job could not be started: ${error?.message ?? error}` }
    await writeJsonAtomic(file, { ...job, status: 'infra', infra, finishedAt: new Date().toISOString() })
    await withTask(sl, s => applyInfra(s, { jobId, taskSeq: job.taskSeq, cls: 'spawn' }), { waitMs: 10000, sessionId: sid })
    return deliver(c, await readJob(file), notes)
  }
  await withTask(sl, s => { if (s.job && s.job.id === jobId) s.job.pid = pid }, { waitMs: 10000, sessionId: sid }).catch(() => undefined)
  logger.info('verification job started', { jobId, pid, sessionId: sid, generation: job.generation, fresh: job.verifier.fresh })
  return waitForJob(c, jobId, { taskJobPid: pid, notes })
}

// ---------------------------------------------------------------- wait_verdict

async function waitVerdict(c) {
  const { ctx } = c
  const state = await readTask(ctx.sl, { sessionId: ctx.sid })
  if (state.job) return waitForJob(c, state.job.id, { taskJobPid: state.job.pid })
  const undelivered = await undeliveredJob(ctx.sl)
  if (undelivered) return deliver(c, undelivered)
  // A job still running whose task entry was lost.
  const jobs = await listJobs(ctx.sl)
  const running = [...jobs].reverse().find(job => job.status === 'running' || job.status === 'queued')
  if (running) return waitForJob(c, running.id)
  return text(`No verification is pending. Last verdict: ${lastVerdictLine(state)}.`)
}

// ---------------------------------------------------------------- learn

async function verdictIsCurrent(ctx, t, report) {
  if (!report || typeof report.statusDigest !== 'string') return true
  const opts = { home: ctx.home, storeDir: storeDirOf(ctx) }
  let current = await workspaceDigest(t.candidateRoot, opts)
  if (current === null) current = await workspaceDigest(t.candidateRoot, { ...opts, timeoutMs: 10000 })
  // A digest that cannot be computed now cannot show the verdict still covers the workspace (fail closed).
  return current !== null && current === report.statusDigest
}

async function markLearned(ctx, taskSeq, gen) {
  await withTask(ctx.sl, s => {
    const hit = taskBySeq(s, taskSeq)
    if (hit && hit.t.lastVerdictGen === gen) {
      hit.t.learned = true
      if (hit.which === 'task') hit.t.closed = true
    }
  }, { waitMs: 10000, sessionId: ctx.sid })
}

/** The current stage message of an open learning phase (re-issued when `learn` is called again). */
async function stageMessage(ctx, store, learning) {
  if (learning.stage === 'reconcile') return text(guidanceCommitResult('reconcile', { draftDir: learning.draftDir, confirmCode: learning.code }))
  const report = (learning.reportSha && (await store.getReport(learning.reportSha))) ?? '(the final report is in your history above)'
  return text(guidanceLearnStart({ outcome: learning.verdict, report, draftDir: learning.draftDir, limits: store.limits, confirmCode: learning.code }))
}

async function learn(c) {
  const { ctx, logger } = c
  const { sl, sid, pl } = ctx
  const flags = await storeFlags(ctx, logger)
  if (!flags.store) return text(guidanceInfra({ cls: 'store_unavailable', detail: 'the project memory store could not be opened', remedy: 'Ask the user to run cc-rsi doctor in a terminal.' }), true)
  const store = flags.store
  if (modeOf(ctx, flags.frozen) === 'frozen') return refusal('frozen')
  if (flags.sealed && flags.sealed.learningAfterSealed !== true) return refusal('sealed')
  if (flags.tamper) return refusal('tamper')
  const state = await readTask(sl, { sessionId: sid })
  if (state.job) return text(`A verification is running (job ${state.job.id}): call wait_verdict before learn.`, true)
  if (state.learning) return stageMessage(ctx, store, state.learning)
  const target = learnTarget(state)
  if (!target) {
    const t = state.task
    if (t && isTerminal(t.lastVerdict) && t.learned === true) return refusal('already_learned')
    if (t && t.lastVerdict === 'UNVERIFIED') return refusal('unverified_not_learnable')
    return refusal('no_terminal_verdict')
  }
  const { t } = target
  const report = lastReport(t)
  if (!(await verdictIsCurrent(ctx, t, report))) return refusal('stale_verdict')
  const episode = interactiveEpisode(sid, t.seq, t.lastVerdictGen)
  const origin = report?.jobId ? `job:${report.jobId}` : null
  if ((await store.findCommit(episode)) || (origin && (await store.findCommit(origin)))) {
    await markLearned(ctx, t.seq, t.lastVerdictGen)
    return refusal('already_learned')
  }
  if ((await store.isQuarantined(episode)) || (origin && (await store.isQuarantined(origin)))) {
    await markLearned(ctx, t.seq, t.lastVerdictGen)
    return refusal('quarantined')
  }
  let draft
  try {
    draft = await store.openDraft(episode, { dir: join(pl.drafts, safeName(episode)), owner: { kind: 'session', sessionId: sid } })
  } catch (error) {
    if (error?.code === 'memory_frozen') return refusal('frozen')
    if (error?.code === 'memory_sealed') return refusal('sealed')
    if (error?.code === 'memory_quarantined') return refusal('quarantined')
    throw error
  }
  const code = confirmCode()
  let conflict = null
  const learning = {
    episode, taskSeq: t.seq, gen: t.lastVerdictGen, verdict: t.lastVerdict, reportSha: report?.reportSha ?? null, jobId: report?.jobId ?? null,
    origin, stage: 'distill', code, draftDir: draft.dir, openedAt: new Date().toISOString(),
  }
  const next = await withTask(sl, s => {
    if (s.learning) { conflict = 'open'; return }
    if (s.job) { conflict = 'job'; return }
    const hit = taskBySeq(s, t.seq)
    if (!hit || hit.t.lastVerdictGen !== t.lastVerdictGen || hit.t.learned === true || !isTerminal(hit.t.lastVerdict)) { conflict = 'changed'; return }
    s.learning = learning
  }, { waitMs: 10000, sessionId: sid })
  if (conflict === 'open') return stageMessage(ctx, store, next.learning)
  if (conflict) {
    await store.discardDraft(episode).catch(() => undefined)
    return text('The task state changed while the learning phase was opening; call learn again.', true)
  }
  const reportText = (learning.reportSha && (await store.getReport(learning.reportSha))) ?? '(the final report is in your history above)'
  return text(guidanceLearnStart({ outcome: learning.verdict, report: reportText, draftDir: draft.dir, limits: store.limits, confirmCode: code }))
}

// ---------------------------------------------------------------- memory_commit

/** Ends the learning phase: `learning = null`, the target task learned (closed when it is `task`). */
async function finishLearning(ctx, learning) {
  await withTask(ctx.sl, s => {
    if (s.learning && s.learning.episode === learning.episode) s.learning = null
    const hit = taskBySeq(s, learning.taskSeq)
    if (hit && hit.t.lastVerdictGen === learning.gen) {
      hit.t.learned = true
      if (hit.which === 'task') hit.t.closed = true
    }
  }, { waitMs: 10000, sessionId: ctx.sid })
}

/** Issues a new confirm code for the same stage (limit, conflict). Returns the code, or null when the phase changed. */
async function rotateCode(ctx, learning, patch = {}) {
  const code = confirmCode()
  const next = await withTask(ctx.sl, s => {
    if (s.learning && s.learning.episode === learning.episode && s.learning.code === learning.code) Object.assign(s.learning, patch, { code })
  }, { waitMs: 10000, sessionId: ctx.sid })
  return next.learning?.code === code ? code : null
}

async function refreshSessionView(ctx, store, logger) {
  try {
    await refreshView({ store, viewDir: ctx.sl.viewDir, viewJson: ctx.sl.viewJson })
  } catch (error) {
    logger.warn('memory view refresh failed', { error: error?.message })
  }
}

async function memoryCommit(c, args) {
  const { ctx, logger } = c
  const state = await readTask(ctx.sl, { sessionId: ctx.sid })
  const learning = state.learning
  if (!learning) return refusal('no_learning')
  const abandon = args.abandon === true
  if (!abandon) {
    if (typeof args.confirm !== 'string') return text(`memory_commit needs confirm (the confirmation code of the latest stage message) or abandon:true. ${LEARN_HINT}`, true)
    if (args.confirm !== learning.code) return learningRefusal('bad_confirm')
  }
  const flags = await storeFlags(ctx, logger)
  if (!flags.store) return text(guidanceInfra({ cls: 'store_unavailable', detail: 'the project memory store could not be opened', remedy: 'Call memory_commit again later; the draft is kept.' }), true)
  const store = flags.store
  if (abandon) {
    await store.discardDraft(learning.episode)
    await finishLearning(ctx, learning)
    return text(guidanceCommitResult('abandoned'))
  }
  if (learning.stage === 'distill') {
    const code = await rotateCode(ctx, learning, { stage: 'reconcile' })
    if (code === null) return learningRefusal('bad_confirm')
    return text(guidanceCommitResult('reconcile', { draftDir: learning.draftDir, confirmCode: code }))
  }
  // Stage reconcile → promote through the store (the only way memory changes).
  if (modeOf(ctx, flags.frozen) === 'frozen') return text(guidanceCommitResult('frozen'), true)
  if (flags.sealed && flags.sealed.learningAfterSealed !== true) return refusal('sealed')
  if (flags.tamper) return refusal('tamper')
  if ((await store.findCommit(learning.episode)) || (learning.origin && (await store.findCommit(learning.origin)))) {
    await store.discardDraft(learning.episode).catch(() => undefined)
    await finishLearning(ctx, learning)
    return text(guidanceCommitResult('already'))
  }
  try {
    const record = await store.commit(learning.episode, { kind: 'task', outcome: learning.verdict, origin: learning.origin ?? null })
    await finishLearning(ctx, learning)
    await refreshSessionView(ctx, store, logger)
    if (record.episode !== learning.episode) return text(guidanceCommitResult('already'))
    return text(guidanceCommitResult('promoted', record))
  } catch (error) {
    switch (error?.code) {
      case 'memory_limit': {
        const code = await rotateCode(ctx, learning)
        if (code === null) return learningRefusal('bad_confirm')
        return text(guidanceCommitResult('limit', { detail: error.detail ?? error.message, draftDir: learning.draftDir, confirmCode: code, limits: store.limits }))
      }
      case 'memory_conflict': {
        const { prevDir, draft } = await store.rebaseDraft(learning.episode)
        const code = await rotateCode(ctx, learning, { draftDir: draft.dir })
        if (code === null) return learningRefusal('bad_confirm')
        return text(guidanceCommitResult('conflict', { prevDir, draftDir: draft.dir, confirmCode: code }))
      }
      case 'memory_quarantined':
        await finishLearning(ctx, learning)
        return text(guidanceCommitResult('quarantined'))
      case 'memory_frozen':
        return text(guidanceCommitResult('frozen'), true)
      case 'memory_sealed':
        return refusal('sealed')
      case 'memory_tamper':
        return refusal('tamper')
      case 'memory_draft_missing':
        await withTask(ctx.sl, s => { if (s.learning && s.learning.episode === learning.episode) s.learning = null }, { waitMs: 10000, sessionId: ctx.sid })
        return text('The learning draft no longer exists, so nothing was promoted. Call learn to redo the learning phase against the current memory.', true)
      case 'unsafe_memory_path':
        return text(`The draft cannot be promoted: ${error.message}. Remove that entry from ${learning.draftDir}, then call memory_commit again with confirm ${learning.code}.`, true)
      default:
        throw error
    }
  }
}

// ---------------------------------------------------------------- status

function kib(bytes) {
  const n = Number(bytes) || 0
  if (n === 0) return '0'
  return `${Math.max(0.1, Math.round((n / 1024) * 10) / 10)}`
}

/**
 * Lock-free memory integrity for read-only callers (memory-crash-10): reads the tree, then the
 * pending-install marker, then the journal (an install journals before it removes its marker, so
 * this order never sees a finished install as tamper); a tree equal to the pending install's
 * `treeAfter` is intact; a mismatch is read again once after 100 ms before it is reported. Uses the
 * store's own `integrity()` when it has one. Returns `{ expected, actual, intact }`.
 */
export async function memoryIntegrity(store, { retryMs = 100 } = {}) {
  if (typeof store?.integrity === 'function') {
    const shared = await store.integrity()
    if (shared && typeof shared.intact === 'boolean') return shared
  }
  for (let attempt = 0; ; attempt++) {
    const actual = await store.treeHash().catch(() => 'invalid')
    const pending = await readJsonSafe(join(store.root, 'commit.pending.json'), null)
    const expected = await store.expectedTreeHash()
    const intact = actual === expected || (typeof pending?.record?.treeAfter === 'string' && pending.record.treeAfter === actual)
    if (intact || attempt >= 1) return { expected, actual, intact }
    await sleep(retryMs)
  }
}

/** The status text (SPEC §11.12). Read-only: it never opens a draft or writes task state. */
export async function statusText({ ctx, env = process.env }) {
  const { sl, pl, config, sid, key, home } = ctx
  const lines = [`cc-rsi status — session ${String(sid).slice(0, 8)}, project ${key}`]
  const store = await peekStore(config, pl, { lockWaitMs: 2000 })
  let inv = null
  let integrity = 'intact'
  let frozen = null
  let sealed = null
  try {
    inv = await store.inventory()
    if (!(await memoryIntegrity(store)).intact) integrity = 'CHANGED OUTSIDE A COMMIT'
    frozen = await store.frozen()
    sealed = await store.sealed()
  } catch {
    integrity = 'unreadable'
  }
  const mode = frozen || config.mode === 'frozen' ? 'frozen' : 'learn'
  const memory = inv ? `${inv.files.length} files, ${kib(inv.totalBytes)} KiB, tree ${String(inv.treeSha256).slice(0, 12)} (${integrity})` : `unavailable (${integrity})`
  lines.push(`mode: ${mode} | memory: ${memory} | frozen: ${frozen ? 'yes' : 'no'} | sealed: ${sealed ? (sealed.learningAfterSealed ? 'yes (learning reopened)' : 'yes') : 'no'}`)
  const state = await readTask(sl, { sessionId: sid })
  const t = state.task
  if (!t) {
    lines.push('task: none')
  } else {
    let verdict = 'none'
    if (t.lastVerdict) {
      const report = lastReport(t)
      let currency
      if (!report || report.statusDigest == null) {
        currency = 'n/a: not a git project'
      } else {
        const current = await workspaceDigest(t.candidateRoot, { home, storeDir: storeDirOf(ctx) })
        currency = current === null ? 'unknown: the workspace digest could not be computed' : current === report.statusDigest ? 'current' : 'stale: workspace changed since inspection'
      }
      verdict = `${t.lastVerdict} (${currency})${t.learned ? ', learned' : ''}`
    }
    lines.push(`task ${t.seq}: generation ${t.generation ?? 0}; last verdict ${verdict}`)
  }
  if (state.job) {
    const job = await readJob(jobPath(sl, state.job.id))
    const started = Date.parse(job?.startedAt ?? job?.createdAt ?? state.job.startedAt ?? '')
    const secs = Number.isFinite(started) ? Math.round((Date.now() - started) / 1000) : 0
    lines.push(`verification: running (job ${state.job.id}, ${secs} s)`)
  } else {
    lines.push('verification: none')
  }
  lines.push(state.learning ? `learning: open (stage ${state.learning.stage})` : 'learning: none')
  const probe = effectiveProbe(await readProbe(home), staticProbe({ env }))
  const decision = decideIsolation({ want: config.isolation?.sandbox ?? 'auto', probe })
  const isolationMode = decision.refuse ? 'refused' : decision.sandbox ? 'sandbox' : 'rollback'
  const model = resolveVerifierModel(config, ctx.session, env)
  lines.push(`isolation: Verifier ${isolationMode} (${decision.reason}) | Verifier model: ${model.model ?? 'inherit (Claude Code default)'} (${model.source})`)
  const lineages = lineageStates(pl)
  lines.push(`lineages: ${lineages.length === 0 ? 'none' : lineages.map(l => `${l.id} ${l.phase} ${l.status}${lineageCounters(l) ? ` ${lineageCounters(l)}` : ''}`).join(', ')}`)
  const runs = Array.isArray(sealed?.runs) ? sealed.runs.length : 0
  lines.push(`sealed evaluations: ${runs} recorded (scores are shown only in a terminal: cc-rsi eval show)`)
  const root = t?.candidateRoot ?? ctx.projectRoot
  const lock = lockCovering(listLocksSync(globalLayout(home).locks), root)
  if (lock && lock.restoreFailed) {
    lines.push(`WARNING: a verification failed to restore ${lock.root}; inspect ${join(sl.displaced, lock.jobId ?? '')} and run "cc-rsi doctor --release-lock ${lock.root}" in a terminal.`)
  }
  return lines.join('\n')
}

async function status(c) {
  const { ctx, env } = c
  const state = await readTask(ctx.sl, { sessionId: ctx.sid })
  // Status also triggers recovery of a dead job (SPEC §11.5 "Recovery").
  for (const job of await listJobs(ctx.sl)) {
    const pid = state.job && state.job.id === job.id ? state.job.pid : null
    if (jobIsDead(job, { pid })) spawnRecovery(jobPath(ctx.sl, job.id), { env })
  }
  // ...and of any session's job that died with its checkpoint open: its workspace lock names it
  // (memory-crash-2, portability-2), and its own session may never be resumed.
  try {
    recoverPendingLocks(globalLayout(ctx.home).locks, { env })
  } catch { /* best effort */ }
  return text(await statusText({ ctx, env }))
}

// ---------------------------------------------------------------- dispatch

const HANDLERS = { submit, wait_verdict: waitVerdict, learn, memory_commit: memoryCommit, status }

/**
 * Calls one tool (SPEC §11.11). `meta` = the request `_meta` (carries "claudecode/toolUseId" and
 * progressToken); `progress(progress, total, message)` sends notifications/progress; `signal` aborts
 * a wait (the job continues). `receivedAt` (ms) is when tools/call arrived: the wait budget counts
 * from it (cc-integration-8). Additive option: `waitMs` overrides the wait budget (tests).
 * Returns `{ content: [{type:'text', text}], isError? }`; never throws for a refusal.
 */
export async function callTool(name, args, { meta = {}, env = process.env, signal, progress, waitMs, receivedAt = Date.now() } = {}) {
  const tool = TOOLS.find(t => t.name === name)
  if (!tool) return text(`Unknown tool: ${name}. The cc-rsi tools are ${TOOLS.map(t => t.name).join(', ')}.`, true)
  if (env.CC_RSI_ROLE) return refusal('role')
  const problem = validateArgs(tool.inputSchema, args)
  if (problem) return text(`Invalid arguments for ${name}: ${problem}.`, true)
  const home = ccRsiHome(env)
  const logger = createLogger(globalLayout(home).mcpLog, 'mcp-tools')
  const toolUseId = meta?.['claudecode/toolUseId']
  const att = await takeAttestation(globalLayout(home).att, toolUseId, { waitMs: 2000, signal })
  const attested = att !== null && typeof att.session_id === 'string' && att.session_id !== ''
    && (typeof att.tool_name !== 'string' || att.tool_name.endsWith(`__${name}`))
  let ctx
  if (STATE_CHANGING.has(name)) {
    if (!attested) return refusal('not_attested')
    if (typeof att.agent_id === 'string' && att.agent_id !== '') return refusal('subagent')
    ctx = await sessionContext({ payload: att, env, optPrefix: MCP_OPT_PREFIX })
  } else if (attested) {
    ctx = await sessionContext({ payload: att, env, optPrefix: MCP_OPT_PREFIX })
  } else {
    const session = await readSessionByEnv(env)
    if (!session) {
      return text('cc-rsi status — no session state was found for this session (the cc-rsi hooks may be inactive: ask the user to run cc-rsi doctor in a terminal).')
    }
    ctx = await sessionContext({ payload: { session_id: session._ctx.sid, cwd: session.projectDir ?? session.cwd }, env: { ...env, CLAUDE_PROJECT_DIR: session.projectDir ?? env.CLAUDE_PROJECT_DIR }, optPrefix: MCP_OPT_PREFIX, create: false })
  }
  if (ctx.config?.interactive?.enabled === false) {
    return text('cc-rsi interactive mode is disabled for this project (interactive.enabled is false in the cc-rsi configuration); ask the user to run cc-rsi status in a terminal.', true)
  }
  const c = { ctx, env, signal, progress, waitMs, logger, att, receivedAt }
  try {
    return await HANDLERS[name](c, args ?? {})
  } catch (error) {
    logger.error('tool failed', { tool: name, error })
    const detail = String(error?.message ?? error)
    if (error?.code === 'lock_timeout') return text(`cc-rsi is busy (${detail}); call ${name} again.`, true)
    return text(`cc-rsi ${name} failed: ${detail}`, true)
  }
}

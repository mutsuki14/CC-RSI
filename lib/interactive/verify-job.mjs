// The detached verification job (SPEC §11.5; D1; PR §4.5).
//
//   node lib/interactive/verify-job.mjs run <jobFile>       one inspection of the candidate
//   node lib/interactive/verify-job.mjs recover <jobFile>   restore + infra after the job died
//
// The `submit` MCP tool writes the job file (status `queued`) and spawns this program detached.
// The job owns the verdict (SPEC §2 boundary 2): it locks the candidate root project-wide, takes a
// checkpoint, builds the Verifier charter from harness material only (the user's verbatim
// messages, mechanical change facts, the Verifier's own prior reports, formatted LEAD blocks —
// never the Actor's reasoning or memory), converses with the persistent Verifier context
// (`--session-id` first, `--resume` after: one Verifier per task across FAIL → repair → resubmit),
// parses the verdict from the Verifier's final assistant message, ALWAYS restores the candidate
// (moving displaced versions aside, never deleting), and records the result. Infrastructure is a
// separate outcome class: it never becomes PASS/FAIL, never enables learning and never commits
// memory (SPEC §2 boundary 3).
//
// Ports: dsh-rsi src/index.ts:560-680 (rsi_submit: checkpoint → inspect → restore → report →
// guidance) moved out of the tool call into a process that outlives the MCP request; RSIAgent
// verifier continuity (explore/charter.py:986-997) through the persistent role context.

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonSafe, writeJsonAtomic } from '../core/atomic.mjs'
import { CcRsiError, RoleContextError } from '../core/errors.mjs'
import { pad3, uuid } from '../core/ids.mjs'
import { appendJsonl, readJsonl } from '../core/jsonl.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { machineId, sameMachine } from '../core/machine.mjs'
import { createLogger } from '../core/log.mjs'
import { globalLayout, isUnderLexical, projectLayout, safeName, sessionLayout } from '../core/paths.mjs'
import { killGracefully, pidAlive } from '../core/proc.mjs'
import { MUTATION_BASH_DENY } from '../guard/bash.mjs'
import { interactiveTask, truncatedContinuation, verifierCharter, verifierContinuation, verifierSystem } from '../prompts/roles.mjs'
import { parseVerdict } from '../protocol/tokens.mjs'
import { RoleContext } from '../runtime/context.mjs'
import { converse } from '../runtime/converse.mjs'
import { InfraError, InterruptedError } from '../runtime/errors.mjs'
import { harnessPrivateRoots, ownSessionDirs, roleTmpDir, withoutOwn } from '../runtime/private.mjs'
import { decideIsolation, effectiveProbe, readProbe, staticProbe } from '../runtime/sandbox.mjs'
import { baselineDelta } from '../workspace/baseline.mjs'
import { Checkpoint } from '../workspace/checkpoint.mjs'
import { contentDelta, describeDelta } from '../workspace/fingerprint.mjs'
import { workspaceFacts } from '../workspace/git.mjs'
import { lastRequestSeq } from './requests.mjs'
import { CODE_ROOT, harnessExcludes, openStore, pluginCodeFingerprint, workspaceDigest } from './session.mjs'
import {
  applyInfra, applyVerdict, jobIsDead, noteVerifierSession, processStartToken, readJob, sameTranscript, transcriptFingerprint, withTask,
  NOT_CURRENT_PREFIX,
} from './task.mjs'
import { acquireWorkspaceLock, markRestoreFailed, releaseWorkspaceLock, releaseWorkspaceLockFor, takeOverWorkspaceLock } from './wslock.mjs'

export { jobIsDead }

const HEARTBEAT_MS = 5000
const TASK_LOCK_WAIT_MS = 30000
const DIED_DETAIL = 'verification did not complete; the candidate was restored; this is not a verdict'
const CANCELLED_DETAIL = 'the verification was cancelled; the candidate was restored; this is not a verdict'
const MAX_LISTED = 20

export { NOT_CURRENT_PREFIX }

/**
 * Hidden traversal tokens of an interactive Verifier (SPEC §4.3: Verifier + all-role tokens), plus
 * the Actor's reasoning artifacts outside the transcripts (security-9): plans, task lists,
 * file-history, prompt history and the session temp dirs (`/tmp/claude-<uid>/<slug>/<sid>/`).
 */
export const VERIFIER_HIDDEN_TOKENS = Object.freeze([
  'actor-private', 'curriculum-private', '/.cc-rsi/projects', '/.cc-rsi/run', '.claude/projects', '.claude/.credentials',
  '.claude/plans', '.claude/todos', '.claude/tasks', '.claude/file-history', '.claude/history.jsonl', '/tmp/claude-',
])

function spellingsOf(paths) {
  return paths.filter(Boolean).flatMap(p => {
    const out = [resolve(p)]
    try { out.push(realpathSync(p)) } catch { /* not created yet */ }
    return out
  })
}

/** The hidden tokens of a Verifier whose own cwd/scratch do not contain them (a token in its own path would block it). */
export function verifierHiddenTokens({ cwd, scratch } = {}) {
  const own = spellingsOf([cwd, scratch]).map(p => `${p}/`)
  return VERIFIER_HIDDEN_TOKENS.filter(token => !own.some(p => p.includes(token)))
}

/** Tools of every Verifier (SPEC §10.6 table). */
const VERIFIER_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Bash'])
const VERIFIER_DENY = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill'])

const nowIso = () => new Date().toISOString()

/** Serialized writer of the job's own file. After `close()` nothing is written any more. */
class JobFile {
  #path
  #chain = Promise.resolve()
  #closed = false

  constructor(path, job) {
    this.#path = path
    this.job = job
  }

  update(patch) {
    if (this.#closed) return this.#chain
    Object.assign(this.job, patch)
    const snapshot = JSON.parse(JSON.stringify(this.job))
    this.#chain = this.#chain.then(() => writeJsonAtomic(this.#path, snapshot)).catch(() => undefined)
    return this.#chain
  }

  /** The last write: `patch` and then no further writes (the server may add `delivered`). */
  async finish(patch) {
    const done = this.update(patch)
    this.#closed = true
    await done
  }
}

/** Layouts of a job (the job file carries everything; nothing is re-derived from the environment). */
function layoutsOf(job) {
  const home = resolve(job.home)
  const storeDir = typeof job.config?.memory?.dir === 'string' && job.config.memory.dir !== '' ? job.config.memory.dir : undefined
  const pl = projectLayout(home, job.projectKey, { storeDir })
  const sl = sessionLayout(pl, job.sessionId)
  return { home, g: globalLayout(home), pl, sl, storeDir }
}

/**
 * Hidden roots of the interactive Verifier (SPEC §4.3 "all roles" row, Verifier variant): harness
 * state under `<home>` (projects, run, bin, config, logs, lineage work trees, every other Verifier's
 * scratch), Claude Code transcripts and credentials, the Actor's other reasoning artifacts (plans,
 * task lists, file history, prompt history, `<tmp>/claude-<uid>` session dirs; security-9), and an
 * external memory store. A root that would contain the Verifier's own cwd or scratch is dropped (a
 * deny rule would block the role). In sandbox mode the roots are also the sandbox's denyRead.
 */
export function verifierHidden({ home, scratch, cwd, storeDir, env = process.env }) {
  // The roots every role hides (lib/runtime/private.mjs: harness state, Claude Code transcripts,
  // credentials and the Actor's other reasoning artifacts, the user's session temp dirs, an
  // external store), plus every lineage work tree and every other Verifier's scratch.
  const list = [...harnessPrivateRoots({ home, env, storeDir }), join(home, 'work')]
  const vscratch = join(home, 'vscratch')
  try {
    for (const name of readdirSync(vscratch)) {
      const other = join(vscratch, name)
      if (resolve(other) !== resolve(scratch)) list.push(other)
    }
  } catch {
    // no other scratch dirs
  }
  return withoutOwn(list, spellingsOf([cwd, scratch]))
}

/** The running plugin code roots (both spellings): never writable by a Verifier (security-4). */
function codeRoots(job) {
  return spellingsOf([CODE_ROOT, typeof job.pluginRoot === 'string' && job.pluginRoot !== '' ? job.pluginRoot : null])
}

/**
 * The interactive Verifier RoleSpec (SPEC §11.5 step 7, §10.6 table "Verifier (interactive / target,
 * live)"): cwd = the live candidate root, read-only; scratch `<home>/vscratch/<sessionId>` as its
 * only writable dir; lossless; no liveness hook; the mutation deny patterns when not sandboxed.
 */
export function verifierSpec({ job, home, sl, storeDir, scratch, sandbox, checkpoint = 'listed', env = process.env }) {
  const config = job.config ?? {}
  const cwd = job.candidateRoot
  const allowUnverified = config.interactive?.allowUnverified !== false
  const transport = config.transport ?? {}
  const network = Array.isArray(config.isolation?.verifierNetwork) ? config.isolation.verifierNetwork : []
  const bashDeny = !sandbox && config.isolation?.verifierBashDeny !== false ? MUTATION_BASH_DENY : []
  const maxBudget = Number(transport.maxBudgetUsdPerMessage)
  // The candidate and the running plugin code are read-only (security-4: every later verdict runs
  // that code from disk); a code root that would contain the scratch is left out.
  const readOnly = [cwd, ...withoutOwn(codeRoots(job), [scratch]).filter(r => !isUnderLexical(r, cwd))]
  return {
    key: job.verifier.ctxKey,
    role: 'verifier',
    phase: null,
    cwd,
    addDirs: [scratch],
    scratch,
    tools: [...VERIFIER_TOOLS],
    allow: [...VERIFIER_TOOLS],
    deny: [...VERIFIER_DENY],
    readRoots: [],
    writeRoots: [],
    readOnlyRoots: readOnly,
    hidden: verifierHidden({ home, scratch, cwd, storeDir, env }),
    hiddenTokens: verifierHiddenTokens({ cwd, scratch }),
    bashDeny,
    sandbox: sandbox ? { allowWrite: [scratch], denyWrite: readOnly, denyRead: [], network } : null,
    sandboxDegrade: 'allow',
    // The rollback paragraph names what the checkpoint actually restores (prompts-1): 'listed'
    // (git-listed files) or 'detect' (a detect-only checkpoint restores nothing).
    systemText: verifierSystem({ location: 'live', sandbox: sandbox === true, allowUnverified, checkpoint }),
    model: typeof job.verifier.model === 'string' && job.verifier.model !== '' ? job.verifier.model : null,
    effort: typeof config.effort?.verifier === 'string' && config.effort.verifier !== '' ? config.effort.verifier : null,
    lossless: true,
    pinText: null,
    liveness: false,
    stagnationRevisit: null,
    maxTurns: transport.maxTurns?.verifier ?? 2000,
    turnTimeoutSec: transport.turnTimeoutSec?.interactiveVerifier ?? 7200,
    pauseCeilingSecs: transport.pauseCeilingSecs?.interactive ?? 1800,
    watchdogMaxWaitMs: transport.watchdogMaxWaitMs?.interactive ?? 1800000,
    maxBudgetUsd: Number.isFinite(maxBudget) && maxBudget > 0 ? maxBudget : null,
    noSessionPersistence: false,
    extraEnv: { VERIFIER_SCRATCH: scratch, TMPDIR: roleTmpDir(scratch) },
    // Its own Claude Code session dir (persisted large tool results) stays readable (r2-interactive-5).
    ownPaths: ownSessionDirs({ cwd, sessionId: job.verifier.sessionId, env }),
    logDir: join(sl.ctx, safeName(job.verifier.ctxKey)),
    home,
    pluginRoot: CODE_ROOT,
    config,
  }
}

/** `{generation, text}` prior reports from the store (missing or altered → '(report unavailable)'). */
async function priorReportTexts(store, entries) {
  const out = []
  for (const entry of entries ?? []) {
    const sha = typeof entry === 'string' ? entry : entry?.sha
    const gen = typeof entry === 'object' && Number.isInteger(entry?.gen) ? entry.gen : undefined
    const text = store ? await store.getReport(sha) : undefined
    out.push(gen === undefined ? (text ?? '(report unavailable)') : { generation: gen, text: text ?? '(report unavailable)' })
  }
  return out
}

const listed = paths => `${paths.slice(0, MAX_LISTED).join(', ')}${paths.length > MAX_LISTED ? ', …' : ''}`

/**
 * An infra detail that tells the truth about the restore (memory-crash-7): "the candidate was
 * restored" is kept only when the restore restored everything; paths a detect-only checkpoint could
 * not roll back, and paths changed again by something outside the inspection, are named.
 */
export function restoreDetail(detail, { notRestored = [], unstable = [] } = {}) {
  if (notRestored.length === 0 && unstable.length === 0) return detail
  let out = String(detail ?? '').replace(/; the candidate was restored/g, '')
  if (notRestored.length > 0) {
    out += `; the workspace was too large to checkpoint, so ${notRestored.length} path(s) changed during the inspection were NOT rolled back: ${listed(notRestored)}`
  }
  if (unstable.length > 0) {
    out += `; ${unstable.length} path(s) were changed again by something outside the inspection after the restore: ${listed(unstable)}`
  }
  return out
}

/** Every path a restore found changed (restored, moved aside, skipped by detect-only, unstable). */
function changedPaths(info) {
  if (!info) return []
  const strip = p => (String(p).endsWith('/') ? String(p).slice(0, -1) : String(p))
  return [...new Set([...(info.restored ?? []), ...(info.displaced ?? []), ...(info.skipped ?? []), ...(info.unstable ?? [])].map(strip))].sort()
}

/** The infra outcome of an error thrown during the inspection. */
function infraOf(error, abortedByUs) {
  if (error instanceof InterruptedError || abortedByUs) return { cls: 'cancelled', detail: CANCELLED_DETAIL }
  if (error instanceof InfraError) {
    return { cls: error.cls, detail: error.detail || error.message, established: error.extra?.established === true }
  }
  if (error instanceof CcRsiError) return { cls: error.code || 'error', detail: error.message }
  return { cls: 'error', detail: String(error?.message ?? error) }
}

/**
 * Runs one verification job (SPEC §11.5 job side, steps 1–11). Never throws for an inspection
 * outcome: the job file ends `done` (with `result`) or `infra` (with `infra`). Returns the job.
 * A job file that is not `queued` is returned untouched (a job runs once).
 */
export async function runJob(jobFile, { signal, env = process.env } = {}) {
  // Recursion closure (J2-4): a role child never starts a Verifier.
  if (env.CC_RSI_ROLE) throw new RoleContextError()
  const loaded = await readJob(jobFile)
  if (!loaded) throw new CcRsiError('job_missing', `no verification job at ${jobFile}`, { jobFile })
  if (loaded.status !== 'queued') return loaded
  const job = loaded
  const { home, g, pl, sl, storeDir } = layoutsOf(job)
  const logger = createLogger(g.jobsLog, 'verify-job')
  const writer = new JobFile(jobFile, job)
  const config = job.config ?? {}
  const allowUnverified = config.interactive?.allowUnverified !== false
  const root = job.candidateRoot
  const abort = new AbortController()
  let abortedByUs = false
  const onAbort = () => {
    abortedByUs = true
    abort.abort()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  await writer.update({ status: 'running', pid: process.pid, pidStart: processStartToken(process.pid), host: hostname(), machine: machineId(), startedAt: nowIso(), heartbeatAt: nowIso() })
  const heartbeat = setInterval(() => { writer.update({ heartbeatAt: nowIso() }) }, HEARTBEAT_MS)
  heartbeat.unref?.()
  logger.info('job started', { jobId: job.id, sessionId: job.sessionId, generation: job.generation, root })

  let lock = null
  let checkpoint = null
  let candidateDigest = null
  let infra = null
  let verdict = null
  let restoreInfo = null
  let restoreFailed = false
  const isolation = { mode: null, reason: null }
  const stats = { invocations: 0, costUsd: 0, guardGaps: 0, model: null, verifierSessionId: job.verifier?.sessionId ?? null, contextUsed: false, retired: null }
  let sd = null
  // Set when the workspace lock was taken over during the inspection (memory-crash-9): the
  // inspection is aborted and never yields a verdict.
  let lockLost = false
  const onLockLost = () => {
    lockLost = true
    abort.abort()
  }
  try {
    // 1b. The plugin code must be the code the session started with (security-4): this job, the
    // hooks and the role guard run from disk, so changed code never judges.
    if (typeof job.pluginFingerprint === 'string' && job.pluginFingerprint !== '' && pluginCodeFingerprint(CODE_ROOT) !== job.pluginFingerprint) {
      infra = {
        cls: 'plugin_changed',
        detail: 'the cc-rsi plugin code changed after this session started; no verification ran (restart Claude Code: a new session, or --resume / --continue of this one)',
      }
    }
    // 2. Workspace lock: one inspection per root, across every session.
    if (!infra) {
      try {
        lock = await acquireWorkspaceLock(g.locks, root, { jobId: job.id, sessionId: job.sessionId, jobFile, env, onLost: onLockLost })
      } catch (error) {
        infra = error?.code === 'workspace_busy' ? { cls: 'workspace_busy', detail: error.message } : infraOf(error, false)
      }
    }
    // 3. statusDigest before the checkpoint (verdict staleness, SPEC §11.3).
    if (!infra) sd = await workspaceDigest(root, { home, storeDir })
    // 4. Checkpoint: a failure ends the job before any Verifier runs. The lock record says a
    // checkpoint is open BEFORE it is taken, so a job dying from here on keeps the root locked
    // until its recovery restored the checkpoint (memory-crash-2).
    const exclude = harnessExcludes(root, [home, storeDir])
    const checkpointDir = join(sl.checkpoints, job.id)
    if (!infra) {
      try {
        await lock.updateOwner({ checkpointOpen: true, checkpointDir })
      } catch (error) {
        // Taken over: stop its heartbeat; the compare-token release leaves the new holder's record alone.
        await releaseWorkspaceLock(lock).catch(() => undefined)
        lock = null
        infra = { cls: 'workspace_busy', detail: `the workspace lock was lost before the checkpoint: ${error?.message ?? error}` }
      }
    }
    if (!infra) {
      try {
        checkpoint = await Checkpoint.take(root, {
          dir: checkpointDir,
          exclude,
          maxBytes: config.interactive?.checkpointMaxBytes ?? 268435456,
          maxFiles: config.interactive?.checkpointMaxFiles ?? 20000,
        })
        candidateDigest = checkpoint.fingerprint()
        await writer.update({ checkpoint: { dir: checkpoint.dir, open: true, detectOnly: checkpoint.detectOnly } })
      } catch (error) {
        checkpoint = null
        await Checkpoint.discard(checkpointDir).catch(() => undefined)
        await lock.updateOwner({ checkpointOpen: false }).catch(() => undefined)
        infra = { cls: 'checkpoint_failed', detail: `the candidate could not be checkpointed: ${error?.message ?? error}` }
      }
    }
    if (!infra && abort.signal.aborted) infra = { cls: 'cancelled', detail: CANCELLED_DETAIL }
    let store = null
    if (!infra) {
      try {
        store = await openStore(config, pl, { lockWaitMs: 60000, logger })
      } catch (error) {
        infra = { cls: 'store_unavailable', detail: `the memory store could not be opened: ${error?.message ?? error}` }
      }
    }
    if (!infra) {
      // 5. Mechanical context, in order: change facts, S0 baseline delta, changes since the last inspection.
      const manifest = checkpoint.manifest()
      let mechanical = (await workspaceFacts(root, { exclude })).text
      if (typeof job.baselineFile === 'string' && job.baselineFile !== '') {
        const baseline = await readJsonSafe(job.baselineFile, null)
        if (baseline && baseline.complete === true) {
          const delta = await baselineDelta(baseline, root, { exclude }).catch(() => '')
          if (delta) mechanical += `\n\n${delta}`
        }
      }
      let changedDelta = null
      if (typeof job.prevManifest === 'string' && job.prevManifest !== '') {
        const prev = await readJsonSafe(job.prevManifest, null)
        if (prev && typeof prev === 'object') changedDelta = contentDelta(prev, manifest)
      }
      await writeJsonAtomic(join(sl.manifests, `t${pad3(job.taskSeq)}-g${pad3(job.generation)}.json`), manifest)
      // 6. Isolation from the actual probe; the mechanics paragraph names the real mode (SPEC §10.11).
      const probe = effectiveProbe(await readProbe(home), staticProbe({ env }))
      const decision = decideIsolation({ want: job.isolationWant ?? config.isolation?.sandbox ?? 'auto', probe })
      isolation.mode = decision.sandbox ? 'sandbox' : 'rollback'
      isolation.reason = decision.reason
      if (decision.refuse) {
        isolation.mode = 'refused'
        infra = { cls: 'sandbox_required', detail: decision.reason }
      }
      if (!infra) {
        // 7–8. The Verifier context and the conversation.
        const onContext = id => writer.update({ contextSessionId: id })
        const coverage = checkpoint.detectOnly ? 'detect' : 'listed'
        const result = await inspect({ job, home, sl, storeDir, store, env, logger, abort, stats, isolation, decision, mechanical, changedDelta, allowUnverified, onContext, coverage })
        verdict = result
      }
    }
  } catch (error) {
    infra = infraOf(error, abortedByUs)
    logger.warn('inspection ended without a verdict', { jobId: job.id, cls: infra.cls, detail: infra.detail })
  } finally {
    if (lockLost) {
      // Another process holds the root now: whatever the inspection produced is not a verdict.
      verdict = null
      infra = { cls: 'workspace_busy', detail: 'the workspace lock was taken over during the inspection (this job was stopped longer than its lease); no verdict was recorded' }
      lock = null
    }
    // 9. Restore, always (also after infra).
    if (checkpoint) {
      try {
        restoreInfo = await checkpoint.restore({ displacedDir: join(sl.displaced, job.id) })
        if (restoreInfo.failed.length > 0) restoreFailed = true
      } catch (error) {
        restoreFailed = true
        restoreInfo = { restored: [], displaced: [], failed: [{ path: '.', error: String(error?.message ?? error) }], skipped: [] }
      }
      if (!restoreFailed) {
        await checkpoint.dispose().catch(() => undefined)
        await writer.update({ checkpoint: { ...job.checkpoint, open: false } })
        if (lock) await lock.updateOwner({ checkpointOpen: false }).catch(() => undefined)
      }
    }
  }
  if (restoreFailed) {
    const failed = restoreInfo.failed.map(f => `${f.path} (${f.error})`).slice(0, 20).join('; ')
    infra = { cls: 'restore_failed', detail: `the candidate could not be fully restored after the inspection: ${failed}` }
    verdict = null
    await markRestoreFailed(g.locks, root, { jobId: job.id, sessionId: job.sessionId }).catch(error => logger.error('cannot mark the workspace lock', { error }))
    lock = null // kept: fail closed until a human releases it
  }

  // 9b. What the restore found tells whether the Verifier inspected the candidate it was given
  // (security-2). The workspace lock stops new tool calls only; a process started before submit
  // (a background Bash, a Monitor) can still change the candidate during the inspection.
  let notCurrent = null
  if (verdict && !infra && restoreInfo && checkpoint) {
    const changed = changedPaths(restoreInfo)
    if (isolation.mode === 'sandbox' && changed.length > 0) {
      // The sandboxed Verifier cannot write the candidate: every change came from outside.
      infra = {
        cls: 'candidate_changed_during_inspection',
        detail: `the candidate changed during the sandboxed inspection, which the Verifier itself cannot do: something outside the inspection (for example a background process started before submit) changed ${changed.length} path(s): ${listed(changed)}; no verdict was recorded`,
        paths: changed.slice(0, 200),
      }
      verdict = null
    } else if (verdict.verdict === 'PASS' && ((restoreInfo.restored ?? []).length > 0 || (restoreInfo.unstable ?? []).length > 0)) {
      // Rollback mode: pre-existing files changed during the inspection (created files such as
      // caches do not count), so the inspected tree was not the restored candidate. The PASS is
      // recorded but never counts as current: it cannot be learned and does not cover the workspace.
      notCurrent = { reason: 'preexisting_changed', paths: [...new Set([...(restoreInfo.restored ?? []), ...(restoreInfo.unstable ?? [])])].sort().slice(0, 200) }
    }
  }
  if (infra && restoreInfo && checkpoint && !restoreFailed) {
    // 9c. Never claim "the candidate was restored" when it was not (memory-crash-7).
    const notRestored = checkpoint.detectOnly ? (restoreInfo.skipped ?? []) : []
    const unstable = restoreInfo.unstable ?? []
    if (notRestored.length > 0 || unstable.length > 0) {
      infra = { ...infra, detail: restoreDetail(infra.detail, { notRestored, unstable }), notRestored: notRestored.slice(0, 200), unstable: unstable.slice(0, 200) }
    }
  }
  // The Verifier transcript as this job leaves it (security-3: compared before the next --resume).
  const transcript = stats.contextUsed ? await transcriptFingerprint(stats.verifierSessionId, { env }).catch(() => null) : null

  // 10. Record. The result is written first, then the task transition, then the final status.
  try {
    if (verdict && !infra) {
      const restored = checkpoint?.detectOnly ? (restoreInfo?.skipped ?? []) : (restoreInfo?.restored ?? [])
      const result = {
        verdict: verdict.verdict,
        reportSha: verdict.reportSha,
        restored,
        displaced: restoreInfo?.displaced ?? [],
        detectOnly: checkpoint?.detectOnly === true,
        isolation: { mode: isolation.mode, reason: isolation.reason },
        model: stats.model ?? job.verifier?.model ?? null,
        costUsd: Math.round(stats.costUsd * 1e6) / 1e6,
        statusDigest: notCurrent ? `${NOT_CURRENT_PREFIX}${sd ?? 'none'}` : sd,
        notCurrent,
        candidateDigest,
        invocations: stats.invocations,
        guardGaps: stats.guardGaps,
        verifierSessionId: stats.verifierSessionId,
        transcript,
        contextRetired: stats.retired,
        finishedAt: nowIso(),
      }
      await writer.update({ result })
      await recordVerdict(job, result, { sl })
    } else {
      const outcome = infra ?? { cls: 'error', detail: 'the inspection ended without a verdict' }
      await writer.update({ infra: outcome, isolationUsed: isolation.mode ? { mode: isolation.mode, reason: isolation.reason } : null, contextRetired: stats.retired })
      await withTask(sl, s => applyInfra(s, { jobId: job.id, taskSeq: job.taskSeq, cls: outcome.cls, established: outcome.established, transcript }), { waitMs: TASK_LOCK_WAIT_MS, sessionId: job.sessionId })
    }
  } catch (error) {
    logger.error('recording the job outcome failed', { jobId: job.id, error })
    if (!job.result && !job.infra) await writer.update({ infra: { cls: 'error', detail: `recording failed: ${error?.message ?? error}` } })
  }
  // 11. Release the lock (unless the restore failed) and stop the heartbeat; the final status is the last write.
  if (lock) await releaseWorkspaceLock(lock).catch(() => undefined)
  clearInterval(heartbeat)
  if (signal) signal.removeEventListener('abort', onAbort)
  await writer.finish({ status: job.result && !job.infra ? 'done' : 'infra', heartbeatAt: nowIso(), finishedAt: nowIso() })
  logger.info('job finished', { jobId: job.id, status: job.status, verdict: job.result?.verdict ?? null, infra: job.infra?.cls ?? null })
  return job
}

/** Verdict transition (SPEC §11.2) + verdicts.jsonl line (SPEC §11.5 step 10). Idempotent per job. */
async function recordVerdict(job, result, { sl }) {
  const requestSeq = await lastRequestSeq(sl).catch(() => null)
  await withTask(sl, s => applyVerdict(s, {
    jobId: job.id,
    taskSeq: job.taskSeq,
    generation: job.generation,
    verdict: result.verdict,
    reportSha: result.reportSha,
    statusDigest: result.statusDigest,
    candidateDigest: result.candidateDigest,
    isolation: result.isolation?.mode ?? null,
    model: result.model,
    verifierModel: job.verifier?.model ?? null,
    verifierSessionId: result.verifierSessionId,
    transcript: result.transcript ?? null,
    requestSeq,
    at: result.finishedAt,
  }), { waitMs: TASK_LOCK_WAIT_MS, sessionId: job.sessionId })
  const existing = await readJsonl(sl.verdicts).catch(() => [])
  if (!existing.some(line => line && line.jobId === job.id)) {
    await appendJsonl(sl.verdicts, {
      ts: result.finishedAt,
      taskSeq: job.taskSeq,
      generation: job.generation,
      jobId: job.id,
      verdict: result.verdict,
      reportSha: result.reportSha,
      isolation: result.isolation,
      model: result.model,
      costUsd: result.costUsd,
      statusDigest: result.statusDigest,
      candidateDigest: result.candidateDigest,
      restored: Array.isArray(result.restored) ? result.restored.length : 0,
    })
  }
}

/**
 * Steps 7–8: opens the Verifier context and converses until a valid verdict (SPEC §11.5).
 * Recovery of a lost context, at most once: `session_missing` with an established transcript (or an
 * id conflict, i.e. a context whose registry was lost) → a fresh context (new uuid,
 * ROLE_CONTEXT_RESTARTED) seeded with the task's prior reports; `session_missing` before the context
 * ever existed → a new uuid with the same charter. Returns `{ verdict, report, reportSha }`.
 */
async function inspect({ job, home, sl, storeDir, store, env, logger, abort, stats, isolation, decision, mechanical, changedDelta = null, allowUnverified, onContext, coverage = 'listed' }) {
  const config = job.config ?? {}
  const transport = config.transport ?? {}
  const policy = { actionlessLimit: transport.actionlessLimit ?? 3, ceiling: transport.ceiling ?? 24 }
  const task = interactiveTask({ messages: Array.isArray(job.taskMessages) ? job.taskMessages : [] })
  const leads = typeof job.leadsText === 'string' ? job.leadsText : ''
  const onRuntimeEvent = (type, data) => logger.info(`runtime ${type}`, { jobId: job.id, ...data })
  let sessionId = job.verifier.sessionId
  let priorEntries = job.verifier.fresh === true ? (job.taskReports ?? job.priorReportShas ?? []) : []
  let sandbox = decision.sandbox === true
  let restarted = false
  // Tamper check right before a --resume (security-3): the transcript must be exactly what the last
  // job left. Anything else (edited, replaced, planted) means the history is no longer the
  // Verifier's own: the context is retired and a fresh one is seeded with the stored reports.
  const expected = job.verifier.transcript
  if (job.verifier.fresh !== true && expected && expected.sessionId === sessionId) {
    const now = await transcriptFingerprint(sessionId, { env }).catch(() => null)
    if (!sameTranscript(now, expected)) {
      const oldSessionId = sessionId
      sessionId = uuid()
      priorEntries = job.taskReports ?? job.priorReportShas ?? []
      stats.retired = { sessionId: oldSessionId, newSessionId: sessionId, reason: 'transcript_changed', at: nowIso() }
      logger.warn('ROLE_CONTEXT_RETIRED', { jobId: job.id, ctx: job.verifier.ctxKey, oldSessionId, newSessionId: sessionId, reason: 'transcript_changed' })
    }
  }
  for (;;) {
    // Every context id is in the session's append-only list before the context starts, so the
    // main-session guard hides its transcript from the first byte (security-3). Fail closed.
    await withTask(sl, s => noteVerifierSession(s, sessionId, job.candidateRoot), { waitMs: TASK_LOCK_WAIT_MS, sessionId: job.sessionId })
    const scratch = join(home, 'vscratch', sessionId)
    await mkdir(roleTmpDir(scratch), { recursive: true, mode: 0o700 })
    const priorReports = await priorReportTexts(store, priorEntries)
    // Only a context that performed the previous inspection itself hears "your last inspection"
    // (r2-interactive-9): a fresh, retired or restarted context did not.
    const ownContext = job.verifier.fresh !== true && !stats.retired && !restarted
    const changedSinceLast = changedDelta
      ? describeDelta(changedDelta, { header: ownContext ? 'since your last inspection' : 'since the last inspection (by an earlier Verifier context)' })
      : ''
    const charter = verifierCharter({
      generation: job.generation,
      task,
      candidateRoot: job.candidateRoot,
      scratchDir: scratch,
      mechanical,
      changedSinceLast,
      changedByEarlierContext: !ownContext,
      leads,
      priorReports,
      // Reports published by a context on another model are not this context's own (protocol-6).
      handover: priorReports.length > 0 ? (job.verifier.handover === 'other-verifier' ? 'other-verifier' : 'self') : null,
      allowUnverified,
    })
    const onDegrade = () => {
      // Interactive Verifiers degrade explicitly to rollback (SPEC §11.5 step 7, §10.9); the system
      // text is re-rendered for the real mode, and a later message gets RoleContext's degrade note.
      sandbox = false
      isolation.mode = 'rollback'
      isolation.reason = 'the OS sandbox was unavailable when the Verifier started, so it ran without one (rollback)'
      return { spec: verifierSpec({ job: { ...job, verifier: { ...job.verifier, sessionId } }, home, sl, storeDir, scratch, sandbox: false, checkpoint: coverage, env }) }
    }
    const spec = verifierSpec({ job: { ...job, verifier: { ...job.verifier, sessionId } }, home, sl, storeDir, scratch, sandbox, checkpoint: coverage, env })
    const ctx = new RoleContext(spec, { sessionId, logger, onRuntimeEvent, signal: abort.signal, onDegrade, parentEnv: env })
    stats.verifierSessionId = ctx.sessionId
    stats.contextUsed = true
    await onContext?.(ctx.sessionId)
    const send = async message => {
      const reply = await ctx.send(message)
      stats.invocations++
      if (Number.isFinite(reply.costUsdDelta)) stats.costUsd += reply.costUsdDelta
      stats.guardGaps += Number.isInteger(reply.guardGaps) ? reply.guardGaps : 0
      if (typeof reply.model === 'string' && reply.model !== '') stats.model = reply.model
      return reply
    }
    try {
      const out = await converse({
        first: charter,
        send,
        // The verdict comes only from the Verifier's final assistant message (SPEC §10.7, §7.1).
        parse: reply => parseVerdict(reply.text, { allowUnverified }),
        continuation: detail => verifierContinuation({ detail, allowUnverified }),
        truncatedContinuation: () => truncatedContinuation(),
        stallContinuation: () => verifierContinuation({ detail: 'the harness resumed after a pause', allowUnverified }),
        policy,
        who: 'Verifier',
      })
      const reportSha = await store.putReport(out.value.report)
      return { verdict: out.value.verdict, report: out.value.report, reportSha }
    } catch (error) {
      const lost = error instanceof InfraError && (error.cls === 'session_missing' || error.cls === 'session_conflict')
      if (!lost || restarted || abort.signal.aborted) throw error
      restarted = true
      const established = error.cls === 'session_conflict' || error.extra?.established === true
      const oldSessionId = sessionId
      sessionId = uuid()
      // A lost transcript: the fresh context gets the task's prior reports (RSIAgent never replays a
      // history; the reports are what the earlier context published). Never established: same charter.
      if (established) priorEntries = job.taskReports ?? job.priorReportShas ?? []
      logger.warn('ROLE_CONTEXT_RESTARTED', { jobId: job.id, ctx: job.verifier.ctxKey, oldSessionId, newSessionId: sessionId, reason: error.cls, established })
    }
  }
}

// ---------------------------------------------------------------- recovery

/**
 * Recovers a job whose process died (SPEC §11.5 "Recovery"): kills leftovers of its process group,
 * takes the workspace lock over (memory-crash-2: the restore runs under the root's lock, so no other
 * job checkpoints the Verifier's changes meanwhile), restores an open checkpoint (displaced copies
 * kept), writes infra `job_died` (or `restore_failed`, keeping the workspace locked), clears
 * `task.job`, and releases the lock. When another job holds the root, nothing is restored: the
 * checkpoint is kept and the workspace marked restore-failed for a human. A job whose result was
 * already recorded is completed as `done` instead. Never runs while the job's process is alive.
 * Returns the job (unchanged when nothing was to be done).
 */
export async function recoverJob(jobFile, { env = process.env } = {}) {
  if (env.CC_RSI_ROLE) throw new RoleContextError()
  let job = await readJob(jobFile)
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return job
  if (!jobIsDead(job)) return job
  const lockPath = `${jobFile}.recover.lock`
  // A recovery stopped past its lease is taken over by another recovery (memory-crash-9): it then
  // records nothing (assertHeld before every record) and leaves the job to the new recoverer.
  let recoveryLost = false
  const rlock = new LeaseLock(lockPath, { leaseMs: 60000, heartbeatMs: 5000, owner: { kind: 'job-recovery', jobId: job.id }, onLost: () => { recoveryLost = true } })
  if (!(await rlock.acquire({ wait: false }))) return job
  let wlock = null
  // The taken-over workspace lock is released only once the checkpoint is restored and disposed
  // (or there was nothing to restore); otherwise it stays (sticky, recovery-pending once this process
  // is gone), so a half-restored root is never left unlocked (r2-concurrency-1).
  let restoreDone = false
  try {
    job = await readJob(jobFile)
    if (!job || (job.status !== 'running' && job.status !== 'queued') || !jobIsDead(job)) return job
    const { g, sl } = layoutsOf(job)
    const logger = createLogger(g.jobsLog, 'verify-job')
    const writer = new JobFile(jobFile, job)
    // Leftover children (the Verifier's claude process) share the dead job's process group.
    const sameHost = typeof job.host !== 'string' || sameMachine(job)
    if (Number.isInteger(job.pid) && job.pid > 0 && sameHost && !pidAlive(job.pid)) {
      await killGracefully(job.pid, { group: true, graceMs: 2000 }).catch(() => undefined)
    }
    if (job.result && !job.infra) {
      // The verdict was recorded before the job died (after its restore): finish it.
      await recordVerdict(job, job.result, { sl })
      await releaseWorkspaceLockFor(g.locks, job.candidateRoot, job.id).catch(() => undefined)
      await writer.finish({ status: 'done', finishedAt: job.finishedAt ?? nowIso(), recoveredAt: nowIso() })
      logger.warn('recovered a finished job', { jobId: job.id })
      return job
    }
    const contextId = job.contextSessionId ?? null
    const transcript = contextId ? await transcriptFingerprint(contextId, { env }).catch(() => null) : null
    const cpDir = typeof job.checkpoint?.dir === 'string' ? job.checkpoint.dir : join(sl.checkpoints, job.id)
    let restoreFailed = false
    let detail = DIED_DETAIL
    let restored = null
    let conflict = null
    // Fencing: a recovery that lost its lock (or the taken-over workspace lock) stops before any
    // irreversible step, so it never restores, disposes or records under another recovery.
    const fence = async () => {
      await rlock.assertHeld()
      if (wlock) await wlock.assertHeld()
      if (recoveryLost || (wlock && wlock.lost)) throw new CcRsiError('lock_lost', `the recovery of job ${job.id} lost its lock; another recovery owns it`)
    }
    if (existsSync(cpDir)) {
      const take = await takeOverWorkspaceLock(g.locks, job.candidateRoot, { jobId: job.id, sessionId: job.sessionId, jobFile, env, onLost: () => { recoveryLost = true } })
      // Another live recovery of this job holds the root: it finishes the job (r2-concurrency-2).
      if (take.busy) return job
      if (take.lock) {
        wlock = take.lock
        await fence()
        try {
          const cp = await Checkpoint.load(cpDir)
          restored = await cp.restore({ displacedDir: join(sl.displaced, job.id) })
          if (restored.failed.length > 0) {
            restoreFailed = true
          } else {
            await fence()
            await cp.dispose()
            restoreDone = true
            if (cp.detectOnly || (restored.unstable ?? []).length > 0) {
              detail = restoreDetail(DIED_DETAIL, { notRestored: cp.detectOnly ? restored.skipped ?? [] : [], unstable: restored.unstable ?? [] })
            }
          }
        } catch (error) {
          if (error?.code === 'checkpoint_missing') {
            await Checkpoint.discard(cpDir).catch(() => undefined)
            restoreDone = true
          } else if (error?.code === 'lock_lost' || error?.code === 'lock_unknown' || error?.code === 'lock_guard_timeout') {
            throw error
          } else {
            restoreFailed = true
            restored = { failed: [{ path: '.', error: String(error?.message ?? error) }] }
          }
        }
      } else {
        conflict = take.conflict ?? { owner: {} }
        restoreFailed = true
      }
    }
    // Fencing: a recovery whose lock (or taken-over workspace lock) was lost records nothing.
    await fence()
    let infra
    if (restoreFailed) {
      if (conflict) {
        const holder = conflict.owner?.restoreFailed === true ? 'a recorded restore failure' : `job ${conflict.owner?.jobId ?? 'unknown'}`
        detail = `the verification did not complete and its checkpoint was NOT restored, because the workspace lock is held by ${holder}; the checkpoint is kept for the user`
      } else {
        const failed = (restored?.failed ?? []).map(f => `${f.path} (${f.error})`).slice(0, 20).join('; ')
        detail = `the verification did not complete and the candidate could not be fully restored: ${failed}`
      }
      infra = { cls: 'restore_failed', detail }
      await markRestoreFailed(g.locks, job.candidateRoot, { jobId: job.id, sessionId: job.sessionId }).catch(() => undefined)
      wlock = null // kept (or never ours): fail closed until a human releases it
    } else {
      infra = { cls: 'job_died', detail }
      if (restored && ((restored.skipped ?? []).length > 0 || (restored.unstable ?? []).length > 0)) {
        infra.notRestored = (restored.skipped ?? []).slice(0, 200)
        infra.unstable = (restored.unstable ?? []).slice(0, 200)
      }
    }
    await writer.update({
      infra,
      checkpoint: job.checkpoint ? { ...job.checkpoint, open: restoreFailed } : null,
      recovered: { at: nowIso(), restored: restored?.restored ?? [], displaced: restored?.displaced ?? [], skipped: restored?.skipped ?? [], unstable: restored?.unstable ?? [] },
    })
    await withTask(sl, s => applyInfra(s, { jobId: job.id, taskSeq: job.taskSeq, cls: infra.cls, transcript }), { waitMs: TASK_LOCK_WAIT_MS, sessionId: job.sessionId })
    // Release only after the outcome is recorded; a job that never took a checkpoint holds no
    // checkpoint-open record and is released by job id.
    if (wlock) await releaseWorkspaceLock(wlock).catch(() => undefined)
    else if (!restoreFailed) await releaseWorkspaceLockFor(g.locks, job.candidateRoot, job.id).catch(() => undefined)
    wlock = null
    await writer.finish({ status: 'infra', finishedAt: nowIso() })
    logger.warn('recovered a dead job', { jobId: job.id, cls: infra.cls })
    return job
  } finally {
    if (wlock) {
      // Restored and disposed: the root is the candidate again. Otherwise (a lost fence, a failed or
      // partial restore that was never recorded) the record stays as it is: checkpoint-open and
      // recovering, so the guard keeps the root locked and respawns a recovery once we are gone.
      if (restoreDone) await releaseWorkspaceLock(wlock).catch(() => undefined)
      else wlock.stopHeartbeat()
    }
    // A guarded compare-and-delete of our own record only: never an unconditional unlink, which could
    // remove a newer recovery's lock and let two recoveries run at once (r2-concurrency-2).
    await rlock.release().catch(() => undefined)
  }
}

// ---------------------------------------------------------------- CLI

/** `node verify-job.mjs run|recover <jobFile>`. Exit 0 handled, 1 error, 2 usage, 64 inside a role. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (env.CC_RSI_ROLE) {
    process.stderr.write('cc-rsi: refusing to run inside a cc-rsi role context (CC_RSI_ROLE is set)\n')
    return 64
  }
  const [mode, jobFile] = argv
  if ((mode !== 'run' && mode !== 'recover') || typeof jobFile !== 'string' || jobFile === '') {
    process.stderr.write('usage: node lib/interactive/verify-job.mjs run|recover <jobFile>\n')
    return 2
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGHUP', stop)
  try {
    if (mode === 'run') await runJob(resolve(jobFile), { signal: controller.signal, env })
    else await recoverJob(resolve(jobFile), { env })
    return 0
  } catch (error) {
    process.stderr.write(`cc-rsi verify-job: ${error?.stack ?? error}\n`)
    return 1
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    process.off('SIGHUP', stop)
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().then(code => {
    process.exitCode = code
  })
}

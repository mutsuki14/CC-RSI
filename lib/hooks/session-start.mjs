// SessionStart (SPEC §11.8 `session-start`): records the session, refreshes the terminal shim,
// opens the memory store (recovery; tamper is a warning here), refreshes the read-only memory view,
// recovers dead verification jobs, and injects the RSI protocol + memory inventory as context
// (plus the verbatim task pin after a compaction, RSIAgent core/loop.py:970 fold task pin).

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userConfigFromEnv } from '../core/config.mjs'
import { isUnderLexical } from '../core/paths.mjs'
import { decideIsolation, effectiveProbe, readProbe, staticProbe } from '../runtime/sandbox.mjs'
import { formatInventory } from '../memory/inventory.mjs'
import { actorProtocol, memoryPreamble, memoryRevisit, taskPin } from '../prompts/roles.mjs'
import { guidanceRefusal } from '../prompts/guidance.mjs'
import { refreshView, viewInventory } from '../interactive/memview.mjs'
import { readRequests, taskMessagesFor } from '../interactive/requests.mjs'
import {
  CODE_ROOT, HOOK_OPT_PREFIX, lineageCounters, lineageStates, openStore, pluginCodeFingerprint, pluginRootOf, resolveVerifierModel, sessionContext, writeSession,
} from '../interactive/session.mjs'
import { readTask, recoverDeadJobs } from '../interactive/task.mjs'
import { recoverPendingLocks } from '../interactive/wslock.mjs'
import { contextOutput, failOpen, hookLogger, isRole } from './common.mjs'

/** additionalContext cap (SPEC §11.8; Claude Code previews longer context). */
export const CONTEXT_MAX = 9000
const PIN_MAX = 3000
const USER_VISIBLE_SOURCES = new Set(['startup', 'resume', 'clear', 'fork'])

/** `<home>/.gitignore` = "*" (written once; SPEC §4.1). */
function ensureHomeGitignore(home) {
  const path = join(home, '.gitignore')
  if (existsSync(path)) return
  try {
    writeFileSync(path, '*\n', { flag: 'wx', mode: 0o600 })
  } catch {
    // another process wrote it, or home is not writable: never block the session
  }
}

/** writeShim(home, CLAUDE_PLUGIN_ROOT) from lib/cli/shim.mjs (WP7), loaded lazily; absent → skipped. */
async function refreshShim(home, env, logger) {
  const root = env.CLAUDE_PLUGIN_ROOT
  if (typeof root !== 'string' || root === '' || /^\$\{/.test(root)) return false
  let mod
  try {
    mod = await import('../cli/shim.mjs')
  } catch {
    return false
  }
  try {
    return typeof mod.writeShim === 'function' ? Boolean(await mod.writeShim(home, root)) : false
  } catch (error) {
    logger.warn('shim refresh failed', { error: error?.message })
    return false
  }
}

function cutText(text, max) {
  if (text.length <= max) return text
  const marker = `\n[… ${text.length - max} chars truncated]`
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`
}

/**
 * Builds the SessionStart context C (≤ 9000 chars): protocol + memory preamble + notices, and on
 * `compact` the task pin + the fold memory revisit. When too long, the inventory listing shrinks
 * first, then the pin is cut; the result is finally capped.
 */
export function buildContext({ mode, allowUnverified, viewDir, files, promptInventory = 40, notices = [], pinMessages = null }) {
  const protocol = actorProtocol({ mode, allowUnverified, memoryViewDir: viewDir })
  const nonEmpty = files.length > 0
  let pin = ''
  if (Array.isArray(pinMessages) && pinMessages.length > 0) {
    pin = cutText(taskPin({ messages: pinMessages }), PIN_MAX)
    if (nonEmpty) pin += memoryRevisit('fold', { memoryDir: viewDir })
  }
  const noticeText = notices.filter(Boolean).join('\n')
  const limits = [promptInventory, 20, 10, 5, 0].filter((n, i, all) => n <= promptInventory && all.indexOf(n) === i)
  let text = ''
  for (const limit of limits) {
    const preamble = memoryPreamble({ memoryDir: viewDir, inventory: formatInventory(files, limit), empty: !nonEmpty })
    text = [protocol, preamble, noticeText, pin].filter(part => part !== '').join('\n\n')
    if (text.length <= CONTEXT_MAX) return text
  }
  return cutText(text, CONTEXT_MAX)
}

async function sessionStart(payload, env) {
  const logger = hookLogger(env)
  const source = typeof payload.source === 'string' && payload.source !== '' ? payload.source : 'startup'
  const ctx = await sessionContext({ payload, env })
  const { home, sl, pl, config, sid } = ctx
  ensureHomeGitignore(home)
  // (1) session.json + the per-session index (written by sessionContext).
  const prev = ctx.session
  const now = new Date().toISOString()
  const payloadModel = typeof payload.model === 'string' && payload.model !== '' ? payload.model : null
  // The plugin code this session started with (security-4). Kept within one Claude Code process (a
  // compaction or /clear must not re-baseline an edit); a new process (startup, --resume, a fork)
  // loads hooks and the MCP server afresh from disk, so it records the code it runs, and says so
  // when that code changed (r2-interactive-3: otherwise only a brand-new session clears it).
  const pluginRoot = pluginRootOf(env)
  const sameProcess = source === 'compact' || source === 'clear'
  const keepPrint = sameProcess && typeof prev?.pluginFingerprint === 'string' && prev.pluginRoot === pluginRoot && prev.codeRoot === CODE_ROOT
  const currentPrint = keepPrint ? prev.pluginFingerprint : pluginCodeFingerprint(CODE_ROOT)
  const rebaselined = !keepPrint && typeof prev?.pluginFingerprint === 'string' && prev.pluginFingerprint !== currentPrint
  if (rebaselined) logger.warn('plugin code changed since this session first started; re-baselined', { source, recorded: prev.pluginFingerprint, current: currentPrint })
  const keepTranscriptModel = sameProcess || prev?.modelSource !== 'transcript'
  const session = await writeSession(sl, {
    sessionId: sid,
    transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : prev?.transcriptPath ?? null,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : prev?.cwd ?? null,
    projectDir: ctx.projectDir,
    projectRoot: ctx.projectRoot,
    projectKey: ctx.key,
    // A transcript-derived model is first-seen per Claude Code process (r2-interactive-8): a new
    // process (startup, --resume, a fork; possibly with another --model) derives it again.
    model: payloadModel ?? (keepTranscriptModel ? prev?.model ?? null : null),
    modelSource: payloadModel ? 'session-start' : keepTranscriptModel ? prev?.modelSource ?? null : null,
    source,
    pluginRoot,
    codeRoot: CODE_ROOT,
    pluginFingerprint: currentPrint,
    pluginFingerprintAt: keepPrint ? prev.pluginFingerprintAt ?? now : now,
    // The options the user saved (hooks see only those): the MCP server applies these instead of
    // its env, where Claude Code substitutes manifest defaults for unsaved options (cc-integration-2).
    pluginOptions: userConfigFromEnv(env, HOOK_OPT_PREFIX),
    startedAt: prev?.startedAt ?? now,
    lastSeen: now,
    endedAt: null,
    pendingBaselineSeq: prev?.pendingBaselineSeq ?? null,
  })
  // (2) The terminal shim.
  await refreshShim(home, env, logger)
  // (3) The store (recovery) and its integrity; (4) the read-only view.
  let store = null
  let tamper = false
  let frozen = false
  let sealed = null
  try {
    store = await openStore(config, pl, { lockWaitMs: 2000, logger })
  } catch (error) {
    logger.warn('memory store not opened at session start', { error: error?.message })
  }
  if (store) {
    try {
      await store.assertCanonicalIntact()
    } catch (error) {
      if (error?.code === 'memory_tamper') tamper = true
      else logger.warn('memory integrity check failed', { error: error?.message })
    }
    frozen = Boolean(await store.frozen().catch(() => null))
    sealed = await store.sealed().catch(() => null)
    try {
      await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })
    } catch (error) {
      logger.warn('memory view refresh failed', { error: error?.message })
    }
  }
  // The preamble lists what the Actor can read: the view (committed memory; SPEC §11.10).
  const inventory = await viewInventory(sl.viewDir)
  // (5) Recovery of this session's dead verification jobs (detached, by path).
  const state = await readTask(sl, { sessionId: sid })
  await recoverDeadJobs(sl, { env, taskJob: state.job }).catch(error => logger.warn('job recovery spawn failed', { error: error?.message }))
  // Jobs of ANY session that died with their checkpoint open keep their root locked until their
  // recovery runs (memory-crash-2); a session that is never resumed would never start it.
  try {
    recoverPendingLocks(ctx.g.locks, { env })
  } catch (error) {
    logger.warn('workspace lock recovery spawn failed', { error: error?.message })
  }
  // (6) Context and the user-visible line.
  const learningClosed = frozen || config.mode === 'frozen'
  const mode = learningClosed ? 'frozen' : 'learn'
  const files = inventory.files
  const notices = []
  const lineages = lineageStates(pl).filter(l => l.live)
  if (lineages.length > 0) {
    notices.push(`cc-rsi: exploration lineages of this project: ${lineages.map(l => `${l.id} ${l.phase} ${l.status}${lineageCounters(l) ? ` ${lineageCounters(l)}` : ''}`).join('; ')}. They run in the background; the user manages them with /cc-rsi:explore.`)
  }
  if ((source === 'compact' || source === 'resume') && state.learning) {
    // The stage message (and its confirmation code) may be gone with the compacted history (cc-integration-5).
    const stage = typeof state.learning.stage === 'string' ? state.learning.stage : 'unknown'
    const draft = typeof state.learning.draftDir === 'string' ? state.learning.draftDir : 'unknown'
    notices.push(`A cc-rsi learning phase is open (stage ${stage}, draft ${draft}); call learn to see its current instructions and confirmation code, or memory_commit with abandon:true to discard it.`)
  }
  if (tamper) notices.push(guidanceRefusal('tamper'))
  if (sealed && sealed.learningAfterSealed !== true) notices.push(guidanceRefusal('sealed'))
  let pinMessages = null
  if (source === 'compact') {
    const requests = await readRequests(sl)
    const first = state.task?.firstRequestSeq ?? 1
    pinMessages = taskMessagesFor(requests, first, config.interactive?.taskMessages ?? 3)
  }
  const C = buildContext({
    mode,
    allowUnverified: config.interactive?.allowUnverified !== false,
    viewDir: sl.viewDir,
    files,
    promptInventory: config.memory?.promptInventory ?? 40,
    notices,
    pinMessages,
  })
  await writeSession(sl, { contextTreeSha: inventory.treeSha256 })
  const out = contextOutput('SessionStart', C)
  if (USER_VISIBLE_SOURCES.has(source)) {
    const probe = effectiveProbe(await readProbe(home), staticProbe({ env }))
    const decision = decideIsolation({ want: config.isolation?.sandbox ?? 'auto', probe })
    const isolation = decision.refuse ? 'refused' : decision.sandbox ? 'sandbox' : 'rollback'
    const resolved = resolveVerifierModel(config, session, env)
    // The session model is often unknown here (no model in the 2.1.296 payload); it is read from the
    // transcript later (attest, Stop). Only two known, equal models are worth a warning.
    const sessionModel = typeof session.model === 'string' && session.model !== '' ? session.model : null
    const verifierModel = resolved.model ?? (sessionModel === null ? 'inherit (session model not yet known)' : 'inherit')
    let M = `cc-rsi: Verifier isolation = ${isolation} (${decision.reason}); Verifier model = ${verifierModel}; memory ${files.length} files (${mode})`
    if (resolved.model !== null && sessionModel !== null && resolved.model === sessionModel) M += '; WARNING: Verifier model equals the session model'
    if (tamper) M += '; WARNING: memory changed outside a commit (cc-rsi memory verify)'
    if (rebaselined) M += '; NOTE: the cc-rsi plugin code changed since this session first started; the code now loaded is trusted'
    // memory.dir problems (r2-overblock-1): a refused relative value, or a store inside the project.
    if ((ctx.configWarnings ?? []).some(w => w.includes('"memory.dir"') && w.includes('not an absolute path'))) {
      M += '; WARNING: memory.dir in ~/.cc-rsi/config.json is not an absolute path (or ~/…) and was ignored'
    } else if (typeof config.memory?.dir === 'string' && config.memory.dir !== '' && [ctx.projectRoot, ctx.projectDir].some(p => typeof p === 'string' && isUnderLexical(pl.store, p))) {
      M += `; WARNING: memory.dir (${pl.store}) lies inside this project: move it outside (git may commit it; searches of the project are not refused for covering it)`
    }
    out.systemMessage = M
  }
  return { stdout: out }
}

/** SessionStart hook entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  return failOpen('session-start', () => sessionStart(payload ?? {}, env), { env })
}

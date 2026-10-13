// UserPromptSubmit (SPEC §11.8 `prompt`): verbatim request capture, task bookkeeping (§11.2 first
// row), the S0 baseline (PF §4.4) spawned detached, the memory view refresh, and context only when
// the memory inventory changed since the session's context was built or a verification runs.
//
// UserPromptSubmit also fires for `<task-notification>` and cross-session turns
// (claude-code-experiments.md g7); those are not requests (requests.mjs isSynthetic).

import { join } from 'node:path'
import { readJsonSafeSync } from '../core/atomic.mjs'
import { spawnDetached } from '../core/proc.mjs'
import { formatInventory } from '../memory/inventory.mjs'
import { memoryPreamble } from '../prompts/roles.mjs'
import { refreshView, viewInventory, viewLooksStale } from '../interactive/memview.mjs'
import { appendRequest, isSynthetic } from '../interactive/requests.mjs'
import { CODE_ROOT, peekStore, sessionContext, workspaceDigest, workspaceRootFor, writeSession } from '../interactive/session.mjs'
import { mayOpenOnPrompt, openTask, readTaskSync, withTask } from '../interactive/task.mjs'
import { contextOutput, failOpen, hookLogger, isRole } from './common.mjs'

const BASELINE_PATH = join(CODE_ROOT, 'lib', 'workspace', 'baseline.mjs')

/** The text injected while a verification job runs (SPEC §11.8). */
export function runningNotice(jobId) {
  return `An independent cc-rsi verification is running (job ${jobId}). File edits and shell commands are paused; call wait_verdict to receive the verdict.`
}

async function prompt(payload, env) {
  if (typeof payload.agent_id === 'string' && payload.agent_id !== '') return {}
  const text = payload.prompt
  // (1) Synthetic turns are not requests.
  if (isSynthetic(text)) return {}
  const logger = hookLogger(env)
  const ctx = await sessionContext({ payload, env })
  const { home, sl, pl, config, sid } = ctx
  const storeDir = typeof config.memory?.dir === 'string' && config.memory.dir !== '' ? config.memory.dir : undefined
  // The open digest is computed before taking the session lock (git may take up to 3 s).
  let openRoot = null
  let openDigest = null
  if (mayOpenOnPrompt(readTaskSync(sl, { sessionId: sid }))) {
    openRoot = await workspaceRootFor(typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : ctx.projectDir, { projectDir: ctx.projectDir })
    openDigest = await workspaceDigest(openRoot, { home, storeDir })
  }
  // (2) Capture and (3) task bookkeeping, serialized under the session lock.
  let opened = null
  let captured = false
  const promptId = typeof payload.prompt_id === 'string' ? payload.prompt_id : null
  let state
  try {
    state = await withTask(sl, async s => {
      const { seq } = await appendRequest(sl, { promptId, text })
      captured = true
      if (!mayOpenOnPrompt(s)) return
      const root = openRoot ?? ctx.projectRoot
      openTask(s, { requestSeq: seq, openDigest: openRoot === null ? null : openDigest, openRoot: root })
      opened = { seq, taskSeq: s.task.seq, openedAt: s.task.openedAt, root }
      // S0 baseline only for git projects (a digest proves git works here).
      if (config.interactive?.baseline !== false && openDigest !== null && openRoot !== null) {
        opened.baselineFile = join(sl.baselines, `b-${seq}.json`)
        s.task.baselineFile = opened.baselineFile
      }
    }, { waitMs: 5000, sessionId: sid })
  } catch (error) {
    // The session lock stayed busy: the request is still captured (it is the Verifier's
    // authoritative task), without task bookkeeping for this turn.
    if (!captured) await appendRequest(sl, { promptId, text })
    opened = null
    logger.warn('prompt bookkeeping skipped', { error: error?.message })
    state = readTaskSync(sl, { sessionId: sid })
  }
  if (opened?.baselineFile) {
    try {
      const childEnv = { ...env }
      delete childEnv.CC_RSI_ROLE
      spawnDetached(process.execPath, [BASELINE_PATH, opened.root, opened.baselineFile, opened.openedAt], {
        cwd: home, env: childEnv, logFile: opened.baselineFile.replace(/\.json$/, '.log'),
      })
      await writeSession(sl, { pendingBaselineSeq: opened.seq, lastSeen: new Date().toISOString() })
    } catch (error) {
      logger.warn('baseline spawn failed', { error: error?.message })
    }
  } else {
    await writeSession(sl, { lastSeen: new Date().toISOString() })
  }
  // (4) Refresh the view when canonical memory changed (cheap check first).
  if (viewLooksStale(pl.store, sl.viewJson)) {
    try {
      const store = await peekStore(config, pl, { lockWaitMs: 1000 })
      await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })
    } catch (error) {
      logger.warn('memory view refresh failed', { error: error?.message })
    }
  }
  // (5) Context: a new preamble when the inventory changed since SessionStart; a running job.
  const parts = []
  const viewHash = readJsonSafeSync(sl.viewJson, null)?.treeSha256 ?? null
  if (viewHash !== null && ctx.session && viewHash !== (ctx.session.contextTreeSha ?? null)) {
    // The view (what the Actor reads) changed since its context was built: a new preamble.
    const inventory = await viewInventory(sl.viewDir)
    const files = inventory.files
    parts.push(memoryPreamble({ memoryDir: sl.viewDir, inventory: formatInventory(files, config.memory?.promptInventory ?? 40), empty: files.length === 0 }))
    await writeSession(sl, { contextTreeSha: inventory.treeSha256 ?? viewHash })
  }
  if (state.job) parts.push(runningNotice(state.job.id))
  if (parts.length === 0) return {}
  return { stdout: contextOutput('UserPromptSubmit', parts.join('\n\n')) }
}

/** UserPromptSubmit hook entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  return failOpen('prompt', () => prompt(payload ?? {}, env), { env })
}

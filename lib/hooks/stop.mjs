// Stop policy (SPEC §11.9; J2-7; PR §4.10): `off` | `nudge` (default) | `gate`.
//
// The Actor is the user's own session and may skip `submit`; the Stop hook only reminds it (nudge:
// once per condition) or blocks a bounded number of times (gate: ≤ stopGateMax per prompt). A nudge
// is Stop `additionalContext` ("Stop hook feedback", no hook-error notice); only the gate uses
// `decision: block`. Both continue the conversation under the same loop protections, so every
// reminder is recorded once per key and guarded by `stop_hook_active` (claude-code-experiments.md d:
// the flag is the loop guard); Claude Code's own cap of 8 consecutive continuations applies on top.
// While background tasks run, the hint is emitted at most once per key and never blocks. Verdict
// currency uses the harness statusDigest, never conversation text.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSafeSync } from '../core/atomic.mjs'
import { expireScheduled } from '../interactive/requests.mjs'
import { recordTranscriptModel, sessionContext, workspaceDigest } from '../interactive/session.mjs'
import { isTerminal, lastReport, learnTarget, readTaskSync, withTask } from '../interactive/task.mjs'
import { contextOutput, failOpen, isRole } from './common.mjs'

export const STOP_REASONS = Object.freeze({
  job: 'A cc-rsi verification is still running. Call wait_verdict to receive its verdict before you finish.',
  learning: 'A cc-rsi learning phase is open: finish it with memory_commit (call learn to re-show the current stage message and its confirmation code), or call memory_commit with abandon:true (no code needed) to discard the draft.',
  changes: 'You changed the workspace for this task but no independent verification covers the current state. If the task is complete and non-trivial, call submit; otherwise state plainly that the result is unverified, and finish.',
  learn: 'This verified experience has not been learned. Call learn if it holds something reusable for a future task; otherwise finish.',
})

/** Whether learning is possible for this project right now (mode learn, not frozen, not sealed). */
function learningOpen(ctx) {
  if (ctx.config?.mode === 'frozen') return false
  if (existsSync(join(ctx.pl.store, 'frozen.json'))) return false
  if (existsSync(join(ctx.pl.store, 'sealed.json'))) {
    const sealed = readJsonSafeSync(join(ctx.pl.store, 'sealed.json'), null)
    if (!sealed || sealed.learningAfterSealed !== true) return false
  }
  return true
}

/** The matching rows of SPEC §11.9 in order: `[{ row, key, reason }]`. */
export async function stopRows(ctx, state) {
  const rows = []
  const digests = new Map()
  const storeDir = typeof ctx.config?.memory?.dir === 'string' && ctx.config.memory.dir !== '' ? ctx.config.memory.dir : undefined
  const digestOf = async root => {
    if (typeof root !== 'string' || root === '') return null
    if (!digests.has(root)) digests.set(root, await workspaceDigest(root, { home: ctx.home, storeDir, timeoutMs: 3000 }))
    return digests.get(root)
  }
  if (state.job) rows.push({ row: 1, key: `wait:${state.job.id}`, reason: STOP_REASONS.job })
  if (state.learning) rows.push({ row: 2, key: `learning:${state.learning.episode}`, reason: STOP_REASONS.learning })
  const t = state.task
  if (!state.job && !state.learning && t && t.closed !== true && typeof t.openDigest === 'string') {
    const root = t.openRoot ?? t.candidateRoot
    const current = await digestOf(root)
    // A git timeout skips this row (SPEC §11.9).
    if (current !== null && current !== t.openDigest) {
      const report = lastReport(t)
      let covered = false
      if (report && isTerminal(report.verdict) && typeof report.statusDigest === 'string') {
        const now = (t.candidateRoot ?? root) === root ? current : await digestOf(t.candidateRoot)
        covered = now === report.statusDigest
      }
      if (!covered) rows.push({ row: 3, key: `changes:${current}`, reason: STOP_REASONS.changes })
    }
  }
  if (!state.job && !state.learning && learningOpen(ctx)) {
    const target = learnTarget(state)
    if (target) {
      const report = lastReport(target.t)
      let current = true
      if (report && typeof report.statusDigest === 'string') current = (await digestOf(target.t.candidateRoot)) === report.statusDigest
      if (current) rows.push({ row: 4, key: `learn:${target.t.seq}-g${target.t.lastVerdictGen}`, reason: STOP_REASONS.learn })
    }
  }
  return rows
}

async function stop(payload, env) {
  const ctx = await sessionContext({ payload, env, create: false })
  // Scheduled prompts whose task is gone (deleted, fired once, expired) leave the ledger, so the
  // same text typed later is a request again (r2-overblock-3); whatever the stop policy.
  if (Array.isArray(payload.session_crons)) await expireScheduled(ctx.sl, { active: payload.session_crons }).catch(() => 0)
  const policy = ctx.config?.interactive?.stopPolicy ?? 'nudge'
  if (policy === 'off') return {}
  const background = Array.isArray(payload.background_tasks) && payload.background_tasks.length > 0
  // additionalContext continues the conversation like a block does, so the loop guard applies to
  // every nudge and to every background hint (only the gate counts its own blocks).
  if (payload.stop_hook_active === true && (policy === 'nudge' || background)) return {}
  // The session model, when no hook reported it (cc-integration-3): a cheap transcript-tail read.
  await recordTranscriptModel(ctx, payload.transcript_path).catch(() => null)
  const state = readTaskSync(ctx.sl, { sessionId: ctx.sid })
  const rows = await stopRows(ctx, state)
  if (rows.length === 0) return {}
  if (background) {
    // Background work is still running (the session wakes on its notification, and that Stop applies
    // the policy): one hint per row at most, never a block and never counted against the gate.
    let hint = null
    await withTask(ctx.sl, s => {
      const row = rows.find(r => !s.stop.nudged.includes(`bg:${r.key}`))
      if (!row) return
      s.stop.nudged.push(`bg:${row.key}`)
      hint = row
    }, { waitMs: 5000, sessionId: ctx.sid })
    return hint ? { stdout: contextOutput('Stop', hint.reason) } : {}
  }
  const promptId = typeof payload.prompt_id === 'string' ? payload.prompt_id : null
  const gateMax = Number.isInteger(ctx.config?.interactive?.stopGateMax) ? ctx.config.interactive.stopGateMax : 3
  let block = null
  await withTask(ctx.sl, s => {
    if (policy === 'gate') {
      const row = rows[0]
      if (!s.stop.gate || s.stop.gate.promptId !== promptId) s.stop.gate = { promptId, blocks: 0, rows: {} }
      if (!s.stop.gate.rows || typeof s.stop.gate.rows !== 'object') s.stop.gate.rows = {}
      const count = Number.isInteger(s.stop.gate.rows[row.key]) ? s.stop.gate.rows[row.key] : 0
      const cap = row.row === 4 ? 1 : gateMax
      if (count < cap) {
        s.stop.gate.rows[row.key] = count + 1
        s.stop.gate.blocks = (Number.isInteger(s.stop.gate.blocks) ? s.stop.gate.blocks : 0) + 1
        block = row
      } else if (row.row === 3 && !s.stop.nudged.includes(`unverified:${row.key}`)) {
        // The gate is exhausted: the stop is allowed and recorded as unverified.
        s.stop.unverifiedStops = (Number.isInteger(s.stop.unverifiedStops) ? s.stop.unverifiedStops : 0) + 1
        s.stop.nudged.push(`unverified:${row.key}`)
      }
      return
    }
    // nudge: the first row not yet nudged is fed back once.
    const row = rows.find(r => !s.stop.nudged.includes(r.key))
    if (!row) return
    s.stop.nudged.push(row.key)
    block = row
  }, { waitMs: 5000, sessionId: ctx.sid })
  if (!block) return {}
  // A nudge is by-design guidance: additionalContext ("Stop hook feedback"), never a hook error.
  if (policy !== 'gate') return { stdout: contextOutput('Stop', block.reason) }
  return { stdout: { decision: 'block', reason: block.reason } }
}

/** Stop hook entry (SPEC §11.8 module export). Subagent stops and role children are never blocked. */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  if (typeof payload?.agent_id === 'string' && payload.agent_id !== '') return {}
  return failOpen('stop', () => stop(payload ?? {}, env), { env })
}

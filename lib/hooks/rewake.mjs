// Async-rewake PostToolUse hook (SPEC §11.8 `rewake`; V1 [U]): after `submit`/`wait_verdict`
// answered VERIFICATION RUNNING, it waits in the background for the job and, when the verdict lands
// undelivered, exits 2 so Claude Code wakes the Actor with the stderr line. `wait_verdict` stays the
// contract when the wake does not happen (V1/V9 fallback).

import { sessionContext } from '../interactive/session.mjs'
import { jobIsDead, jobPath, readJob } from '../interactive/task.mjs'
import { failOpen, isRole } from './common.mjs'

const RUNNING_RE = /VERIFICATION RUNNING \(job (j-\d{14}-[0-9a-f]{6})/

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The wake-up line for a finished job (SPEC §11.8). */
export function wakeMessage(job) {
  if (job.status === 'done' && job.result) {
    return `cc-rsi: the independent verification (job ${job.id}) finished — VERDICT: ${job.result.verdict} (generation ${job.generation}). Call wait_verdict to receive the report and guidance.`
  }
  return `cc-rsi: the independent verification (job ${job.id}) finished without a verdict (infrastructure). Call wait_verdict for details.`
}

async function rewake(payload, env, { pollMs, maxMs, graceMs }) {
  let serialized = ''
  try {
    serialized = JSON.stringify(payload.tool_response ?? '')
  } catch {
    return {}
  }
  const match = RUNNING_RE.exec(serialized)
  if (!match) return {}
  const ctx = await sessionContext({ payload, env, create: false })
  if (ctx.config?.interactive?.rewake === false) return {}
  const path = jobPath(ctx.sl, match[1])
  const deadline = Date.now() + maxMs
  for (;;) {
    const job = await readJob(path)
    if (!job || job.delivered === true) return {}
    if (job.status === 'done' || job.status === 'infra') {
      // A wait_verdict in flight delivers it within moments: then no wake is needed.
      await sleep(graceMs)
      const again = await readJob(path)
      if (!again || again.delivered === true) return {}
      return { stderr: wakeMessage(again), exitCode: 2 }
    }
    if (jobIsDead(job)) {
      // wait_verdict spawns the recovery and reports the infrastructure outcome.
      return { stderr: `cc-rsi: the independent verification (job ${job.id}) stopped without a verdict (infrastructure). Call wait_verdict for details.`, exitCode: 2 }
    }
    if (Date.now() >= deadline) return {}
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

/**
 * Rewake hook entry (SPEC §11.8 module export). Additive options for tests: `pollMs` (2000),
 * `maxMs` (7100 s), `graceMs` (2000).
 */
export async function run(payload, { env = process.env, pollMs = 2000, maxMs = 7100000, graceMs = 2000 } = {}) {
  if (isRole(env)) return {}
  return failOpen('rewake', () => rewake(payload ?? {}, env, { pollMs, maxMs, graceMs }), { env })
}

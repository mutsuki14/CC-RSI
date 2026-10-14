// PostToolUse of the scheduling tools (security-1; r2-overblock-3): the scheduled-prompt ledger.
//
// A prompt the model schedules for this session (CronCreate, ScheduleWakeup, RemoteTrigger) comes
// back as a UserPromptSubmit turn; on 2.1.296 that payload has no `source`, so the prompt hook drops
// a prompt whose digest a live ledger entry holds. Entries are recorded here, after the call
// succeeded (PostToolUse does not run for a rejected or failed call), with the task id and the
// recurring flag Claude Code returns; CronDelete drops the entries of its task. The Stop hook drops
// entries of tasks no longer listed in `session_crons`, and the prompt hook consumes one-shot ones.

import { expireScheduled, recordScheduledPrompt, SCHEDULE_TOOLS } from '../interactive/requests.mjs'
import { sessionContext } from '../interactive/session.mjs'
import { failOpen, hookLogger, isRole } from './common.mjs'

const SCHEDULE = new Set(SCHEDULE_TOOLS)

/** The task id in a scheduling tool's response (CronCreate returns `{ id, humanSchedule, recurring, durable }`), or null. */
function responseField(response, key) {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const value = response[key] ?? response.data?.[key]
    return value === undefined ? null : value
  }
  return null
}

async function schedule(payload, env) {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  if (tool !== 'CronDelete' && !SCHEDULE.has(tool)) return {}
  const ctx = await sessionContext({ payload, env, create: false })
  if (tool === 'CronDelete') {
    if (typeof input.id === 'string') await expireScheduled(ctx.sl, { cronId: input.id })
    return {}
  }
  if (typeof input.prompt !== 'string' || (tool === 'ScheduleWakeup' && input.stop === true)) return {}
  const response = payload.tool_response
  const answered = responseField(response, 'recurring')
  // CronCreate recurs unless told otherwise; a wakeup or a remote trigger fires once here.
  const recurring = tool === 'CronCreate' ? (typeof answered === 'boolean' ? answered : input.recurring !== false) : false
  const id = responseField(response, 'id')
  await recordScheduledPrompt(ctx.sl, { tool, prompt: input.prompt, recurring, cronId: typeof id === 'string' ? id : null })
  hookLogger(env).info('scheduled prompt recorded', { tool, recurring, cronId: typeof id === 'string' ? id : null })
  return {}
}

/** PostToolUse (CronCreate|ScheduleWakeup|RemoteTrigger|CronDelete) hook entry. */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  return failOpen('schedule', () => schedule(payload ?? {}, env), { env })
}

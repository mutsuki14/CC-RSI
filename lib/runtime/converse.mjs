// Same-context continuation loop (SPEC §10.10).
//
// Port of dsh-rsi src/engine/converse.ts:5-33 and RSIAgent `_run_handoff_phase`
// (explore/practice_loop.py): a role phase continues in the SAME context until its handoff parses.
// No fixed retry count applies: only `actionlessLimit` consecutive replies that took no tool action
// (RSIAgent 3), or the emergency `ceiling`, end the context as transport infrastructure. A valid
// publication wins even when the reply was actionless (the handoff is read before the segment is
// judged). An output-limit turn end (max_tokens) gets the truncation continuation and is not
// counted as actionless. With an operator override for the liveness key (`explore resume`), the
// counters reset and the stall continuation is sent instead of failing.

import { TransportInfraError } from './errors.mjs'

function textOf(value, ...args) {
  return typeof value === 'function' ? value(...args) : value
}

/**
 * `converse({ first, send(message, index) → Reply, parse(reply, index) → Parsed, continuation(detail) → string,
 *   truncatedContinuation, stallContinuation, policy: {actionlessLimit = 3, ceiling = 24}, who, overrideFor(key) → boolean })`
 * → `{ value, reply, index }`. Throws TransportInfraError('transport_liveness' | 'transport_ceiling',
 * detail, {livenessKey}). `truncatedContinuation` / `stallContinuation` may be strings or functions.
 */
export async function converse({ first, send, parse, continuation, truncatedContinuation, stallContinuation, policy = {}, who = 'role',
  overrideFor = () => false } = {}) {
  if (typeof send !== 'function' || typeof parse !== 'function' || typeof continuation !== 'function') {
    throw new TypeError('converse: send, parse and continuation are required functions')
  }
  const actionlessLimit = Number.isInteger(policy.actionlessLimit) && policy.actionlessLimit > 0 ? policy.actionlessLimit : 3
  const ceiling = Number.isInteger(policy.ceiling) && policy.ceiling > 0 ? policy.ceiling : 24
  let index = 1
  let reply = await send(first, index)
  let actionless = 0
  let rounds = 0
  for (;;) {
    rounds++
    const p = await parse(reply, index)
    if (p && p.ok) return { value: p.value, reply, index }
    const detail = p && typeof p.detail === 'string' ? p.detail : 'the reply could not be parsed'
    // An output-limit turn end is continued and not counted (bounded by the ceiling so a model that
    // always truncates cannot loop forever).
    if (reply && reply.truncated && rounds < ceiling && truncatedContinuation !== undefined && truncatedContinuation !== null) {
      reply = await send(textOf(truncatedContinuation), ++index)
      continue
    }
    actionless = reply && reply.actions === 0 ? actionless + 1 : 0
    if (actionless >= actionlessLimit || rounds >= ceiling) {
      const key = `liveness@${index}`
      if (await overrideFor(key)) {
        actionless = 0
        rounds = 0
        const stall = stallContinuation !== undefined && stallContinuation !== null ? textOf(stallContinuation) : continuation(detail)
        reply = await send(stall, ++index)
        continue
      }
      if (actionless >= actionlessLimit) {
        throw new TransportInfraError('transport_liveness', `${who}: ${actionless} consecutive actionless segments without a usable handoff (${detail})`, { livenessKey: key })
      }
      throw new TransportInfraError('transport_ceiling', `${who}: emergency transport ceiling of ${ceiling} segments reached (${detail})`, { livenessKey: key })
    }
    reply = await send(continuation(detail), ++index) // SAME context (--resume)
  }
}

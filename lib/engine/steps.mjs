// Journaled handoff phases (SPEC §12.6).
//
// `journaledConverse` is RSIAgent `_run_handoff_phase` / dsh-rsi `runHandoffPhase`
// (src/engine/steps.ts:129-144) over the WP4 `converse` loop, with every send and every parse
// recorded in the op journal: a replay re-derives the same actionless/ceiling decisions from the
// recorded replies, and parse results that touch the filesystem (shape gates, fixture checks) are
// never re-observed. `freePhase` is RSIAgent `_run_free_phase`: any reply ends the phase.

import { sha256Hex } from '../core/digest.mjs'
import { stallContinuation as stallText, transportContinuation, truncatedContinuation } from '../prompts/roles.mjs'
import { formatLeads, parseLeads } from '../protocol/leads.mjs'
import { fail, ok, parseSubmit } from '../protocol/tokens.mjs'
import { converse } from '../runtime/converse.mjs'
import { TransportInfraError } from '../runtime/errors.mjs'
import { shapeGate } from '../workspace/fixtures.mjs'

/** The Actor's handoff token (RSIAgent `^STATUS: (SUBMIT)$`). */
export const ACTOR_TOKEN = 'STATUS: SUBMIT'

/** The transport policy of a lineage config (SPEC §14.2 transport.actionlessLimit / ceiling). */
export function transportPolicy(config) {
  const t = config?.transport ?? {}
  return { actionlessLimit: t.actionlessLimit ?? 3, ceiling: t.ceiling ?? 24 }
}

/**
 * Runs one role phase in the same context until its handoff parses (SPEC §12.6):
 * sends are `${prefix}/m${i}` ops, parses are `${prefix}/p${i}` ops recording the Parsed result,
 * and the liveness override for `${prefix}/liveness@<n>` is consulted on exhaustion. A
 * TransportInfraError is rethrown with `extra.pausedAt = ${prefix}/${livenessKey}`.
 * Returns `{ value, reply, index, actions }`; `actions` sums the tool actions of every reply of the
 * phase (recorded replies on replay, so it is deterministic), for RSIAgent's rule that a role which
 * acted is not stalled by its done-declaration counter (core/loop.py `dones` reset).
 */
export async function journaledConverse(j, prefix, ctx, { first, parse, continuation, stallContinuation, policy, who } = {}) {
  let actions = 0
  try {
    const result = await converse({
      first,
      send: async (message, index) => {
        const reply = await ctx.send(`${prefix}/m${index}`, message)
        if (Number.isFinite(reply?.actions) && reply.actions > 0) actions += reply.actions
        return reply
      },
      parse: (reply, index) => j.op(`${prefix}/p${index}`, 'parse', { sha: sha256Hex(String(reply?.text ?? '')) }, async () => {
        const parsed = await parse(reply)
        return parsed && parsed.ok ? { ok: true, value: parsed.value ?? null } : { ok: false, detail: String(parsed?.detail ?? 'the reply could not be used') }
      }),
      continuation,
      truncatedContinuation: () => truncatedContinuation(),
      stallContinuation: stallContinuation ?? (() => stallText({ role: 'ACTOR' })),
      policy: policy ?? { actionlessLimit: 3, ceiling: 24 },
      who: who ?? ctx.role ?? 'role',
      overrideFor: key => j.hasOverride(`${prefix}/${key}`),
    })
    return { ...result, actions }
  } catch (error) {
    if (error instanceof TransportInfraError && error.extra) {
      error.extra.pausedAt = `${prefix}/${error.extra.livenessKey}`
    }
    throw error
  }
}

/**
 * RSIAgent `_run_free_phase` (explore/practice_loop.py; dsh steps.ts learn): any reply ends the
 * phase; a truncated reply gets one truncatedContinuation, whose reply is also accepted.
 * Sends are `${prefix}/m1` (and `${prefix}/m2`). Returns the last reply.
 */
export async function freePhase(j, prefix, ctx, message) {
  const reply = await ctx.send(`${prefix}/m1`, message)
  if (reply && reply.truncated) return ctx.send(`${prefix}/m2`, truncatedContinuation())
  return reply
}

/**
 * dsh `shapeProblem` (lineage.ts:259-262) on top of RSIAgent's shape gate: the owned project root
 * must stay non-empty and hold only regular files and directories.
 */
export async function shapeProblem(root) {
  const problem = await shapeGate(root)
  return problem === null ? null : `the project root must stay nonempty and hold only regular files and directories (${problem})`
}

/** Parse of an Actor work/repair handoff: a standalone STATUS: SUBMIT line and a valid project root. */
export async function parseActorHandoff(reply, root) {
  const parsed = parseSubmit(String(reply?.text ?? ''))
  if (!parsed.ok) return parsed
  const problem = await shapeProblem(root)
  return problem ? fail(problem) : ok({ body: parsed.value.body })
}

/**
 * Parse of an evidence-round handoff after UNVERIFIED (dsh lineage.ts:365-369): STATUS: SUBMIT, a
 * valid root, and well-formed CLAIM/PROBE pairs. `leads` is the formatted LEAD blocks only: the
 * Actor's narrative never reaches the Verifier (J1-3).
 */
export async function parseEvidenceHandoff(reply, root) {
  const parsed = await parseActorHandoff(reply, root)
  if (!parsed.ok) return parsed
  const scan = parseLeads(parsed.value.body)
  if (scan.problems.length > 0) return fail(scan.problems.join('; '))
  return ok({ body: parsed.value.body, leads: formatLeads(scan.leads) })
}

/** The Actor transport continuation with the STATUS: SUBMIT token (RSIAgent practice_loop.py:501). */
export function actorContinuation(detail) {
  return transportContinuation({ role: 'ACTOR', detail, token: ACTOR_TOKEN })
}

/** The Actor stall continuation (liveness override) with the STATUS: SUBMIT token. */
export function actorStall() {
  return stallText({ role: 'ACTOR', token: ACTOR_TOKEN })
}

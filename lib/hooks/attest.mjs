// PreToolUse attestation for the cc-rsi MCP tools (SPEC §11.4, §11.8 `attest`; J1-1).
// Matcher `^mcp__plugin_cc-rsi_rsi__`. Writes `<home>/run/att/<tool_use_id>.json`; no decision and
// no output (the user's permission settings still apply). Inside a role child it DENIES: role
// children never load the plugin (R5), so this is defence in depth.
//
// Before the attestation is written (the MCP server reads session.json once it has taken it), a
// session whose model no hook reported gets it from the transcript tail (cc-integration-3), so an
// inheriting Verifier runs on the session's model rather than Claude Code's default.

import { ccRsiHome, globalLayout } from '../core/paths.mjs'
import { writeAttestation } from '../interactive/attest.mjs'
import { recordTranscriptModel, refreshPluginOptions, sessionContext } from '../interactive/session.mjs'
import { denyPre, failOpen, hookLogger, isRole } from './common.mjs'

export const ROLE_DENY_REASON = 'cc-rsi tools are not available inside role contexts'

/**
 * Session facts the MCP server reads from session.json (best effort: never delays or prevents the
 * attestation on error): the plugin options the hooks see now (r2-interactive-4), and the model from
 * the transcript when no hook reported it.
 */
async function sessionFacts(payload, env) {
  let ctx
  try {
    ctx = await sessionContext({ payload, env, create: false })
  } catch (error) {
    hookLogger(env).warn('session context unavailable for the attestation', { error: error?.message })
    return
  }
  try {
    if (await refreshPluginOptions(ctx, env)) hookLogger(env).info('plugin options changed mid-session; recorded', { sessionId: ctx.sid })
  } catch (error) {
    hookLogger(env).warn('plugin options not recorded', { error: error?.message })
  }
  if (typeof payload.transcript_path !== 'string' || payload.transcript_path === '') return
  if (typeof payload.agent_id === 'string' && payload.agent_id !== '') return
  try {
    await recordTranscriptModel(ctx, payload.transcript_path)
  } catch (error) {
    hookLogger(env).warn('session model from the transcript failed', { error: error?.message })
  }
}

/** Attestation hook entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return { stdout: denyPre(ROLE_DENY_REASON) }
  return failOpen('attest', async () => {
    const p = payload ?? {}
    await sessionFacts(p, env)
    await writeAttestation(globalLayout(ccRsiHome(env)).att, p)
    return {}
  }, { env })
}

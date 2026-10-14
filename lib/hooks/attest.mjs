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
import { recordTranscriptModel, sessionContext } from '../interactive/session.mjs'
import { denyPre, failOpen, hookLogger, isRole } from './common.mjs'

export const ROLE_DENY_REASON = 'cc-rsi tools are not available inside role contexts'

/** Session model from the transcript (best effort: never delays or prevents the attestation on error). */
async function sessionModel(payload, env) {
  if (typeof payload.transcript_path !== 'string' || payload.transcript_path === '') return
  if (typeof payload.agent_id === 'string' && payload.agent_id !== '') return
  try {
    const ctx = await sessionContext({ payload, env, create: false })
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
    await sessionModel(p, env)
    await writeAttestation(globalLayout(ccRsiHome(env)).att, p)
    return {}
  }, { env })
}

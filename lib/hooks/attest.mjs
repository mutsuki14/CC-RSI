// PreToolUse attestation for the cc-rsi MCP tools (SPEC §11.4, §11.8 `attest`; J1-1).
// Matcher `^mcp__plugin_cc-rsi_rsi__`. Writes `<home>/run/att/<tool_use_id>.json`; no decision and
// no output (the user's permission settings still apply). Inside a role child it DENIES: role
// children never load the plugin (R5), so this is defence in depth.

import { ccRsiHome, globalLayout } from '../core/paths.mjs'
import { writeAttestation } from '../interactive/attest.mjs'
import { denyPre, failOpen, isRole } from './common.mjs'

export const ROLE_DENY_REASON = 'cc-rsi tools are not available inside role contexts'

/** Attestation hook entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return { stdout: denyPre(ROLE_DENY_REASON) }
  return failOpen('attest', async () => {
    await writeAttestation(globalLayout(ccRsiHome(env)).att, payload ?? {})
    return {}
  }, { env })
}

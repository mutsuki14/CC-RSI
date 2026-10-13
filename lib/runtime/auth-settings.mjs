// Forwarded user-scope auth/provider settings (SPEC §10.4, J2-2).
//
// `--restricted` ignores the user settings file (cli-reference:125), so a user who authenticates
// through `apiKeyHelper` or provider `env` entries in ~/.claude/settings.json would see every role
// child fail with an auth error. These keys are copied into each child's --settings file instead.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isPassName } from './env.mjs'
import { claudeConfigDir } from './models.mjs'

/** Top-level user settings keys forwarded verbatim (SPEC §10.4). */
export const FORWARDED_KEYS = Object.freeze(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod', 'forceLoginOrgUUID'])

/**
 * Reads `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` and returns the forwarded subset:
 * FORWARDED_KEYS when present, and `env` entries whose names pass the child env PASS list
 * (and are not on NEVER). A missing or malformed file yields `{}`. `passthrough` (global
 * `children.envPassthrough`) widens the env filter exactly as for the child environment.
 */
export async function forwardedUserSettings({ env = process.env, passthrough = [] } = {}) {
  let settings
  try {
    settings = JSON.parse(await readFile(join(claudeConfigDir(env), 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {}
  const out = {}
  for (const key of FORWARDED_KEYS) {
    const value = settings[key]
    if (value !== undefined && value !== null && (typeof value !== 'object' || !Array.isArray(value))) out[key] = value
  }
  if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
    const forwardedEnv = {}
    for (const [name, value] of Object.entries(settings.env)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      if (isPassName(name, passthrough)) forwardedEnv[name] = String(value)
    }
    if (Object.keys(forwardedEnv).length > 0) out.env = forwardedEnv
  }
  return out
}

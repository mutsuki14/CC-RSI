// Model resolution for role children (SPEC §10.3, J2-8).
//
// `--restricted` children ignore user settings files (cli-reference:125), so the model a child
// runs on must be chosen explicitly. Light module: hooks import it (SPEC §3), so it uses node:*
// only.

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `${CLAUDE_CONFIG_DIR:-~/.claude}` for the given environment. */
export function claudeConfigDir(env = process.env) {
  const configured = env?.CLAUDE_CONFIG_DIR
  if (typeof configured === 'string' && configured !== '') return configured
  const home = typeof env?.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir()
  return join(home, '.claude')
}

/** The `model` string of a parsed settings object, or null. */
function modelOf(settings) {
  const model = settings && typeof settings === 'object' ? settings.model : undefined
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : null
}

/** `model` from the user-scope `<configDir>/settings.json`, or null (missing, malformed or unset). */
export async function userSettingsModel(env = process.env) {
  try {
    return modelOf(JSON.parse(await readFile(join(claudeConfigDir(env), 'settings.json'), 'utf8')))
  } catch {
    return null
  }
}

/** Synchronous `userSettingsModel` for hooks. */
export function userSettingsModelSync(env = process.env) {
  try {
    return modelOf(JSON.parse(readFileSync(join(claudeConfigDir(env), 'settings.json'), 'utf8')))
  } catch {
    return null
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Resolution chain (SPEC §10.3):
 *  1. `configured`, unless empty or `inherit`              → source 'config'
 *  2. `sessionModel` (session.json; SessionStart/PostModelSwitch) → 'session'
 *  3. `ANTHROPIC_MODEL`                                     → 'env'
 *  4. `userSettingsModel` (the value read from settings.json) → 'user-settings'
 *  5. null: omit --model so Claude Code uses its default     → 'default'
 */
export function resolveModel(configured, { sessionModel, env = process.env, userSettingsModel: fromSettings } = {}) {
  const c = nonEmpty(configured)
  if (c !== null && c.toLowerCase() !== 'inherit') return { model: c, source: 'config' }
  const s = nonEmpty(sessionModel)
  if (s !== null) return { model: s, source: 'session' }
  const e = nonEmpty(env?.ANTHROPIC_MODEL)
  if (e !== null) return { model: e, source: 'env' }
  const u = nonEmpty(fromSettings)
  if (u !== null) return { model: u, source: 'user-settings' }
  return { model: null, source: 'default' }
}

/** The resolved model string, or '(default)' when Claude Code's default applies (SPEC §10.3). */
export function effective(model) {
  return typeof model === 'string' && model !== '' ? model : '(default)'
}

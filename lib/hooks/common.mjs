// Shared helpers of the main-session hooks (SPEC §11.8 "Common rules").
//
// Main-session hooks fail open: any exception is logged to `<home>/logs/hooks.log` and the hook
// exits 0 without output, so a cc-rsi bug never blocks the user's session (the exceptions that
// fail closed are spelled out where they apply). Inside a role child (`CC_RSI_ROLE` set) every
// main-session hook is a no-op, except `attest`, which denies. A hook prints at most one JSON
// object and never spawns `claude`.

import { createLogger } from '../core/log.mjs'
import { ccRsiHome, globalLayout } from '../core/paths.mjs'

/** The dispatcher's subcommands (hooks/hook.mjs <sub> → lib/hooks/<sub>.mjs). */
export const SUBS = Object.freeze(['session-start', 'prompt', 'guard', 'attest', 'rewake', 'schedule', 'stop', 'model', 'session-end'])

/** Measured budgets (SPEC §11.8): a slower run is logged (the hook still answers). */
export const BUDGET_MS = Object.freeze({ guard: 150, attest: 150, 'session-start': 400, prompt: 400 })

/** Reads all of stdin and parses it as one JSON object; null on any failure (the hook then exits 0). */
export async function readStdinJson(stream = process.stdin) {
  try {
    const chunks = []
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Whether this process runs inside a cc-rsi role child. */
export function isRole(env = process.env) {
  return typeof env?.CC_RSI_ROLE === 'string' && env.CC_RSI_ROLE !== ''
}

/** The hooks logger (`<home>/logs/hooks.log`; never stdout). */
export function hookLogger(env = process.env) {
  return createLogger(globalLayout(ccRsiHome(env)).hooksLog, 'hooks')
}

/**
 * Runs `fn` and returns its `{ stdout?, stderr?, exitCode? }`; any exception is logged and becomes
 * `{}` (exit 0, no output). Runs slower than the sub's budget are logged with their duration.
 */
export async function failOpen(sub, fn, { env = process.env } = {}) {
  const started = Date.now()
  try {
    const out = await fn()
    const ms = Date.now() - started
    const budget = BUDGET_MS[sub]
    if (budget && ms > budget) hookLogger(env).warn('hook over budget', { sub, ms, budget })
    return out && typeof out === 'object' ? out : {}
  } catch (error) {
    hookLogger(env).error('hook failed (fail open)', { sub, error })
    return {}
  }
}

/** PreToolUse deny output (main session only). */
export function denyPre(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(reason) } }
}

/** PreToolUse allow output (main session only: suppresses the permission prompt for the memory view and draft [U]). */
export function allowPre(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: String(reason) } }
}

/** `{hookSpecificOutput: {hookEventName, additionalContext}}`. */
export function contextOutput(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext: String(additionalContext) } }
}

// Outcome classification of one role invocation (SPEC §10.8). The first matching row wins.
//
// Every invocation is classified before any parse (SPEC §2 trust boundary 3): infrastructure never
// becomes PASS/FAIL. Evidence: F3 (`subtype:"success"` with `is_error:true`, api_error_status 404),
// F7 (`num_turns:0`, no assistant event after a UserPromptSubmit block), R3/R4 (session errors),
// EXP f2 (`sandbox required but unavailable`). RSIAgent analogue: the transport/infra split of
// `_run_handoff_phase` (explore/practice_loop.py) — infra pauses instead of grading.

import { sameText, truncated as isTruncated } from './stream.mjs'

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 529])
const TRANSIENT_ERRORS = new Set(['overloaded', 'rate_limit', 'server_error', 'timeout', 'connection', 'api_connection', 'connection_error'])
const AUTH_STATUS = new Set([401, 402, 403])
const AUTH_ERRORS = new Set(['authentication_failed', 'billing_error', 'authentication', 'permission', 'billing'])
const CONFIG_STATUS = new Set([400, 404, 422])
const CONFIG_ERRORS = new Set(['model_not_found', 'not_found', 'invalid_request'])
const OVERFLOW_TEXT = /prompt is too long|context (length|window)/i

/** `rate_limit_error` → `rate_limit` (the API's `*_error` type names and Claude Code's short names). */
function normError(e) {
  if (typeof e !== 'string' || e === '') return null
  return e.toLowerCase().replace(/_error$/, '')
}

function lastLine(text, max = 400) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const line = lines[lines.length - 1] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function matchingLine(text, re, max = 400) {
  const line = String(text ?? '').split(/\r?\n/).find(l => re.test(l)) ?? ''
  const t = line.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function apiFacts(ps) {
  const r = ps?.result ?? null
  const status = Number.isInteger(r?.api_error_status) ? r.api_error_status : null
  const errors = new Set() // raw and normalised names, for matching
  const raw = new Set() // raw names, for details
  const add = e => {
    const n = normError(e)
    if (n) {
      errors.add(e.toLowerCase())
      errors.add(n)
      raw.add(e)
    }
  }
  for (const m of ps?.assistantMessages ?? []) add(m.error)
  for (const e of Array.isArray(r?.errors) ? r.errors : []) {
    if (typeof e === 'string' && /^[a-z_]+$/.test(e)) add(e)
  }
  const text = [r?.result, ...(Array.isArray(r?.errors) ? r.errors : []), ...(ps?.assistantMessages ?? []).filter(m => m.apiError).flatMap(m => m.blocks.map(b => b.text))]
    .filter(t => typeof t === 'string').join('\n')
  return { status, errors, raw, text }
}

function hasAny(set, values) {
  for (const v of values) if (set.has(v)) return true
  return false
}

function describeApi(status, names) {
  const parts = []
  if (status !== null) parts.push(`HTTP ${status}`)
  if (names.size > 0) parts.push([...names].join(', '))
  return parts.length > 0 ? parts.join(' ') : 'no status'
}

/**
 * `{ cls, infra, detail, reply?, warnings }` for one invocation (SPEC §10.8; `warnings` is extra).
 * Inputs: `spawnError` (an Error with `code`), `exitCode`, `signal`, `killedBy` ('watchdog' | 'stop'
 * | null), `stderr` (tail), `ps` (parseStream), `attestation` (hookAttestation).
 */
export function classify({ spawnError = null, exitCode = null, signal = null, killedBy = null, stderr = '', ps = null, attestation = null } = {}) {
  const warnings = []
  const out = (cls, detail, extra = {}) => ({ cls, infra: cls !== 'reply', detail, warnings, ...extra })
  const init = ps?.init ?? null
  const result = ps?.result ?? null
  const err = String(stderr ?? '')
  const exitText = signal ? `signal ${signal}` : `exit code ${exitCode}`
  const model = init?.model ?? null

  // 1-3: harness-side outcomes.
  if (killedBy === 'watchdog') return out('timeout', `the role invocation exceeded its wall-clock watchdog and was stopped (${exitText})`)
  if (killedBy === 'stop') return out('interrupted', 'the harness stopped the role invocation')
  if (spawnError) return out('spawn', `could not start claude: ${spawnError.code ?? ''} ${spawnError.message ?? spawnError}`.replace(/\s+/g, ' ').trim())

  // 4: sandbox gate (EXP f2: exit 1 before any model call).
  if (!init && /sandbox required but unavailable/i.test(err)) {
    return out('sandbox_unavailable', matchingLine(err, /sandbox required but unavailable/i) || 'sandbox required but unavailable')
  }
  // 5: R4 — a reused --session-id.
  if (/Session ID .* is already in use/i.test(err)) {
    return out('session_conflict', `${matchingLine(err, /Session ID .* is already in use/i)} (cc-rsi never reuses a session id; this is an internal error)`)
  }
  // 6: R3 — --resume of a transcript that does not exist.
  const errorsList = Array.isArray(result?.errors) ? result.errors.filter(e => typeof e === 'string') : []
  const missing = errorsList.find(e => /No conversation found/i.test(e))
  if (missing) return out('session_missing', missing)
  // 7: the CLI rejected its arguments.
  if ((ps?.events ?? 0) === 0 && /unknown option|error: /i.test(err)) {
    return out('cli_incompatible', `claude rejected the role command line (${matchingLine(err, /unknown option|error: /i) || lastLine(err)}); run cc-rsi doctor`)
  }
  // 8-10: isolation (fail closed).
  if (init) {
    if (init.mcpServers.length > 0) return out('isolation_violation', `the role child loaded MCP servers (${init.mcpServers.map(s => s?.name ?? String(s)).join(', ')}); role children must run with none`)
    const mcpTool = init.tools.find(t => t.startsWith('mcp__'))
    if (mcpTool) return out('isolation_violation', `the role child exposed the MCP tool ${mcpTool}; role children must run without MCP tools`)
    if (init.permissionMode !== 'dontAsk') return out('isolation_violation', `the role child ran in permission mode ${init.permissionMode ?? '(unknown)'} instead of dontAsk`)
  }
  if (attestation?.promptBlocked) return out('isolation_violation', 'the role guard blocked the harness message (the prompt digest did not match); the reply was discarded unparsed')
  if (init && result && !attestation?.hooksRan) {
    return out('hooks_not_run', 'the role hooks did not run (no UserPromptSubmit guard entry for this message); hooks may be disabled by managed settings (allowManagedHooksOnly/disableAllHooks)')
  }

  // 11-14: API errors reported in the result.
  if (result && result.is_error === true) {
    const { status, errors, raw, text } = apiFacts(ps)
    const transientStatus = status !== null && (TRANSIENT_STATUS.has(status) || (status >= 500 && status <= 599))
    if (transientStatus || hasAny(errors, TRANSIENT_ERRORS)) {
      return out('transient', `transient API error (${describeApi(status, raw)})`, { status })
    }
    if ((status !== null && AUTH_STATUS.has(status)) || hasAny(errors, AUTH_ERRORS)) {
      return out('auth', `the role child could not authenticate (${describeApi(status, raw)}); log in again or check apiKeyHelper (forwarded from ~/.claude/settings.json); run cc-rsi doctor --live`, { status })
    }
    if (status === 413 || errors.has('context_length_exceeded') || errors.has('prompt_too_long') || OVERFLOW_TEXT.test(text)) {
      return out('context_overflow', `the role context exceeded the model's context window (${describeApi(status, raw)})`, { status })
    }
    if ((status !== null && CONFIG_STATUS.has(status)) || hasAny(errors, CONFIG_ERRORS)) {
      return out('config', `the API rejected the request for model ${model ?? '(default)'} (${describeApi(status, raw)}); check the configured model`, { status })
    }
  }
  // 15-18: result subtypes.
  if (result?.subtype === 'error_max_budget_usd') return out('budget', 'the per-message cost budget (--max-budget-usd) was reached')
  if (result?.subtype === 'error_max_turns') return out('ceiling', 'the role invocation reached its emergency turn ceiling')
  if (result && (result.stop_reason === 'refusal' || (Number.isFinite(result.safety_stops) && result.safety_stops > 0))) {
    return out('refusal', 'the model refused or a safety stop ended the turn; this is never a verdict')
  }
  if (result && (result.is_error === true || (typeof result.subtype === 'string' && result.subtype.startsWith('error_')))) {
    const { status, raw } = apiFacts(ps)
    const what = [result.subtype, describeApi(status, raw), ...errorsList].filter(Boolean).join('; ')
    return out('error', `the role invocation ended with an error (${what})`)
  }
  // 19-20: no result at all.
  if (!result && exitCode !== 0) return out('crash', `claude exited without a result (${exitText})${err.trim() ? `: ${lastLine(err)}` : ''}`)
  if (!result) return out('protocol', 'claude exited cleanly without a result event')
  // 21: F7 — no model reply (the result text may echo our own prompt and is never parsed).
  if (result.num_turns === 0 || !init || (ps?.assistantMessages?.length ?? 0) === 0) {
    return out('no_reply', 'the invocation produced no assistant reply (num_turns 0 or no assistant message); its result text is not parsed')
  }
  // 22: a reply.
  const text = ps.finalText
  if (typeof result.result === 'string' && !sameText(result.result, text)) {
    warnings.push('result.result differs from the final assistant message; the final assistant message is used')
  }
  const last = ps.assistantMessages[ps.assistantMessages.length - 1]
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials.length : 0
  return out('reply', 'reply', {
    reply: {
      text,
      actions: ps.actions,
      truncated: isTruncated(ps),
      stopReason: typeof result.stop_reason === 'string' ? result.stop_reason : (last?.stopReason ?? null),
      model: init.model ?? last?.model ?? null,
      costUsdTotal: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
      numTurns: Number.isFinite(result.num_turns) ? result.num_turns : null,
      permissionDenials: denials,
    },
  })
}

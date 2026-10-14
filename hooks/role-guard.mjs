#!/usr/bin/env node
// Role-child hook: `node hooks/role-guard.mjs <prompt|tool|post|pin>` (SPEC §10.6).
//
// Installed only through a role child's --settings file (never through hooks/hooks.json). It
// reads the hook payload on stdin and CC_RSI_POLICY / CC_RSI_GUARD_LOG / CC_RSI_EXPECT from the
// environment, appends one guard-log line BEFORE writing any output (the runtime uses those lines
// as proof the hooks ran, SPEC §10.7), and fails closed:
//  - `prompt`: blocks every message whose sha256 differs from CC_RSI_EXPECT (roles hear only the
//    harness; R2/F6 showed the payload prompt is byte-identical to stdin);
//  - `tool`: denies tools outside the role, hidden paths, reads outside the role's roots, writes
//    outside its write roots, and Bash commands rejected by lib/guard/bash.mjs; any exception
//    prints a deny; it NEVER prints permissionDecision "allow" (F5: a hook allow overrides dontAsk);
//  - `post`: RSIAgent's REPEAT liveness note (core/actor.py:267 REPEAT_WARNING), never blocking;
//  - `pin`: re-pins the verbatim task after a compaction (RSIAgent core/loop.py:970 task pin).
// Imports only lib/core and lib/guard (SPEC §3) and must start in < 80 ms (SPEC §18 WP4).

import { readFileSync, writeSync } from 'node:fs'
import { readJsonSafeSync, writeJsonAtomicSync } from '../lib/core/atomic.mjs'
import { sha256Hex } from '../lib/core/digest.mjs'
import { appendJsonlSync } from '../lib/core/jsonl.mjs'
import { coversHiddenReason, hiddenReason, scanBash } from '../lib/guard/bash.mjs'
import { canonicalRoot, isFileTool, isUnder, searchCoversHidden, toolPathArgs } from '../lib/guard/paths.mjs'

const PIN_LIMIT = 9000
const FOREIGN_REASON = 'cc-rsi: messages from outside the harness are refused'

function emit(object) {
  let text = JSON.stringify(object)
  // Belt and braces (F5): this hook must never grant a permission.
  if (/"permissionDecision"\s*:\s*"allow"/.test(text)) {
    text = JSON.stringify(denyJson('cc-rsi: role guard internal error (an allow decision was suppressed)'))
  }
  writeSync(1, text)
}

function denyJson(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(reason) } }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch (error) {
    if (error?.code === 'EAGAIN' || error?.code === 'EOF') return ''
    throw error
  }
}

/** Appends a guard-log entry. Throws when the log is not configured or not writable (callers fail closed). */
function log(entry) {
  const file = process.env.CC_RSI_GUARD_LOG
  if (typeof file !== 'string' || file === '') throw new Error('CC_RSI_GUARD_LOG is not set')
  appendJsonlSync(file, { ts: new Date().toISOString(), pid: process.pid, ...entry })
}

function tryLog(entry) {
  try {
    log(entry)
    return true
  } catch {
    return false
  }
}

function loadPolicy() {
  const file = process.env.CC_RSI_POLICY
  if (typeof file !== 'string' || file === '') throw new Error('CC_RSI_POLICY is not set')
  const policy = JSON.parse(readFileSync(file, 'utf8'))
  if (!policy || typeof policy !== 'object' || policy.v !== 1) throw new Error('the role policy is malformed')
  return policy
}

function parsePayload(raw) {
  const payload = JSON.parse(raw)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('the hook payload is not a JSON object')
  return payload
}

/** Lexical and physical spellings of configured roots. */
function roots(list) {
  const out = []
  for (const r of Array.isArray(list) ? list : []) {
    if (typeof r !== 'string' || r === '') continue
    out.push(r)
    try {
      const c = canonicalRoot(r)
      if (c !== r) out.push(c)
    } catch { /* keep the lexical form */ }
  }
  return out
}

const underAny = (p, list) => list.some(r => isUnder(p, r))

// ---------------------------------------------------------------- modes

function promptMode(raw) {
  let digest = null
  try {
    const payload = parsePayload(raw)
    if (typeof payload.prompt !== 'string') throw new Error('the payload has no prompt')
    digest = sha256Hex(payload.prompt)
    let guardOn = true
    try {
      guardOn = loadPolicy().foreignMessageGuard !== false
    } catch {
      guardOn = true // an unreadable policy never disables the filter
    }
    const expect = process.env.CC_RSI_EXPECT
    if ((typeof expect === 'string' && expect !== '' && digest === expect) || !guardOn) {
      log({ hook: 'prompt', decision: 'pass', digest })
      return 0
    }
    log({ hook: 'prompt', decision: 'block', digest })
    emit({ decision: 'block', reason: FOREIGN_REASON })
    return 0
  } catch (error) {
    tryLog({ hook: 'prompt', decision: 'block', digest, error: String(error?.message ?? error) })
    emit({ decision: 'block', reason: FOREIGN_REASON })
    return 0
  }
}

/** The deny reason for one PreToolUse payload, or null to pass. Throws on internal errors. */
function toolDecision(policy, payload) {
  const tool = payload.tool_name
  if (typeof tool !== 'string' || tool === '') return 'cc-rsi: malformed tool call (no tool name)'
  const tools = Array.isArray(policy.tools) ? policy.tools : []
  if (!tools.includes(tool)) return `${tool} is not available to this role`
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const cwd = typeof payload.cwd === 'string' && payload.cwd.startsWith('/') ? payload.cwd : policy.cwd
  const hidden = roots(policy.hidden)
  if (isFileTool(tool)) {
    const { paths, search, write, invalid } = toolPathArgs(tool, input, cwd, { userHome: policy.userHome })
    if (invalid) return `cc-rsi: ${invalid}`
    const readRoots = roots(policy.readRoots)
    const writeRoots = roots(policy.writeRoots)
    const readOnly = roots(policy.readOnlyRoots)
    const own = roots(policy.allowedPaths)
    for (const p of paths) {
      // A role's own directories stay usable even when a broader hidden root contains them (PF §6.2).
      if (underAny(p, hidden) && !underAny(p, own)) return hiddenReason(p)
      if (search && searchCoversHidden(p, hidden) !== null) return coversHiddenReason(p)
      if (!underAny(p, readRoots)) return `${p} is outside the directories available to this role.`
      if (write && (!underAny(p, writeRoots) || underAny(p, readOnly))) return `${p} is not writable by this role.`
    }
    return null
  }
  if (tool === 'Bash') {
    return scanBash(typeof input.command === 'string' ? input.command : null, {
      hidden: policy.hidden,
      hiddenTokens: policy.hiddenTokens,
      allowedPaths: policy.allowedPaths,
      home: policy.home ?? undefined,
      userHome: policy.userHome ?? undefined,
      recursionGuard: policy.recursionGuard !== false,
      bashDeny: policy.bashDeny,
      cwd,
      // A recursive command rooted above a hidden root gets the same reason as a Grep/Glob search (security-6).
      coversReason: path => coversHiddenReason(path),
    })
  }
  return null
}

function toolMode(raw) {
  let toolUseId = null
  let tool = null
  try {
    const payload = parsePayload(raw)
    toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null
    tool = typeof payload.tool_name === 'string' ? payload.tool_name : null
    let reason
    try {
      reason = toolDecision(loadPolicy(), payload)
    } catch (error) {
      reason = `cc-rsi: role guard could not evaluate this call (${String(error?.message ?? error)}); refused (fail closed)`
    }
    if (reason === null) {
      log({ hook: 'tool', toolUseId, tool, decision: 'pass' })
      return 0
    }
    log({ hook: 'tool', toolUseId, tool, decision: 'deny', reason })
    emit(denyJson(reason))
    return 0
  } catch (error) {
    const reason = `cc-rsi: role guard error (${String(error?.message ?? error)}); refused (fail closed)`
    tryLog({ hook: 'tool', toolUseId, tool, decision: 'deny', reason })
    emit(denyJson(reason))
    return 0
  }
}

function postMode(raw) {
  try {
    const payload = parsePayload(raw)
    const policy = loadPolicy()
    if (policy.liveness !== true) return 0
    const tool = String(payload.tool_name ?? '')
    // RSIAgent compares the program itself (core/actor.py REPEAT_WARNING): the model-written Bash
    // `description` is cosmetic and differs between otherwise identical calls (WP4 probe), so it is ignored.
    const input = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
      ? Object.fromEntries(Object.entries(payload.tool_input).filter(([k]) => k !== 'description'))
      : payload.tool_input ?? null
    const key = sha256Hex(tool + JSON.stringify(input))
    const out = sha256Hex(JSON.stringify(payload.tool_response ?? null))
    const statePath = `${process.env.CC_RSI_GUARD_LOG}.liveness.json`
    const prev = readJsonSafeSync(statePath, {}) ?? {}
    const repeat = prev.key === key && prev.out === out
    const addRevisit = repeat && typeof policy.stagnationRevisit === 'string' && policy.stagnationRevisit !== '' && prev.stagnationSent !== true
    writeJsonAtomicSync(statePath, { key, out, stagnationSent: prev.stagnationSent === true || addRevisit })
    log({ hook: 'post', toolUseId: payload.tool_use_id ?? null, tool, repeat })
    if (repeat && typeof policy.repeatWarning === 'string' && policy.repeatWarning !== '') {
      const text = policy.repeatWarning + (addRevisit ? policy.stagnationRevisit : '')
      emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
    }
  } catch {
    // Liveness notes never block and never fail a tool.
  }
  return 0
}

function pinMode() {
  try {
    const policy = loadPolicy()
    if (typeof policy.pinFile !== 'string' || policy.pinFile === '') {
      tryLog({ hook: 'pin', pinned: false })
      return 0
    }
    const text = readFileSync(policy.pinFile, 'utf8').slice(0, PIN_LIMIT)
    log({ hook: 'pin', pinned: true })
    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
  } catch (error) {
    tryLog({ hook: 'pin', pinned: false, error: String(error?.message ?? error) })
  }
  return 0
}

function main() {
  const mode = process.argv[2]
  let raw = ''
  try {
    raw = readStdin()
  } catch {
    raw = ''
  }
  switch (mode) {
    case 'prompt': return promptMode(raw)
    case 'tool': return toolMode(raw)
    case 'post': return postMode(raw)
    case 'pin': return pinMode()
    default:
      process.stderr.write(`cc-rsi role-guard: unknown mode ${JSON.stringify(mode)}\n`)
      return 2
  }
}

let code = 2
try {
  code = main()
} catch (error) {
  // Last resort: a PreToolUse caller still gets a deny, any other caller a blocking exit.
  try {
    if (process.argv[2] === 'tool') emit(denyJson(`cc-rsi: role guard crashed (${String(error?.message ?? error)})`))
    else if (process.argv[2] === 'prompt') emit({ decision: 'block', reason: FOREIGN_REASON })
    code = process.argv[2] === 'tool' || process.argv[2] === 'prompt' ? 0 : 2
  } catch {
    code = 2
  }
}
process.exitCode = code

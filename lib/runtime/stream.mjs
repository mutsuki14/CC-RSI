// stream-json parser and hook attestation (SPEC §10.7).
//
// Shapes verified on 2.1.296 (proposal-fidelity F1/F3/F7, proposal-robust R3):
//  - every `assistant` event carries ONE content block; events of one model message share
//    `message.id` (F1), so tool_use blocks are countable and messages are regrouped by id;
//  - `result.result` may carry synthetic API-error text with `subtype:"success"` (F3) or echo the
//    harness prompt after a UserPromptSubmit block (F7): reply text therefore comes ONLY from the
//    final assistant message (J1-7, J2-1).

/**
 * ParsedStream = {
 *   init: {sessionId, model, tools, mcpServers, permissionMode, ccVersion} | null,
 *   assistantMessages: [{ id, blocks, stopReason, model, error, apiError }],  // top-level only, grouped by id, in order
 *   finalText, actions, toolUses: [{id, name}], toolResultIds,
 *   result, informational, hookResponses, compacted, badLines, events }
 */
export function parseStream(lines) {
  const ps = {
    init: null,
    assistantMessages: [],
    finalText: '',
    actions: 0,
    toolUses: [],
    toolResultIds: [],
    result: null,
    informational: [],
    hookResponses: [],
    compacted: false,
    badLines: 0,
    events: 0,
  }
  const byId = new Map()
  let anon = 0
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (typeof raw !== 'string') continue
    const line = raw.trim()
    if (line === '') continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      ps.badLines++
      continue
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      ps.badLines++
      continue
    }
    ps.events++
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          if (ps.init === null) {
            ps.init = {
              sessionId: typeof ev.session_id === 'string' ? ev.session_id : null,
              model: typeof ev.model === 'string' ? ev.model : null,
              tools: Array.isArray(ev.tools) ? ev.tools.filter(t => typeof t === 'string') : [],
              mcpServers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [],
              permissionMode: typeof ev.permissionMode === 'string' ? ev.permissionMode : null,
              ccVersion: typeof ev.claude_code_version === 'string' ? ev.claude_code_version : null,
            }
          }
        } else if (ev.subtype === 'informational') {
          ps.informational.push(ev)
        } else if (ev.subtype === 'hook_response') {
          ps.hookResponses.push(ev)
        } else if (typeof ev.subtype === 'string' && /compact/i.test(ev.subtype)) {
          ps.compacted = true
        }
        break
      case 'assistant': {
        if (ev.parent_tool_use_id !== null && ev.parent_tool_use_id !== undefined) break // subagent traffic
        const message = ev.message && typeof ev.message === 'object' ? ev.message : {}
        const id = typeof message.id === 'string' && message.id !== '' ? message.id : `anon-${anon++}`
        let entry = byId.get(id)
        if (!entry) {
          entry = { id, blocks: [], stopReason: null, model: null, error: null, apiError: false }
          byId.set(id, entry)
          ps.assistantMessages.push(entry)
        }
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!block || typeof block !== 'object') continue
          entry.blocks.push(block)
          if (block.type === 'tool_use') {
            ps.actions++
            ps.toolUses.push({ id: typeof block.id === 'string' ? block.id : null, name: typeof block.name === 'string' ? block.name : null })
          }
        }
        if (typeof message.stop_reason === 'string') entry.stopReason = message.stop_reason
        if (typeof message.model === 'string') entry.model = message.model
        if (typeof ev.error === 'string') entry.error = ev.error
        if (ev.is_api_error_message === true || ev.isApiErrorMessage === true) entry.apiError = true
        break
      }
      case 'user': {
        if (ev.parent_tool_use_id !== null && ev.parent_tool_use_id !== undefined) break
        const content = ev.message?.content
        for (const block of Array.isArray(content) ? content : []) {
          if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') ps.toolResultIds.push(block.tool_use_id)
        }
        break
      }
      case 'result':
        ps.result = ev
        break
      default:
        break
    }
  }
  const last = ps.assistantMessages[ps.assistantMessages.length - 1]
  if (last) {
    ps.finalText = last.blocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
  }
  return ps
}

/** Whether the invocation ended at the output limit (SPEC §10.7). */
export function truncated(ps) {
  if (ps?.result?.stop_reason === 'max_tokens') return true
  const last = ps?.assistantMessages?.[ps.assistantMessages.length - 1]
  return last?.stopReason === 'max_tokens'
}

/** Whitespace-normalised comparison used for the `result.result` vs final-text warning (F3/F7). */
export function sameText(a, b) {
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim()
  return norm(a) === norm(b)
}

/**
 * Hook attestation from this invocation's guard-log entries (SPEC §10.7):
 *  - `hooksRan`: a `{hook:'prompt', decision:'pass', digest: expectDigest}` entry exists (the
 *    mandatory UserPromptSubmit guard proves the role hooks are live, J2-13);
 *  - `promptBlocked`: our own prompt was rejected — a block entry for `expectDigest`, or block
 *    entries without any pass for it (a foreign message blocked after our prompt passed is the
 *    guard working, not a violation);
 *  - `gaps`: tool_use ids whose tool is in `init.tools`, that got a tool_result, are not
 *    StructuredOutput, were not refused before running (`result.permission_denials`), and have no
 *    `{hook:'tool', toolUseId}` entry (warn only).
 */
export function hookAttestation(ps, guardEntries, expectDigest) {
  const entries = Array.isArray(guardEntries) ? guardEntries.filter(e => e && typeof e === 'object') : []
  const prompts = entries.filter(e => e.hook === 'prompt')
  const hooksRan = prompts.some(e => e.decision === 'pass' && e.digest === expectDigest)
  const blocks = prompts.filter(e => e.decision === 'block')
  const promptBlocked = blocks.some(e => e.digest === expectDigest) || (!hooksRan && blocks.length > 0)
  const seen = new Set(entries.filter(e => e.hook === 'tool' && typeof e.toolUseId === 'string').map(e => e.toolUseId))
  const initTools = new Set(ps?.init?.tools ?? [])
  const results = new Set(ps?.toolResultIds ?? [])
  // A call refused before it ran (a permission rule, or a failing guard under onFailure:"block") is listed
  // in result.permission_denials: it never executed, so it is not a gap (WP4 probe: deny rules are checked
  // before PreToolUse hooks, so such calls have no guard entry).
  const denied = new Set((Array.isArray(ps?.result?.permission_denials) ? ps.result.permission_denials : [])
    .map(d => d?.tool_use_id).filter(id => typeof id === 'string'))
  const gaps = []
  for (const use of ps?.toolUses ?? []) {
    if (!use.id || !use.name) continue
    if (!initTools.has(use.name)) continue
    if (!results.has(use.id)) continue
    if (use.name === 'StructuredOutput') continue
    if (denied.has(use.id)) continue
    if (!seen.has(use.id)) gaps.push(use.id)
  }
  return { hooksRan, promptBlocked, gaps }
}

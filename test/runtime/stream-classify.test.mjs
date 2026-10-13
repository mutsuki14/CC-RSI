// SPEC §10.7, §10.8 / §15.3 WP4 `stream-classify.test.mjs`: the real fixtures (F1, F3, F7, R3, R4, f2, plus the
// WP4 V3/V4 probe streams) and one synthetic fixture per remaining classification row.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classify } from '../../lib/runtime/classify.mjs'
import { hookAttestation, parseStream, truncated } from '../../lib/runtime/stream.mjs'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'streams')
const lines = name => readFileSync(join(FIX, name), 'utf8').split('\n')
const text = name => readFileSync(join(FIX, name), 'utf8')
const OK_ATT = { hooksRan: true, promptBlocked: false, gaps: [] }
const SID = '11111111-2222-4333-8444-555555555555'

// ---------------------------------------------------------------- synthetic stream builders

const init = (over = {}) => ({ type: 'system', subtype: 'init', cwd: '/tmp/fixture/work', session_id: SID, tools: ['Bash', 'Read'], mcp_servers: [],
  model: 'claude-test-1', permissionMode: 'dontAsk', claude_code_version: '2.1.296', ...over })
const toolUse = (id, name, msg = 'm1') => ({ type: 'assistant', message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }], stop_reason: null },
  parent_tool_use_id: null, session_id: SID })
const toolResult = id => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, parent_tool_use_id: null, session_id: SID })
const say = (t, msg = 'm2', stop = 'end_turn') => ({ type: 'assistant', message: { id: msg, role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: stop },
  parent_tool_use_id: null, session_id: SID })
const result = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'done', session_id: SID, total_cost_usd: 0.01,
  stop_reason: 'end_turn', permission_denials: [], safety_stops: 0, ...over })
const jl = (...events) => events.map(e => JSON.stringify(e))
const reply = (over = {}) => parseStream(jl(init(), toolUse('t1', 'Bash'), toolResult('t1'), say('done'), result(over)))

function cls(input) {
  return classify({ exitCode: 0, signal: null, killedBy: null, stderr: '', attestation: OK_ATT, ...input })
}

// ---------------------------------------------------------------- real fixtures

test('F1 run1: a reply with 3 actions; text only from the final assistant message', () => {
  const ps = parseStream(lines('f1-run1.jsonl'))
  assert.equal(ps.init.permissionMode, 'dontAsk')
  assert.deepEqual(ps.init.tools, ['Bash', 'Read'])
  assert.equal(ps.init.ccVersion, '2.1.296')
  assert.equal(ps.actions, 3)
  assert.equal(ps.toolUses.length, 3)
  assert.equal(ps.toolResultIds.length, 3)
  assert.equal(ps.hookResponses.length, 3)
  assert.equal(ps.badLines, 0)
  // thinking + tool_use events of one message share message.id (F1): 4 messages, the last holds the text
  assert.equal(ps.assistantMessages.length, 4)
  assert.ok(ps.finalText.includes('HERON'))
  const c = cls({ ps })
  assert.equal(c.cls, 'reply')
  assert.equal(c.infra, false)
  assert.equal(c.reply.actions, 3)
  assert.equal(c.reply.text, ps.finalText)
  assert.equal(c.reply.model, 'claude-haiku-5-5')
  assert.equal(c.reply.permissionDenials, 1)
  assert.equal(c.reply.numTurns, 4)
  assert.equal(c.reply.truncated, false)
  assert.ok(c.reply.costUsdTotal > 0)
})

test('F3 run3: an invalid model is class config and its synthetic text is never used', () => {
  const ps = parseStream(lines('f3-run3.jsonl'))
  const c = cls({ ps, exitCode: 1, stderr: text('f3-run3.err') })
  assert.equal(c.cls, 'config')
  assert.equal(c.infra, true)
  assert.equal(c.reply, undefined)
  assert.match(c.detail, /claude-nonexistent-9/)
  assert.match(c.detail, /404/)
})

test('F7 run10: blocked prompt → isolation_violation with a block entry, hooks_not_run without entries, no_reply when attested', () => {
  const ps = parseStream(lines('f7-run10.jsonl'))
  assert.equal(ps.assistantMessages.length, 0)
  assert.equal(ps.informational.length, 1)
  const expect = 'f'.repeat(64)
  const blocked = hookAttestation(ps, [{ hook: 'prompt', decision: 'block', digest: '0'.repeat(64) }], expect)
  assert.equal(blocked.promptBlocked, true)
  assert.equal(cls({ ps, attestation: blocked }).cls, 'isolation_violation')
  const none = hookAttestation(ps, [], expect)
  assert.deepEqual(none, { hooksRan: false, promptBlocked: false, gaps: [] })
  assert.equal(cls({ ps, attestation: none }).cls, 'hooks_not_run')
  const c = cls({ ps, attestation: { hooksRan: true, promptBlocked: false, gaps: [] } })
  assert.equal(c.cls, 'no_reply')
  assert.equal(c.reply, undefined, 'result.result (which echoes our prompt) is never parsed')
})

test('R3 run3: --resume of an unknown id is session_missing', () => {
  const ps = parseStream(lines('r3-run3.jsonl'))
  assert.equal(ps.init, null)
  const c = cls({ ps, exitCode: 1, stderr: text('r3-run3.err'), attestation: hookAttestation(ps, [], 'x') })
  assert.equal(c.cls, 'session_missing')
  assert.match(c.detail, /No conversation found/)
})

test('R4 run4: a reused --session-id is session_conflict', () => {
  const c = cls({ ps: parseStream([]), exitCode: 1, stderr: text('r4-run4.err'), attestation: hookAttestation(parseStream([]), [], 'x') })
  assert.equal(c.cls, 'session_conflict')
})

test('f2: failIfUnavailable without a sandbox is sandbox_unavailable', () => {
  const c = cls({ ps: parseStream([]), exitCode: 1, stderr: text('f2-sandbox.err'), attestation: hookAttestation(parseStream([]), [], 'x') })
  assert.equal(c.cls, 'sandbox_unavailable')
  assert.match(c.detail, /sandbox required but unavailable/)
})

test('V4 probe: a --resume invocation whose UserPromptSubmit guard passed is a reply', () => {
  const ps = parseStream(lines('v4-resume.jsonl'))
  const guard = lines('v4-resume.guard.jsonl').filter(Boolean).map(l => JSON.parse(l))
  const att = hookAttestation(ps, guard, guard[0].digest)
  assert.equal(att.hooksRan, true)
  assert.equal(att.promptBlocked, false)
  const c = classify({ exitCode: 0, ps, attestation: att })
  assert.equal(c.cls, 'reply')
  assert.equal(c.reply.text, 'hello probe')
  // the UserPromptSubmit hook events precede system/init on 2.1.296
  const first = JSON.parse(lines('v4-resume.jsonl')[0])
  assert.equal(first.subtype, 'hook_started')
})

test('V3 probe: a crashed PreToolUse guard under onFailure block refuses the call (no execution, not a gap)', () => {
  const ps = parseStream(lines('v3-onfailure.jsonl'))
  const denials = ps.result.permission_denials.map(d => d.tool_use_id)
  assert.deepEqual(denials, [ps.toolUses[0].id])
  const att = hookAttestation(ps, [{ hook: 'prompt', decision: 'pass', digest: 'd' }], 'd')
  assert.deepEqual(att.gaps, [])
  assert.equal(classify({ exitCode: 0, ps, attestation: att }).cls, 'reply')
})

test('deny-rule probe: permission deny rules apply before PreToolUse hooks; liveness post entries are logged', () => {
  const ps = parseStream(lines('deny-rule-liveness.jsonl'))
  const guard = lines('deny-rule-liveness.guard.jsonl').filter(Boolean).map(l => JSON.parse(l))
  const att = hookAttestation(ps, guard, guard[0].digest)
  assert.equal(att.hooksRan, true)
  assert.equal(ps.actions, 4)
  const denied = ps.result.permission_denials.map(d => d.tool_use_id)
  assert.equal(denied.length, 1)
  assert.ok(!guard.some(e => e.toolUseId === denied[0]), 'the denied Read never reached the role guard')
  assert.deepEqual(att.gaps, [], 'a call refused by a permission rule is not a gap')
  assert.equal(guard.filter(e => e.hook === 'post').length, 2)
  // a call that ran without a guard entry is a gap, and gaps stay warn-only
  const missing = guard.filter(e => e.hook !== 'tool' || e.tool !== 'Write')
  const gapped = hookAttestation(ps, missing, guard[0].digest)
  assert.equal(gapped.gaps.length, 1)
  assert.equal(classify({ exitCode: 0, ps, attestation: gapped }).cls, 'reply', 'gaps never make the outcome infra')
})

// ---------------------------------------------------------------- parser details

test('parseStream: subagent traffic is ignored, bad lines are counted, the last message holds the text', () => {
  const sub = { ...toolUse('s1', 'Read', 'sub'), parent_tool_use_id: 't1' }
  const ps = parseStream([...jl(init(), toolUse('t1', 'Bash'), sub, toolResult('t1'), say('first', 'm2'), say('second', 'm3')), '{not json', '', '  ', JSON.stringify(result())])
  assert.equal(ps.actions, 1)
  assert.equal(ps.badLines, 1)
  assert.equal(ps.finalText, 'second')
  assert.equal(ps.assistantMessages.length, 3)
})

test('parseStream: text blocks of the final message are joined by newlines (a token line stays a line)', () => {
  const m = id => ({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: 'report body' }] }, parent_tool_use_id: null })
  const n = id => ({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: 'VERDICT: PASS' }] }, parent_tool_use_id: null })
  const ps = parseStream(jl(init(), m('x'), n('x'), result({ num_turns: 1 })))
  assert.equal(ps.finalText, 'report body\nVERDICT: PASS')
})

test('truncated(): result or last message stop_reason max_tokens', () => {
  assert.equal(truncated(parseStream(jl(init(), say('a', 'm', 'max_tokens'), result({ stop_reason: 'end_turn' })))), true)
  assert.equal(truncated(parseStream(jl(init(), say('a'), result({ stop_reason: 'max_tokens' })))), true)
  assert.equal(truncated(reply()), false)
  assert.equal(cls({ ps: parseStream(jl(init(), say('partial', 'm', 'max_tokens'), result({ stop_reason: 'max_tokens' }))) }).reply.truncated, true)
})

test('hookAttestation: our digest, foreign blocks and gap rules', () => {
  const ps = parseStream(jl(init({ tools: ['Bash', 'Read', 'StructuredOutput'] }), toolUse('a', 'Bash'), toolResult('a'), toolUse('b', 'Read', 'm3'), toolResult('b'),
    toolUse('c', 'Write', 'm4'), toolResult('c'), toolUse('d', 'StructuredOutput', 'm5'), toolResult('d'), toolUse('e', 'Bash', 'm6'), say('x', 'm7'), result()))
  const entries = [{ hook: 'prompt', decision: 'pass', digest: 'mine' }, { hook: 'prompt', decision: 'block', digest: 'foreign' }, { hook: 'tool', toolUseId: 'a' }]
  const att = hookAttestation(ps, entries, 'mine')
  assert.equal(att.hooksRan, true)
  assert.equal(att.promptBlocked, false, 'a foreign message blocked after ours passed is the guard working')
  // b: Read without an entry → gap; c: Write absent from init.tools; d: StructuredOutput; e: no tool_result
  assert.deepEqual(att.gaps, ['b'])
  assert.equal(hookAttestation(ps, [{ hook: 'prompt', decision: 'block', digest: 'mine' }], 'mine').promptBlocked, true)
  const denied = parseStream(jl(init(), toolUse('a', 'Bash'), toolResult('a'), say('x'), result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'a', tool_input: {} }] })))
  assert.deepEqual(hookAttestation(denied, [{ hook: 'prompt', decision: 'pass', digest: 'mine' }], 'mine').gaps, [], 'refused calls are not gaps')
  assert.equal(hookAttestation(ps, [{ hook: 'prompt', decision: 'pass', digest: 'other' }], 'mine').hooksRan, false)
})

// ---------------------------------------------------------------- one synthetic case per remaining row

test('row 1-3: watchdog, stop, spawn error', () => {
  assert.equal(cls({ killedBy: 'watchdog', ps: reply(), exitCode: null, signal: 'SIGINT' }).cls, 'timeout')
  assert.equal(cls({ killedBy: 'stop', ps: reply() }).cls, 'interrupted')
  const e = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
  const c = cls({ spawnError: e, ps: parseStream([]), exitCode: null })
  assert.equal(c.cls, 'spawn')
  assert.match(c.detail, /ENOENT/)
})

test('row 4 needs no init: a sandbox line after init is not sandbox_unavailable', () => {
  const ps = parseStream(jl(init()))
  assert.notEqual(cls({ ps, exitCode: 1, stderr: 'sandbox required but unavailable' }).cls, 'sandbox_unavailable')
})

test('row 7: unknown option with no events is cli_incompatible', () => {
  const c = cls({ ps: parseStream([]), exitCode: 1, stderr: "error: unknown option '--frobnicate'\n", attestation: { hooksRan: false, promptBlocked: false, gaps: [] } })
  assert.equal(c.cls, 'cli_incompatible')
  assert.match(c.detail, /cc-rsi doctor/)
})

test('row 8: MCP servers, an mcp__ tool or a wrong permission mode are isolation violations', () => {
  const base = [toolUse('t1', 'Bash'), toolResult('t1'), say('done'), result()]
  assert.equal(cls({ ps: parseStream(jl(init({ mcp_servers: [{ name: 'x', status: 'connected' }] }), ...base)) }).cls, 'isolation_violation')
  assert.equal(cls({ ps: parseStream(jl(init({ tools: ['Bash', 'mcp__x__y'] }), ...base)) }).cls, 'isolation_violation')
  assert.equal(cls({ ps: parseStream(jl(init({ permissionMode: 'bypassPermissions' }), ...base)) }).cls, 'isolation_violation')
})

test('row 9-10: our prompt blocked; hooks not attested', () => {
  assert.equal(cls({ ps: reply(), attestation: { hooksRan: false, promptBlocked: true, gaps: [] } }).cls, 'isolation_violation')
  assert.equal(cls({ ps: reply(), attestation: { hooksRan: false, promptBlocked: false, gaps: [] } }).cls, 'hooks_not_run')
})

test('row 11: transient API errors by status or assistant error', () => {
  for (const status of [408, 409, 425, 429, 500, 503, 529]) {
    const c = cls({ ps: reply({ is_error: true, api_error_status: status }), exitCode: 1 })
    assert.equal(c.cls, 'transient', String(status))
    assert.equal(c.status, status)
  }
  for (const error of ['overloaded', 'rate_limit', 'server_error', 'timeout', 'connection', 'overloaded_error']) {
    const ps = parseStream(jl(init(), { type: 'assistant', message: { id: 'e', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
      parent_tool_use_id: null, error, is_api_error_message: true }, result({ is_error: true, api_error_status: null, num_turns: 1 })))
    assert.equal(cls({ ps, exitCode: 1 }).cls, 'transient', error)
  }
})

test('row 12: auth', () => {
  for (const status of [401, 402, 403]) assert.equal(cls({ ps: reply({ is_error: true, api_error_status: status }) }).cls, 'auth')
  const ps = parseStream(jl(init(), { type: 'assistant', message: { id: 'e', role: 'assistant', content: [{ type: 'text', text: 'Authentication error' }] },
    parent_tool_use_id: null, error: 'authentication_failed' }, result({ is_error: true, num_turns: 1 })))
  const c = cls({ ps })
  assert.equal(c.cls, 'auth')
  assert.match(c.detail, /doctor --live/)
})

test('row 13: context overflow by status or text', () => {
  assert.equal(cls({ ps: reply({ is_error: true, api_error_status: 413 }) }).cls, 'context_overflow')
  assert.equal(cls({ ps: reply({ is_error: true, api_error_status: null, result: 'Prompt is too long' }) }).cls, 'context_overflow')
  assert.equal(cls({ ps: reply({ is_error: true, api_error_status: 400, result: 'input exceeds the context window' }) }).cls, 'context_overflow')
})

test('row 14: config for 400/404/422', () => {
  for (const status of [400, 404, 422]) assert.equal(cls({ ps: reply({ is_error: true, api_error_status: status, result: 'bad' }) }).cls, 'config')
})

test('rows 15-18: budget, ceiling, refusal, error', () => {
  assert.equal(cls({ ps: reply({ subtype: 'error_max_budget_usd', is_error: true }) }).cls, 'budget')
  assert.equal(cls({ ps: reply({ subtype: 'error_max_turns', is_error: true }) }).cls, 'ceiling')
  assert.equal(cls({ ps: reply({ stop_reason: 'refusal' }) }).cls, 'refusal')
  assert.equal(cls({ ps: reply({ safety_stops: 1 }) }).cls, 'refusal')
  assert.equal(cls({ ps: reply({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }) }).cls, 'error')
  assert.equal(cls({ ps: reply({ is_error: true, api_error_status: 418 }) }).cls, 'error')
})

test('rows 19-20: no result → crash (exit ≠ 0) or protocol (exit 0)', () => {
  const ps = parseStream(jl(init(), toolUse('t1', 'Bash')))
  const c = cls({ ps, exitCode: 137, stderr: 'killed\n' })
  assert.equal(c.cls, 'crash')
  assert.match(c.detail, /137/)
  assert.equal(cls({ ps, exitCode: null, signal: 'SIGKILL' }).cls, 'crash')
  assert.equal(cls({ ps, exitCode: 0 }).cls, 'protocol')
})

test('row 21: num_turns 0 or no assistant message → no_reply', () => {
  assert.equal(cls({ ps: parseStream(jl(init(), say('x'), result({ num_turns: 0 }))) }).cls, 'no_reply')
  assert.equal(cls({ ps: parseStream(jl(init(), result({ num_turns: 1 }))) }).cls, 'no_reply')
})

test('row 22: reply, with a warning when result.result differs from the final message', () => {
  const ps = parseStream(jl(init(), say('the real final text\nVERDICT: PASS'), result({ num_turns: 1, result: 'something else' })))
  const c = cls({ ps })
  assert.equal(c.cls, 'reply')
  assert.equal(c.reply.text, 'the real final text\nVERDICT: PASS')
  assert.equal(c.warnings.length, 1)
  assert.equal(cls({ ps: reply({ result: '  done \n' }) }).warnings.length, 0)
})

test('ordering: the first matching row wins', () => {
  // watchdog beats everything; R4 stderr beats R3 errors; isolation beats API errors
  assert.equal(cls({ killedBy: 'watchdog', spawnError: new Error('x'), ps: reply() }).cls, 'timeout')
  const both = parseStream(jl(result({ is_error: true, errors: ['No conversation found with session ID: x'] })))
  assert.equal(cls({ ps: both, stderr: 'Error: Session ID x is already in use.' }).cls, 'session_conflict')
  assert.equal(cls({ ps: parseStream(jl(init({ permissionMode: 'default' }), result({ is_error: true, api_error_status: 529 }))) }).cls, 'isolation_violation')
})

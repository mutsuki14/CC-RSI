// The fake `claude` honours its SPEC §15.2 contract (WP5 and WP6 depend on it): invocation surface, R3/R4 and
// F3/F7 shapes, hooks executed from --settings, permissions, --restricted, max-turns, output formats, crashes.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { REQUIRED_FLAGS } from '../../lib/runtime/claude-bin.mjs'
import { fakeClaude, writeScript, scenarioPath } from '../_helpers/fake.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const UUID = () => randomUUID()

async function setup({ scenario = scenarioPath('scripted'), runHooks = true } = {}) {
  const { home } = await tmpHome()
  const fake = await fakeClaude({ scenario, home, runHooks })
  const cwd = await tmpDir('cc-rsi-fake-cwd-')
  const env = { ...fake.env, CC_RSI_ROLE: 'verifier', CC_RSI_EXPECT: 'x', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(SESSION_ID|REMOTE|ENTRYPOINT|CONTAINER_ID|EXECPATH|CHILD_SESSION|SESSION_ATTENDED)|^CLAUDECODE$|^CCR_|^CLAUDE_PLUGIN_|^MCP_TOOL_TIMEOUT$|INGRESS|^CLAUDE_CODE_(MESSAGING|SYNC|ARTIFACT|ACCOUNT|ORGANIZATION|USER_EMAIL|DIAGNOSTICS|DEBUG|TEE|USE_CCR|MAX_SUBAGENT)|^CLAUDE_(PID|EFFORT|AUTO_BACKGROUND_TASKS|AUTOCOMPACT_PCT_OVERRIDE|PROJECT_DIR|ENV_FILE)$/.test(k)) delete env[k]
  const settingsFile = join(cwd, '..', `${UUID()}.settings.json`)
  const writeSettings = s => writeFileSync(settingsFile, JSON.stringify(s))
  writeSettings({ permissions: { defaultMode: 'dontAsk', allow: ['Read', 'Bash', 'Grep', 'Glob'] } })
  const run = (args, { stdin = 'hello\n', extraEnv = {} } = {}) => runNode(fake.bin, args, { stdin, env: { ...env, ...extraEnv }, cwd })
  const base = (sid, first = true, tools = 'Read,Bash') => ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', first ? '--session-id' : '--resume', sid,
    '--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', settingsFile, '--permission-mode', 'dontAsk', '--tools', tools]
  const events = out => out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { home, fake, cwd, env, run, base, events, writeSettings, settingsFile }
}

test('--version and --help (every REQUIRED_FLAGS entry); neither is logged', async () => {
  const s = await setup()
  const v = await s.run(['--version'])
  assert.equal(v.stdout.trim(), '2.1.296 (Claude Code)')
  const h = await s.run(['--help'])
  for (const flag of REQUIRED_FLAGS) assert.ok(h.stdout.includes(flag), flag)
  assert.equal(s.fake.log().length, 0)
})

test('argument and environment refusals', async () => {
  const s = await setup()
  const sid = UUID()
  const unknown = await s.run([...s.base(sid), '--bogus'])
  assert.equal(unknown.code, 1)
  assert.equal(unknown.stderr.trim(), "error: unknown option '--bogus'")
  const positional = await s.run([...s.base(UUID()), 'do it'])
  assert.equal(positional.code, 2)
  assert.match(positional.stderr, /FAKE: positional prompt/)
  const noP = await s.run(s.base(UUID()).slice(1))
  assert.equal(noP.code, 2)
  const forbidden = await s.run(s.base(UUID()), { extraEnv: { CLAUDE_CODE_SESSION_ID: 'outer' } })
  assert.equal(forbidden.code, 3)
  assert.match(forbidden.stderr, /FAKE: forbidden env CLAUDE_CODE_SESSION_ID/)
  const noRole = await s.run(s.base(UUID()), { extraEnv: { CC_RSI_ROLE: '' } })
  assert.equal(noRole.code, 3)
  const noBg = await s.run(s.base(UUID()), { extraEnv: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } })
  assert.equal(noBg.code, 3)
  const noSession = await s.run(s.base(UUID()).filter((a, i, arr) => a !== '--session-id' && arr[i - 1] !== '--session-id'))
  assert.equal(noSession.code, 2)
})

test('R4: --session-id of an existing session; R3: --resume of an unknown one', async () => {
  const s = await setup()
  const sid = UUID()
  assert.equal((await s.run(s.base(sid))).code, 0)
  const r4 = await s.run(s.base(sid))
  assert.equal(r4.code, 1)
  assert.equal(r4.stdout, '')
  assert.equal(r4.stderr.trim(), `Error: Session ID ${sid} is already in use.`)
  const missing = UUID()
  const r3 = await s.run(s.base(missing, false))
  assert.equal(r3.code, 1)
  const evs = s.events(r3.stdout)
  assert.equal(evs.length, 1)
  assert.deepEqual({ type: evs[0].type, subtype: evs[0].subtype, is_error: evs[0].is_error, num_turns: evs[0].num_turns, session_id: evs[0].session_id, errors: evs[0].errors },
    { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: missing, errors: [`No conversation found with session ID: ${missing}`] })
  const resumed = await s.run(s.base(sid, false), { stdin: 'again\n' })
  assert.equal(resumed.code, 0)
  assert.equal(s.fake.session(sid).turns.length, 2)
})

test('stream shape: hook events, init, per-action assistant + tool_result, final text, cumulative result', async () => {
  const s = await setup()
  writeScript(s.fake, { verifier: { default: { actions: [{ tool: 'Bash', command: 'echo hi' }, { tool: 'Read', file_path: '{{CWD}}/missing.txt' }], text: 'VERDICT: PASS' } } })
  s.writeSettings({ permissions: { defaultMode: 'dontAsk', allow: ['Read', 'Bash'] },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{})'] }] }] } })
  const sid = UUID()
  const r = await s.run(s.base(sid))
  assert.equal(r.code, 0)
  const evs = s.events(r.stdout)
  const init = evs.find(e => e.subtype === 'init')
  assert.deepEqual({ cwd: init.cwd, session_id: init.session_id, tools: init.tools, mcp_servers: init.mcp_servers, model: init.model, permissionMode: init.permissionMode, v: init.claude_code_version },
    { cwd: s.cwd, session_id: sid, tools: ['Read', 'Bash'], mcp_servers: [], model: 'fake-default-model', permissionMode: 'dontAsk', v: '2.1.296' })
  const uses = evs.filter(e => e.type === 'assistant' && e.message.content[0].type === 'tool_use')
  assert.deepEqual(uses.map(e => e.message.id), ['msg_1_1', 'msg_1_2'])
  assert.deepEqual(uses.map(e => e.message.content[0].id), ['toolu_fake_1', 'toolu_fake_2'])
  assert.equal(evs.filter(e => e.subtype === 'hook_started').length, 2)
  const results = evs.filter(e => e.type === 'user')
  assert.equal(results[0].message.content[0].content, 'hi')
  assert.equal(results[1].message.content[0].is_error, true)
  const result = evs[evs.length - 1]
  assert.deepEqual({ type: result.type, subtype: result.subtype, is_error: result.is_error, result: result.result, num_turns: result.num_turns, stop: result.stop_reason, term: result.terminal_reason },
    { type: 'result', subtype: 'success', is_error: false, result: 'VERDICT: PASS', num_turns: 3, stop: 'end_turn', term: 'completed' })
  assert.ok(Math.abs(result.total_cost_usd - 0.003) < 1e-9)
  const again = s.events((await s.run(s.base(sid, false))).stdout)
  assert.ok(Math.abs(again[again.length - 1].total_cost_usd - 0.006) < 1e-9, 'cost is cumulative per session')
})

test('F7 shape: a UserPromptSubmit block returns init, informational and a num_turns 0 result; the scenario is not consulted', async () => {
  const s = await setup()
  writeScript(s.fake, { verifier: { default: { crash: 'before-init' } } })
  s.writeSettings({ permissions: { defaultMode: 'dontAsk', allow: [] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath,
    args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({decision:"block",reason:"cc-rsi: foreign"})))'] }] }] } })
  const r = await s.run(s.base(UUID()), { stdin: 'Line one.\n' })
  assert.equal(r.code, 0)
  const evs = s.events(r.stdout)
  assert.deepEqual(evs.map(e => e.subtype ?? e.type), ['hook_started', 'hook_response', 'init', 'informational', 'success'])
  const result = evs[evs.length - 1]
  assert.equal(result.is_error, false)
  assert.equal(result.num_turns, 0)
  assert.equal(result.result, 'UserPromptSubmit operation blocked by hook:\ncc-rsi: foreign\n\nOriginal prompt: Line one.\n')
  assert.equal(evs.filter(e => e.type === 'assistant').length, 0)
})

test('F3 shape: an API error is a synthetic assistant message plus an is_error result with the status', async () => {
  const s = await setup()
  writeScript(s.fake, { verifier: { default: { apiError: { status: 404, error: 'model_not_found', text: 'There is an issue with the selected model' } } } })
  const r = await s.run(s.base(UUID()))
  assert.equal(r.code, 1)
  const evs = s.events(r.stdout)
  const a = evs.find(e => e.type === 'assistant')
  assert.equal(a.error, 'model_not_found')
  assert.equal(a.message.model, '<synthetic>')
  const res = evs[evs.length - 1]
  assert.deepEqual({ subtype: res.subtype, is_error: res.is_error, status: res.api_error_status, term: res.terminal_reason }, { subtype: 'success', is_error: true, status: 404, term: 'api_error' })
})

test('permissions: dontAsk allow rules, deny rules, tools outside --tools, --restricted, hook allow is logged', async () => {
  const s = await setup()
  const outside = await tmpDir()
  writeFileSync(join(outside, 'o.txt'), 'o')
  writeScript(s.fake, { verifier: { default: { actions: [
    { tool: 'Write', file_path: '{{CWD}}/w.txt', content: 'x' },
    { tool: 'Grep', pattern: 'x' },
    { tool: 'Read', file_path: join(outside, 'o.txt') },
    { tool: 'Bash', command: 'echo ok' },
  ], text: 'done' } } })
  s.writeSettings({ permissions: { defaultMode: 'dontAsk', allow: ['Read', 'Bash', 'Grep'], deny: ['Bash'] } })
  const r = await s.run(s.base(UUID(), true, 'Read,Bash,Grep'))
  const evs = s.events(r.stdout)
  const contents = evs.filter(e => e.type === 'user').map(e => e.message.content[0].content)
  assert.equal(contents[0], 'No such tool available: Write')
  assert.match(contents[1], /^No files found|Found/)
  assert.match(contents[2], /--restricted confines the file tools/)
  assert.equal(contents[3], 'Permission to use Bash has been denied.', 'deny rules apply before hooks and allow rules')
  assert.equal(evs[evs.length - 1].permission_denials.length, 2)
  // A PreToolUse allow overrides dontAsk (F5) and is recorded.
  s.writeSettings({ permissions: { defaultMode: 'dontAsk', allow: [] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath,
    args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}})))'] }] }] } })
  writeScript(s.fake, { verifier: { default: { actions: [{ tool: 'Bash', command: 'echo allowed' }], text: 'done' } } })
  const allowed = s.events((await s.run(s.base(UUID()))).stdout)
  assert.equal(allowed.filter(e => e.type === 'user')[0].message.content[0].content, 'allowed')
  assert.equal(s.fake.log().at(-1).allowSeen, true)
})

test('--max-turns, json and text output, max_tokens stop reason, crashes', async () => {
  const s = await setup()
  writeScript(s.fake, { verifier: { turns: [
    { actions: [{ tool: 'Bash', command: 'true' }, { tool: 'Bash', command: 'true' }, { tool: 'Bash', command: 'true' }], text: 'x' },
    { text: 'cut', stopReason: 'max_tokens' },
    { crash: 'after-result', exit: 9 },
    { crash: 'after-init' },
  ] } })
  const sid = UUID()
  const mt = await s.run([...s.base(sid).slice(0, -2), '--max-turns', '2', '--tools', 'Bash'])
  const last = s.events(mt.stdout).at(-1)
  assert.equal(last.subtype, 'error_max_turns')
  const json = await s.run(s.base(sid, false).map(a => (a === 'stream-json' ? 'json' : a)))
  const obj = JSON.parse(json.stdout)
  assert.equal(obj.result, 'cut')
  assert.equal(obj.stop_reason, 'max_tokens')
  const after = await s.run(s.base(sid, false))
  assert.equal(after.code, 9)
  assert.equal(s.events(after.stdout).at(-1).type, 'result')
  const afterInit = await s.run(s.base(sid, false))
  assert.equal(afterInit.code, 1)
  assert.deepEqual(s.events(afterInit.stdout).map(e => e.subtype ?? e.type).filter(t => t !== 'hook_started' && t !== 'hook_response'), ['init'])
})

test('before-init crash leaves no session (a later --resume is R3); sandbox gate', async () => {
  const s = await setup()
  writeScript(s.fake, { verifier: { default: { crash: 'before-init', stderr: 'boom' } } })
  const sid = UUID()
  const r = await s.run(s.base(sid))
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(s.fake.session(sid), null)
  s.writeSettings({ permissions: { defaultMode: 'dontAsk', allow: [] }, sandbox: { enabled: true, failIfUnavailable: true } })
  const gate = await s.run(s.base(UUID()))
  assert.equal(gate.code, 1)
  assert.equal(gate.stdout, '')
  assert.match(gate.stderr, /^Error: sandbox required but unavailable:/)
})

test('the invocation log records argv, env keys, CC_RSI_* values, stdin sha, session and mode', async () => {
  const s = await setup({ scenario: scenarioPath('ok') })
  const sid = UUID()
  await s.run(s.base(sid), { stdin: 'exact bytes \n' })
  const [entry] = s.fake.log()
  assert.equal(entry.sessionId, sid)
  assert.equal(entry.mode, 'new')
  assert.equal(entry.exit, 0)
  assert.equal(entry.ccRsi.CC_RSI_ROLE, 'verifier')
  assert.ok(entry.envKeys.includes('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'))
  assert.equal(entry.stdinSha, (await import('node:crypto')).createHash('sha256').update('exact bytes \n').digest('hex'))
  assert.equal(entry.allowSeen, false)
  assert.ok(Array.isArray(entry.hooksRun))
  assert.equal(readFileSync(s.fake.logFile, 'utf8').trim().split('\n').length, 1)
})

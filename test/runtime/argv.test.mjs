// SPEC §10.2 / §15.3 WP4 `argv.test.mjs`: golden argv per role; no positional prompt; --session-id only on
// the first send; --tools last; never a forbidden flag.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildArgv, EMPTY_MCP_CONFIG, FORBIDDEN_FLAGS } from '../../lib/runtime/argv.mjs'

const SID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const H = '/home/u/.cc-rsi'
const SYS = `${H}/run/prompts/aaaa.md`
const SET = `${H}/run/settings/bbbb.json`

const COMMON_TAIL = ['--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
  '--append-system-prompt-file', SYS, '--settings', SET, '--permission-mode', 'dontAsk']

test('interactive Verifier, first inspection (SPEC §10.13 golden)', () => {
  const argv = buildArgv({ first: true, sessionId: SID, model: 'opus', systemFile: SYS, settingsFile: SET, maxTurns: 2000, tools: ['Read', 'Grep', 'Glob', 'Bash'] })
  assert.deepEqual(argv, ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--session-id', SID, '--model', 'opus',
    ...COMMON_TAIL, '--max-turns', '2000', '--tools', 'Read,Grep,Glob,Bash'])
})

test('re-verification after FAIL resumes the same session', () => {
  const argv = buildArgv({ first: false, sessionId: SID, model: 'opus', systemFile: SYS, settingsFile: SET, maxTurns: 2000, tools: ['Read', 'Grep', 'Glob', 'Bash'] })
  assert.deepEqual(argv.slice(5, 7), ['--resume', SID])
  assert.ok(!argv.includes('--session-id'))
})

test('practice Actor without a configured model omits --model', () => {
  const argv = buildArgv({ first: true, sessionId: SID, model: null, effort: null, systemFile: SYS, settingsFile: SET, maxTurns: 2000,
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] })
  assert.deepEqual(argv, ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--session-id', SID,
    ...COMMON_TAIL, '--max-turns', '2000', '--tools', 'Read,Edit,Write,Glob,Grep,Bash'])
})

test('Curriculum with effort and a per-message budget', () => {
  const argv = buildArgv({ first: false, sessionId: SID, model: 'sonnet', effort: 'high', systemFile: SYS, settingsFile: SET, maxTurns: 2000, maxBudgetUsd: 1.5,
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] })
  assert.deepEqual(argv, ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--resume', SID, '--model', 'sonnet', '--effort', 'high',
    ...COMMON_TAIL, '--max-turns', '2000', '--max-budget-usd', '1.5', '--tools', 'Read,Edit,Write,Glob,Grep,Bash'])
})

test('summarizer: --no-session-persistence, one turn, empty --tools element last', () => {
  const argv = buildArgv({ first: true, sessionId: SID, model: 'haiku', systemFile: SYS, settingsFile: SET, maxTurns: 1, noSessionPersistence: true, tools: [] })
  assert.deepEqual(argv, ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--session-id', SID, '--model', 'haiku',
    ...COMMON_TAIL, '--max-turns', '1', '--no-session-persistence', '--tools', ''])
  assert.equal(argv[argv.length - 2], '--tools')
  assert.equal(argv[argv.length - 1], '')
})

test('a zero or missing budget is omitted', () => {
  for (const maxBudgetUsd of [0, null, undefined, -1, Number.NaN]) {
    const argv = buildArgv({ first: true, sessionId: SID, systemFile: SYS, settingsFile: SET, maxTurns: 5, maxBudgetUsd, tools: ['Bash'] })
    assert.ok(!argv.includes('--max-budget-usd'), String(maxBudgetUsd))
  }
})

test('invariants hold across every combination', () => {
  for (const first of [true, false]) {
    for (const model of [null, 'opus']) {
      for (const tools of [[], ['Bash'], ['Read', 'Grep', 'Glob', 'Bash']]) {
        for (const noSessionPersistence of [false, true]) {
          const argv = buildArgv({ first, sessionId: SID, model, systemFile: SYS, settingsFile: SET, maxTurns: 3, tools, noSessionPersistence })
          assert.equal(argv[0], '-p')
          assert.equal(argv[argv.length - 2], '--tools', '--tools is last')
          assert.equal(argv.filter(a => a === '--tools').length, 1)
          assert.equal(argv.includes('--session-id'), first)
          assert.equal(argv.includes('--resume'), !first)
          assert.equal(argv[argv.indexOf('--setting-sources') + 1], '')
          assert.equal(argv[argv.indexOf('--mcp-config') + 1], EMPTY_MCP_CONFIG)
          for (const forbidden of FORBIDDEN_FLAGS) assert.ok(!argv.includes(forbidden), forbidden)
          // No positional prompt: every element is a flag or the value of the flag before it.
          const valueFlags = new Set(['--output-format', '--session-id', '--resume', '--model', '--effort', '--setting-sources', '--mcp-config',
            '--append-system-prompt-file', '--settings', '--permission-mode', '--max-turns', '--max-budget-usd', '--tools'])
          for (let i = 0; i < argv.length; i++) {
            if (argv[i].startsWith('-')) continue
            assert.ok(i > 0 && valueFlags.has(argv[i - 1]), `positional element ${JSON.stringify(argv[i])} at ${i}`)
          }
        }
      }
    }
  }
})

test('invalid inputs are rejected', () => {
  const ok = { first: true, sessionId: SID, systemFile: SYS, settingsFile: SET, maxTurns: 1, tools: [] }
  assert.throws(() => buildArgv({ ...ok, sessionId: 'not-a-uuid' }), TypeError)
  assert.throws(() => buildArgv({ ...ok, systemFile: '' }), TypeError)
  assert.throws(() => buildArgv({ ...ok, settingsFile: undefined }), TypeError)
  assert.throws(() => buildArgv({ ...ok, maxTurns: 0 }), TypeError)
  assert.throws(() => buildArgv({ ...ok, tools: ['Read,Bash'] }), TypeError)
  assert.throws(() => buildArgv({ ...ok, tools: ['Bash', '--evil'] }), TypeError)
  assert.throws(() => buildArgv({ ...ok, model: 'opus extra' }), TypeError)
})

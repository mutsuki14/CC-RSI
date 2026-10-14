// SPEC §15.3 WP5 `test/mcp/protocol.test.mjs`: spawns mcp/server.mjs over real stdio.
// server/discover → -32601 with the same id; initialize negotiation; tools/list names, schemas and
// _meta; ping; unknown notifications ignored; -32700; -32600 for a batch or a missing method;
// stdout carries JSON-RPC only; under CC_RSI_ROLE every tool is an isError result; cancellation.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { McpClient, ROOT, callTool, cleanEnv, jobsOf, payloads, reapJobs, setupProject } from '../interactive/harness.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir, tmpHome } from '../_helpers/tmp.mjs'

async function server(extraEnv = {}) {
  const { home, env } = await tmpHome()
  const client = new McpClient({ ...cleanEnv(env), CC_RSI_HOME: home, ...extraEnv })
  return { home, client }
}

const TOOL_NAMES = ['submit', 'wait_verdict', 'learn', 'memory_commit', 'status']

describe('MCP protocol over stdio', () => {
  it('answers server/discover (sent before initialize) with -32601 and the same id', async () => {
    const { client } = await server()
    try {
      const r = await client.request('server/discover', undefined, { id: 'server-discover-probe-1' })
      assert.deepEqual(r, { jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'Method not found' } })
      const other = await client.request('resources/list', {})
      assert.equal(other.error.code, -32601)
    } finally {
      await client.close()
    }
  })

  it('negotiates the protocol version and returns capabilities, serverInfo and instructions', async () => {
    const { client } = await server()
    try {
      for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
        const r = await client.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } })
        assert.equal(r.result.protocolVersion, version)
      }
      const newer = await client.request('initialize', { protocolVersion: '2099-01-01', capabilities: {} })
      assert.equal(newer.result.protocolVersion, '2025-11-25')
      const missing = await client.request('initialize', {})
      assert.equal(missing.result.protocolVersion, '2025-11-25')
      assert.deepEqual(newer.result.capabilities, { tools: { listChanged: false } })
      assert.equal(newer.result.serverInfo.name, 'cc-rsi')
      // The version the CLI reports (portability-14): the plugin manifest's.
      const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
      assert.equal(newer.result.serverInfo.version, manifest.version)
      assert.ok(newer.result.instructions.length <= 1500)
      assert.match(newer.result.instructions, /^cc-rsi runs an independent Verifier for your work in this project\./)
    } finally {
      await client.close()
    }
  })

  it('reports the plugin manifest\'s version after a bump, like the CLI (portability-14)', async () => {
    const root = await tmpDir('cc-rsi-plugin-')
    for (const part of ['lib', 'mcp', 'prompts', 'package.json', '.claude-plugin']) cpSync(join(ROOT, part), join(root, part), { recursive: true })
    const manifestFile = join(root, '.claude-plugin', 'plugin.json')
    writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(readFileSync(manifestFile, 'utf8')), version: '9.8.7' }))
    const { home, env } = await tmpHome()
    const client = new McpClient({ ...cleanEnv(env), CC_RSI_HOME: home }, { server: join(root, 'mcp', 'server.mjs') })
    try {
      const r = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} })
      assert.equal(r.result.serverInfo.version, '9.8.7')
    } finally {
      await client.close()
    }
  })

  it('submit compares the disk with the code this server process loaded, so /clear never accepts an edit (r3-interactive-8)', async () => {
    const root = await tmpDir('cc-rsi-plugin-')
    for (const part of ['lib', 'hooks', 'bin', 'mcp', 'prompts', 'package.json', '.claude-plugin']) cpSync(join(ROOT, part), join(root, part), { recursive: true })
    const p = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'Fine.\nVERDICT: PASS' } } } })
    const hookOfCopy = (sub, payload) => runNode(join(root, 'hooks', 'hook.mjs'), [sub], { stdin: JSON.stringify(payload), env: p.env, timeoutMs: 20000 })
    assert.equal((await hookOfCopy('session-start', payloads.sessionStart(p))).code, 0)
    const client = new McpClient(p.env, { cwd: p.repo, server: join(root, 'mcp', 'server.mjs') })
    try {
      await client.initialize()
      // The plugin checkout is edited in place after the server started (a git pull), then the user
      // types /clear: a new session id in the same process, whose SessionStart records the disk.
      appendFileSync(join(root, 'lib', 'interactive', 'verify-job.mjs'), '\n// edited after the MCP server started\n')
      const cleared = { ...p, sid: randomUUID() }
      assert.equal((await hookOfCopy('session-start', payloads.sessionStart(cleared, 'clear'))).code, 0)
      assert.equal((await hookOfCopy('prompt', payloads.prompt(cleared, 'Rename the file'))).code, 0)
      const r = await callTool(cleared, client, 'submit', {})
      assert.equal(r.isError, true, r.text)
      assert.match(r.text, /\(plugin_changed\)/)
      assert.deepEqual(jobsOf(cleared), [], 'no verification job ran the changed code')
    } finally {
      await client.close()
      await reapJobs(p.home)
    }
  })

  it('lists the five tools with schemas, annotations and _meta', async () => {
    const { client } = await server()
    try {
      await client.initialize()
      const { result } = await client.request('tools/list', {})
      assert.deepEqual(result.tools.map(t => t.name), TOOL_NAMES)
      for (const tool of result.tools) {
        assert.equal(tool.inputSchema.type, 'object')
        assert.equal(tool.inputSchema.additionalProperties, false)
        assert.deepEqual(tool._meta, { 'anthropic/maxResultSizeChars': 200000 })
        assert.ok(tool.description.length > 0 && tool.description.length <= 600)
      }
      const byName = Object.fromEntries(result.tools.map(t => [t.name, t]))
      assert.deepEqual(byName.status.annotations, { readOnlyHint: true })
      assert.deepEqual(byName.submit.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false })
      assert.deepEqual(byName.submit.inputSchema.properties.evidence_leads, {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          properties: { claim: { type: 'string', minLength: 1, maxLength: 2000 }, probe: { type: 'string', minLength: 1, maxLength: 4000 } },
          required: ['claim', 'probe'],
          additionalProperties: false,
        },
      })
      // confirm is required unless abandon is true (checked by the tool, cc-integration-5).
      assert.deepEqual(byName.memory_commit.inputSchema, {
        type: 'object',
        properties: { confirm: { type: 'string', pattern: '^[0-9a-f]{6}$' }, abandon: { type: 'boolean' } },
        additionalProperties: false,
      })
      assert.match(byName.memory_commit.description, /call learn to re-show/)
    } finally {
      await client.close()
    }
  })

  it('answers ping, ignores unknown notifications, and reports framing errors', async () => {
    const { client } = await server()
    try {
      await client.initialize()
      client.send({ jsonrpc: '2.0', method: 'notifications/whatever', params: { x: 1 } })
      const ping = await client.request('ping')
      assert.deepEqual(ping, { jsonrpc: '2.0', id: ping.id, result: {} })
      const before = client.raw.length
      client.send('{not json')
      client.send('[{"jsonrpc":"2.0","id":99,"method":"ping"}]')
      client.send('{"jsonrpc":"2.0","id":100}')
      client.send('{"jsonrpc":"2.0","id":101,"method":""}')
      const after = await client.request('ping')
      assert.ok(after.result)
      const frames = client.raw.slice(before).map(line => JSON.parse(line)).filter(m => m.error)
      assert.deepEqual(frames.map(f => [f.id, f.error.code]), [[null, -32700], [null, -32600], [100, -32600], [101, -32600]])
      // stdout carries JSON-RPC frames only.
      for (const line of client.raw) assert.equal(JSON.parse(line).jsonrpc, '2.0')
      const unknownTool = await client.request('tools/call', { name: 'nope', arguments: {} })
      assert.equal(unknownTool.result.isError, true)
      assert.match(unknownTool.result.content[0].text, /Unknown tool: nope/)
      const noName = await client.request('tools/call', { arguments: {} })
      assert.equal(noName.error.code, -32602)
    } finally {
      await client.close()
    }
  })

  it('refuses every tool inside a role context (CC_RSI_ROLE)', async () => {
    const { client } = await server({ CC_RSI_ROLE: 'verifier' })
    try {
      await client.initialize()
      for (const name of TOOL_NAMES) {
        const args = name === 'memory_commit' ? { confirm: 'abcdef' } : {}
        const r = await client.request('tools/call', { name, arguments: args, _meta: { 'claudecode/toolUseId': 'toolu_role' } })
        assert.equal(r.result.isError, true, name)
        assert.equal(r.result.content[0].text, 'cc-rsi tools are not available inside role contexts.')
      }
    } finally {
      await client.close()
    }
  })

  it('validates arguments against the schema before anything else', async () => {
    const { client } = await server()
    try {
      await client.initialize()
      const cases = [
        ['memory_commit', { confirm: 'XYZ' }],
        ['memory_commit', { confirm: 'abcdef', abandon: 'yes' }],
        ['submit', { evidence_leads: 'x' }],
        ['submit', { evidence_leads: [{ claim: '', probe: 'p' }] }],
        ['submit', { other: 1 }],
        ['status', { verbose: true }],
      ]
      for (const [name, args] of cases) {
        const r = await client.request('tools/call', { name, arguments: args })
        assert.equal(r.result.isError, true, `${name} ${JSON.stringify(args)}`)
        assert.match(r.result.content[0].text, /^Invalid arguments for /)
      }
    } finally {
      await client.close()
    }
  })

  it('a cancelled request gets no response; the server keeps serving', async () => {
    const { client } = await server()
    try {
      await client.initialize()
      // An unattested state-changing call waits up to 2 s for its attestation: cancel it meanwhile.
      const id = 'cancel-me'
      let answered = false
      client.request('tools/call', { name: 'submit', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_never' } }, { id }).then(() => { answered = true })
      client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } })
      await new Promise(r => setTimeout(r, 2500))
      assert.equal(answered, false)
      assert.ok((await client.request('ping')).result)
    } finally {
      await client.close()
    }
  })

  it('exits when stdin closes', async () => {
    const { client } = await server()
    await client.initialize()
    const exit = await client.close()
    assert.equal(exit.code, 0)
    assert.equal(client.stderr, '')
  })
})

// The cc-rsi MCP server "rsi" (SPEC §11.11): newline-delimited JSON-RPC 2.0 over stdio.
//
// Verified Claude Code 2.1.296 behaviour (claude-code-experiments.md e, E9): `server/discover`
// arrives before `initialize` and must get a JSON-RPC error; `initialize` negotiates the protocol
// version; `tools/call` carries `_meta["claudecode/toolUseId"]` and a progressToken; tool names as
// the model sees them are `mcp__plugin_cc-rsi_rsi__<tool>`. Start-up does no store I/O (it only
// sweeps attestations older than 1 h); stdout carries protocol frames only, logs go to
// `<home>/logs/mcp.log`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../core/log.mjs'
import { ccRsiHome, globalLayout } from '../core/paths.mjs'
import { sweepAttestations } from '../interactive/attest.mjs'
import { CODE_ROOT } from '../interactive/session.mjs'
import { INVALID_PARAMS, METHOD_NOT_FOUND, RpcError, createRpc } from './jsonrpc.mjs'
import { TOOLS, callTool } from './tools.mjs'

/** Supported MCP protocol versions, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])

/** Server instructions (SPEC §11.11, ≤ 1500 chars). */
export const INSTRUCTIONS = 'cc-rsi runs an independent Verifier for your work in this project. When a non-trivial task is complete, call submit; the verdict (PASS/FAIL/UNVERIFIED) comes from a separate Claude Code process that sees only the user\'s request and the workspace. Act on FAIL by repairing and submitting again. After a terminal verdict, call learn to distill reusable experience into the project memory directory listed in your context.'

/** Echo the client's protocol version when supported, else the newest (SPEC §11.11). */
export function negotiateProtocol(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
}

let cachedVersion = null

function manifestVersion(file) {
  try {
    const manifest = JSON.parse(readFileSync(join(CODE_ROOT, file), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * The plugin version, read where the CLI reads it (`.claude-plugin/plugin.json`, portability-14),
 * else package.json's `version`, else '0.1.0'.
 */
export function serverVersion() {
  if (cachedVersion !== null) return cachedVersion
  cachedVersion = manifestVersion(join('.claude-plugin', 'plugin.json')) ?? manifestVersion('package.json') ?? '0.1.0'
  return cachedVersion
}

/**
 * Serves MCP on `input`/`output` until the input ends. Options (additive, for tests): `input`,
 * `output`, `env`. Resolves when the client closed the connection.
 */
export async function main({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const home = ccRsiHome(env)
  const g = globalLayout(home)
  const logger = createLogger(g.mcpLog, 'mcp')
  sweepAttestations(g.att).catch(() => undefined)
  logger.info('server started', { pid: process.pid, role: env.CC_RSI_ROLE ?? null })
  let rpc = null
  const onRequest = async (method, params, { signal }) => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: negotiateProtocol(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cc-rsi', version: serverVersion() },
          instructions: INSTRUCTIONS,
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: TOOLS }
      case 'tools/call': {
        // The wait budget of a call counts from its arrival (cc-integration-8).
        const receivedAt = Date.now()
        const name = params?.name
        if (typeof name !== 'string' || name === '') throw new RpcError(INVALID_PARAMS, 'Invalid params: tools/call needs a tool name')
        const meta = params?._meta && typeof params._meta === 'object' ? params._meta : {}
        const token = meta.progressToken
        const progress = token === undefined || token === null
          ? null
          : (progressValue, total, message) => rpc?.notify('notifications/progress', { progressToken: token, progress: progressValue, total, message })
        return callTool(name, params?.arguments ?? {}, { meta, env, signal, progress, receivedAt })
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, 'Method not found')
    }
  }
  rpc = createRpc({
    input,
    output,
    onRequest,
    onNotification: () => undefined,
    log: (msg, data) => logger.warn(msg, data),
  })
  await rpc.closed
  logger.info('server stopped', { pid: process.pid })
}

#!/usr/bin/env node
// cc-rsi MCP server entry (SPEC §3, §11.11): stdio server "rsi", started by Claude Code from
// .mcp.json as `node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`.
import('../lib/mcp/server.mjs')
  .then(m => m.main())
  .then(() => {
    // Let pending stdout writes drain; never linger once the client has gone.
    process.exitCode = 0
    setTimeout(() => process.exit(0), 2000).unref()
  }, error => {
    process.stderr.write(`cc-rsi MCP server: ${(error && error.stack) || error}\n`)
    process.exitCode = 1
    setTimeout(() => process.exit(1), 2000).unref()
  })

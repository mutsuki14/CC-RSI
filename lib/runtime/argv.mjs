// The exact role-child command line (SPEC §10.2).
//
// The prompt is never positional: `--tools` (like `--add-dir` and `--allowedTools`) is variadic
// and would swallow it (claude-code-experiments.md f3 gotcha), so the message always goes on stdin,
// `--tools` is the LAST flag, and directories and permission rules live in the --settings file.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const FLAG_VALUE_RE = /^[^\s\0]+$/

/** Flags a role child must never receive (SPEC §10.2). */
export const FORBIDDEN_FLAGS = Object.freeze(['--fork-session', '--bare', '--safe-mode', '--fallback-model', '--add-dir', '--allowedTools',
  '--allowed-tools', '--dangerously-skip-permissions', '--continue', '-c', '--system-prompt', '--system-prompt-file', '--agent', '--plugin-dir'])

/** The empty MCP configuration passed with --strict-mcp-config. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}'

function requireString(value, what) {
  if (typeof value !== 'string' || value === '') throw new TypeError(`buildArgv: ${what} is required`)
  return value
}

/**
 * Returns, in this order (SPEC §10.2):
 * ```
 * -p --output-format stream-json --verbose --include-hook-events
 * (--session-id <uuid> | --resume <uuid>)        --session-id iff `first` (an id is never reused: R4)
 * [--model <model>] [--effort <effort>]
 * --restricted --setting-sources "" --strict-mcp-config --mcp-config {"mcpServers":{}}
 * --disable-slash-commands --append-system-prompt-file <systemFile> --settings <settingsFile>
 * --permission-mode dontAsk --max-turns <maxTurns> [--max-budget-usd <n>] [--no-session-persistence]
 * --tools <comma-list>                           LAST; '' (an empty element) for no tools
 * ```
 */
export function buildArgv({ first, sessionId, model, effort, systemFile, settingsFile, maxTurns, maxBudgetUsd, noSessionPersistence, tools } = {}) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new TypeError(`buildArgv: sessionId must be a uuid (got ${JSON.stringify(sessionId)})`)
  requireString(systemFile, 'systemFile')
  requireString(settingsFile, 'settingsFile')
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new TypeError(`buildArgv: maxTurns must be a positive integer (got ${JSON.stringify(maxTurns)})`)
  const toolList = Array.isArray(tools) ? tools : []
  for (const t of toolList) {
    if (typeof t !== 'string' || !TOOL_RE.test(t)) throw new TypeError(`buildArgv: invalid tool name ${JSON.stringify(t)}`)
  }
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events']
  argv.push(first ? '--session-id' : '--resume', sessionId)
  if (typeof model === 'string' && model !== '') {
    if (!FLAG_VALUE_RE.test(model)) throw new TypeError(`buildArgv: invalid model ${JSON.stringify(model)}`)
    argv.push('--model', model)
  }
  if (typeof effort === 'string' && effort !== '') {
    if (!FLAG_VALUE_RE.test(effort)) throw new TypeError(`buildArgv: invalid effort ${JSON.stringify(effort)}`)
    argv.push('--effort', effort)
  }
  argv.push('--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG, '--disable-slash-commands')
  argv.push('--append-system-prompt-file', systemFile, '--settings', settingsFile, '--permission-mode', 'dontAsk')
  argv.push('--max-turns', String(maxTurns))
  if (typeof maxBudgetUsd === 'number' && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) argv.push('--max-budget-usd', String(maxBudgetUsd))
  if (noSessionPersistence) argv.push('--no-session-persistence')
  argv.push('--tools', toolList.join(','))
  return argv
}

// Child environment allowlist (SPEC §10.5).
//
// Role children get an allowlisted environment: what Claude Code needs to authenticate and reach
// the network, plus explicit cc-rsi settings. Everything that would tie a child to the outer
// session (session ids, remote-control sockets, ingress tokens, plugin variables) is never passed:
// a child without its own --session-id would otherwise append to the outer transcript
// (claude-code-experiments.md "Session-ID inheritance"), and inherited CLAUDE_CODE_* variables
// change the child's behaviour (EXP §f "Env inherited by the child").

import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/** Names (or patterns) copied from the parent when present (SPEC §10.5 PASS). */
export const PASS = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LANGUAGE', /^LC_/, 'TERM', 'TZ', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  /^ANTHROPIC_/, 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', /^CLAUDE_CODE_SKIP_.*_AUTH$/,
  'CLAUDE_CODE_OAUTH_TOKEN',
  /^AWS_/, 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', /^VERTEX_REGION_/,
  'CLAUDE_CONFIG_DIR', 'API_TIMEOUT_MS',
])

/** Names (or patterns) never passed; they win over PASS and passthrough (SPEC §10.5 NEVER). */
export const NEVER = Object.freeze([
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  /^CLAUDE_CODE_REMOTE/, /INGRESS/, /^CLAUDE_CODE_MESSAGING_/, 'CLAUDE_CODE_TEE_SDK_STDOUT', 'CLAUDE_CODE_USE_CCR_V2',
  'CLAUDE_CODE_CONTAINER_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_PID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_DIAGNOSTICS_FILE', 'CLAUDE_CODE_DEBUG', 'CLAUDE_AUTO_BACKGROUND_TASKS', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'MCP_TOOL_TIMEOUT', /^CCR_/, /^CLAUDE_PLUGIN_/, 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE',
  /^CLAUDE_CODE_SYNC_/, /^CLAUDE_CODE_ARTIFACT/, /^CC_RSI_/,
])

/**
 * Set for every role child (SPEC §10.5 SET, the unconditional part). Role-specific values
 * (CC_RSI_*, retry watchdog, DISABLE_AUTO_COMPACT, VERIFIER_SCRATCH, TMPDIR) come through `set`.
 */
export const BASE_SET = Object.freeze({
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  DISABLE_AUTOUPDATER: '1',
})

/** Whether `name` matches one entry of a PASS/NEVER-style list (strings exact, RegExps tested). */
function matchesAny(name, list) {
  for (const entry of list) {
    if (typeof entry === 'string' ? entry === name : entry instanceof RegExp && entry.test(name)) return true
  }
  return false
}

/**
 * Normalizes `children.envPassthrough` entries: exact names, `PREFIX_*` prefixes or RegExps.
 * Anything else is ignored.
 */
function passthroughMatchers(passthrough) {
  const out = []
  for (const entry of Array.isArray(passthrough) ? passthrough : []) {
    if (entry instanceof RegExp) out.push(entry)
    else if (typeof entry === 'string' && entry !== '') {
      if (entry.endsWith('*')) {
        const prefix = entry.slice(0, -1)
        out.push(name => name.startsWith(prefix))
      } else out.push(entry)
    }
  }
  return out
}

function matchesPassthrough(name, matchers) {
  for (const m of matchers) {
    if (typeof m === 'string' ? m === name : m instanceof RegExp ? m.test(name) : m(name)) return true
  }
  return false
}

/** Whether a variable name is never passed to a role child. */
export function isNeverName(name) {
  return matchesAny(name, NEVER)
}

/** Whether a variable name may be passed to a role child (PASS or passthrough, and not NEVER). */
export function isPassName(name, passthrough = []) {
  if (isNeverName(name)) return false
  return matchesAny(name, PASS) || matchesPassthrough(name, passthroughMatchers(passthrough))
}

function realOrResolved(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/**
 * PATH without the cc-rsi bin directories (`<pluginRoot>/bin`, `<home>/bin`): a role child must not
 * find the cc-rsi CLI (recursion closure, J2-4). Entries are compared by realpath (and lexically
 * when they do not exist). Empty entries are dropped as well (they mean the current directory).
 */
export function stripCcRsiBins(pathValue, { pluginRoot, home } = {}) {
  if (typeof pathValue !== 'string' || pathValue === '') return pathValue
  const banned = new Set()
  for (const dir of [pluginRoot && join(pluginRoot, 'bin'), home && join(home, 'bin')]) {
    if (!dir) continue
    banned.add(resolve(dir))
    banned.add(realOrResolved(dir))
  }
  const kept = pathValue.split(delimiter).filter(entry => {
    if (entry === '') return false
    if (banned.size === 0) return true
    return !banned.has(resolve(entry)) && !banned.has(realOrResolved(entry))
  })
  return kept.join(delimiter)
}

/**
 * The environment of one role child (SPEC §10.5).
 *  - PASS names (and `passthrough`, from global `children.envPassthrough`) are copied from `parentEnv`;
 *  - NEVER names are dropped even when PASS or passthrough match;
 *  - PATH loses the cc-rsi bin directories;
 *  - BASE_SET is applied, then `CC_RSI_ROLE = role`, then `set` (callers pass the per-role values).
 * A `set` key on the NEVER list other than a `CC_RSI_*` variable throws TypeError: cc-rsi
 * variables are always set explicitly, nothing else on that list may reach a child.
 */
export function childEnv({ parentEnv = process.env, role, set = {}, passthrough = [], pluginRoot, home } = {}) {
  const matchers = passthroughMatchers(passthrough)
  const env = {}
  for (const [name, value] of Object.entries(parentEnv ?? {})) {
    if (typeof value !== 'string') continue
    if (isNeverName(name)) continue
    if (matchesAny(name, PASS) || matchesPassthrough(name, matchers)) env[name] = value
  }
  if (typeof env.PATH === 'string') env.PATH = stripCcRsiBins(env.PATH, { pluginRoot, home })
  Object.assign(env, BASE_SET)
  if (typeof role === 'string' && role !== '') env.CC_RSI_ROLE = role
  for (const [name, value] of Object.entries(set ?? {})) {
    if (value === undefined || value === null) {
      delete env[name]
      continue
    }
    if (isNeverName(name) && !/^CC_RSI_/.test(name)) {
      throw new TypeError(`childEnv: ${name} may never be passed to a role child`)
    }
    env[name] = String(value)
  }
  return env
}

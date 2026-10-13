// SPEC §10.5 / §15.3 WP4 `env.test.mjs`: against a snapshot of this container's env (EXP §f list plus the
// variables present in the WP4 build container) and a passthrough attempting CLAUDE_CODE_SESSION_ID: no NEVER
// name survives; PATH loses the cc-rsi bins; SET values present.

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { BASE_SET, childEnv, isNeverName, isPassName, NEVER, PASS, stripCcRsiBins } from '../../lib/runtime/env.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

// claude-code-experiments.md §f "Env inherited by the child" (the 55 ^CLAUDE names) …
const EXP_F_CLAUDE = ['CLAUDECODE', ...['ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'ACCOUNT_UUID', 'ARTIFACT_MULTI_FILE', 'CHILD_SESSION', 'USER_EMAIL',
  'DISABLE_BACKGROUND_TASKS', 'SESSION_ID', 'DEBUG', 'REMOTE_SDK_URL', 'BG_TASKS_REPORT_RUNNING', 'ARTIFACT_TYPE_CATALOG', 'GZIP_REQUEST_BODIES',
  'ARTIFACT_ASSETS', 'PROVIDER_MANAGED_BY_HOST', 'ARTIFACT_TYPE_CLOUD_CREATE', 'MESSAGING_SOCKET', 'CONTAINER_ID', 'ARTIFACT_DB', 'ARTIFACT_TYPES',
  'REMOTE_ENVIRONMENT_TYPE', 'WORKER_EPOCH', 'SESSION_ATTENDED', 'REMOTE_SESSION_ID', 'PROXY_RESOLVES_HOSTS', 'MODEL_CAPABILITIES', 'DIAGNOSTICS_FILE',
  'REMOTE_HERMETIC_MODE', 'ENVIRONMENT_RUNNER_VERSION', 'DISABLE_BUILTIN_ANTMCP', 'MAX_SUBAGENT_SPAWN_DEPTH', 'USE_CCR_V2', 'SYNC_SESSION_REFS',
  'MAX_MCP_DESCRIPTION_LENGTH', 'TEE_SDK_STDOUT', 'ENTRYPOINT', 'VERSION', 'EXECPATH', 'REMOTE_SEND_KEEPALIVES', 'REMOTE', 'POST_FOR_SESSION_INGRESS_V2',
  'ORGANIZATION_UUID', 'SYNC_PLUGINS', 'SYNC_SKILLS', 'HOLD_UNANSWERED_PARKED_PERMISSION', 'DISABLE_REFUSAL_FALLBACK', 'MESSAGING_TOKEN'].map(n => `CLAUDE_CODE_${n}`),
...['PID', 'AUTO_BACKGROUND_TASKS', 'AFTER_LAST_COMPACT', 'EFFORT', 'AUTOCOMPACT_PCT_OVERRIDE', 'ENABLE_STREAM_WATCHDOG', 'ADDITIONAL_DIRECTORIES',
  'SESSION_INGRESS_TOKEN_FILE'].map(n => `CLAUDE_${n}`)]
// … plus the rest of the build container's env and the plugin/hook-only variables (EXP §a).
const CONTAINER = ['AI_AGENT', 'ANTHROPIC_BASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_CA_BUNDLE', 'AWS_SECRET_ACCESS_KEY', 'BUN_INSTALL', 'CCR_AGENT_PROXY_ENABLED',
  'CCR_SESSION_PROFILE', 'CCR_SPAWN_TIMESTAMP_MS', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CURL_CA_BUNDLE', 'DEBIAN_FRONTEND', 'DISABLE_AUTOUPDATER', 'GH_TOKEN',
  'GITHUB_TOKEN', 'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'HOME', 'HTTPS_PROXY', 'IS_SANDBOX', 'JAVA_HOME', 'MAX_THINKING_TOKENS', 'MCP_CONNECTION_NONBLOCKING',
  'MCP_TOOL_TIMEOUT', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'NODE_PATH', 'NO_PROXY', 'OLDPWD', 'PATH', 'PWD', 'REQUESTS_CA_BUNDLE', 'SESSION_INGRESS_URL',
  'SHELL', 'SSL_CERT_FILE', 'TERM', 'TRACEPARENT', 'https_proxy', 'no_proxy', 'LANG', 'LC_ALL', 'TZ', 'USER', 'TMPDIR', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_OPTION_SANDBOX', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE', 'CC_RSI_ROLE', 'CC_RSI_HOME',
  'CC_RSI_CLAUDE_BIN', 'CC_RSI_OPT_SANDBOX', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', 'VERTEX_REGION_CLAUDE_4', 'API_TIMEOUT_MS', 'LOGNAME', 'LANGUAGE', 'ALL_PROXY', 'http_proxy']

function snapshot() {
  const env = {}
  for (const name of [...EXP_F_CLAUDE, ...CONTAINER]) env[name] = `value-of-${name}`
  env.PATH = '/usr/local/bin:/usr/bin:/bin'
  return env
}

test('the snapshot covers the EXP §f list (55 ^CLAUDE names)', () => {
  assert.equal(EXP_F_CLAUDE.length, 55)
})

test('no NEVER name survives, even with a passthrough naming one', () => {
  const env = childEnv({ parentEnv: snapshot(), role: 'verifier', passthrough: ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_*', 'CCR_*', 'MCP_TOOL_TIMEOUT', /^CC_RSI_/],
    set: { CC_RSI_EXPECT: 'abc' } })
  for (const name of Object.keys(env)) {
    if (name.startsWith('CC_RSI_')) continue // explicitly set
    assert.ok(!isNeverName(name), `${name} must never reach a role child`)
  }
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined)
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.CLAUDE_CODE_REMOTE_SESSION_ID, undefined)
  assert.equal(env.CLAUDE_SESSION_INGRESS_TOKEN_FILE, undefined)
  assert.equal(env.CLAUDE_CODE_EXECPATH, undefined)
  assert.equal(env.CC_RSI_HOME, undefined, 'inherited CC_RSI_* never passes')
  assert.equal(env.CC_RSI_CLAUDE_BIN, undefined)
  assert.equal(env.CC_RSI_ROLE, 'verifier')
  assert.equal(env.CC_RSI_EXPECT, 'abc')
})

test('only PASS names (and BASE_SET/role) survive without a passthrough', () => {
  const env = childEnv({ parentEnv: snapshot(), role: 'actor' })
  for (const name of Object.keys(env)) {
    if (name in BASE_SET || name === 'CC_RSI_ROLE') continue
    assert.ok(isPassName(name), `${name} is not on the PASS list`)
  }
  for (const name of ['HOME', 'PATH', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'USER', 'LOGNAME', 'LANGUAGE', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY',
    'no_proxy', 'ALL_PROXY', 'http_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
    'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', 'VERTEX_REGION_CLAUDE_4', 'CLAUDE_CONFIG_DIR', 'API_TIMEOUT_MS']) {
    assert.ok(name in env, `${name} should pass`)
  }
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'IS_SANDBOX', 'PWD', 'OLDPWD', 'SESSION_INGRESS_URL', 'TRACEPARENT',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_MODEL_CAPABILITIES', 'MAX_THINKING_TOKENS']) {
    assert.ok(!(name in env), `${name} should not pass`)
  }
})

test('SET values: BASE_SET always, role and caller values win', () => {
  const env = childEnv({ parentEnv: snapshot(), role: 'verifier', set: { CC_RSI_HOME: '/h', CC_RSI_POLICY: '/h/run/policies/x.json',
    CC_RSI_GUARD_LOG: '/g.jsonl', CC_RSI_EXPECT: 'd', DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_RETRY_WATCHDOG: '1', VERIFIER_SCRATCH: '/s', TMPDIR: '/s/tmp' } })
  for (const [k, v] of Object.entries(BASE_SET)) assert.equal(env[k], v)
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1')
  assert.equal(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1')
  assert.equal(env.DISABLE_AUTOUPDATER, '1')
  assert.equal(env.CC_RSI_ROLE, 'verifier')
  assert.equal(env.CC_RSI_HOME, '/h')
  assert.equal(env.DISABLE_AUTO_COMPACT, '1')
  assert.equal(env.TMPDIR, '/s/tmp', 'set overrides the inherited TMPDIR')
  assert.equal(env.VERIFIER_SCRATCH, '/s')
})

test('set refuses NEVER names other than CC_RSI_*', () => {
  assert.throws(() => childEnv({ parentEnv: {}, role: 'actor', set: { CLAUDE_CODE_SESSION_ID: 'x' } }), TypeError)
  assert.throws(() => childEnv({ parentEnv: {}, role: 'actor', set: { CLAUDECODE: '1' } }), TypeError)
  assert.doesNotThrow(() => childEnv({ parentEnv: {}, role: 'actor', set: { CC_RSI_EXPECT: 'x' } }))
})

test('passthrough: exact names and PREFIX_* widen PASS', () => {
  const parentEnv = { MY_TOKEN: 'a', CORP_A: 'b', CORP_B: 'c', OTHER: 'd' }
  const env = childEnv({ parentEnv, role: 'actor', passthrough: ['MY_TOKEN', 'CORP_*'] })
  assert.equal(env.MY_TOKEN, 'a')
  assert.equal(env.CORP_A, 'b')
  assert.equal(env.CORP_B, 'c')
  assert.equal(env.OTHER, undefined)
})

test('PATH loses <pluginRoot>/bin and <home>/bin (lexically and through symlinks) and empty entries', async () => {
  const base = await tmpDir()
  const pluginRoot = join(base, 'plugin')
  const home = join(base, 'home')
  mkdirSync(join(pluginRoot, 'bin'), { recursive: true })
  mkdirSync(join(home, 'bin'), { recursive: true })
  symlinkSync(join(home, 'bin'), join(base, 'link-to-home-bin'))
  const path = ['/usr/bin', join(pluginRoot, 'bin'), '', join(base, 'link-to-home-bin'), `${join(home, 'bin')}/`, '/bin'].join(':')
  assert.equal(stripCcRsiBins(path, { pluginRoot, home }), '/usr/bin:/bin')
  const env = childEnv({ parentEnv: { PATH: path }, role: 'actor', pluginRoot, home })
  assert.equal(env.PATH, '/usr/bin:/bin')
})

test('the PASS and NEVER lists are the SPEC §10.5 lists', () => {
  assert.ok(PASS.includes('CLAUDE_CODE_OAUTH_TOKEN'))
  assert.ok(NEVER.some(e => e instanceof RegExp && e.test('CC_RSI_ANYTHING')))
  assert.ok(isNeverName('CLAUDE_CODE_REMOTE_SEND_KEEPALIVES'))
  assert.ok(isNeverName('CLAUDE_SESSION_INGRESS_TOKEN_FILE'))
  assert.ok(isNeverName('CLAUDE_CODE_ARTIFACT_DB'))
  assert.ok(isNeverName('CLAUDE_CODE_SYNC_PLUGINS'))
  assert.ok(!isNeverName('ANTHROPIC_BASE_URL'))
})

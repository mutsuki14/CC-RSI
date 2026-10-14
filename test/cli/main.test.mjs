// CLI dispatch, argument parsing and the two refusals (SPEC §13.1, §15.3 WP7 cli row):
// role context → exit 64 for every command; human-only commands → exit 65 under CLAUDECODE, before
// any side effect; usage errors → exit 2.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { main, parseArgs, pluginUserConfig, savedPluginOptions, shellQuote, VERSION } from '../../lib/cli/main.mjs'
import { writeShim } from '../../lib/cli/shim.mjs'
import { UsageError } from '../../lib/core/errors.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const BIN = join(ROOT, 'bin', 'cc-rsi')

/** A hermetic env: temp CC_RSI_HOME and CLAUDE_CONFIG_DIR, no Claude Code session variables. */
async function hermeticEnv(extra = {}) {
  const { home, env } = await tmpHome()
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_') || name.startsWith('CC_RSI_') || name === 'CLAUDE_CODE_EXECPATH' || name === 'ANTHROPIC_MODEL') delete env[name]
  }
  env.CC_RSI_HOME = home
  env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
  return { home, env: { ...env, ...extra } }
}

function capture({ env, cwd, isTTY = false }) {
  const out = []
  const err = []
  return {
    io: { stdout: { write: s => out.push(String(s)), isTTY }, stderr: { write: s => err.push(String(s)) }, env, cwd, isTTY },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

describe('parseArgs', () => {
  const spec = { string: ['session', 'n'], boolean: ['json', 'yes'], alias: { n: 'n' } }
  it('accepts --key value, --key=value, --flag, aliases and options anywhere', () => {
    assert.deepEqual(parseArgs(['status', '--json', '--session', 'abc', 'x', '-n', '5', '--yes'], spec), {
      positionals: ['status', 'x'], options: { json: true, session: 'abc', n: '5', yes: true },
    })
    assert.deepEqual(parseArgs(['--session=a=b', 'p'], spec), { positionals: ['p'], options: { session: 'a=b' } })
    assert.deepEqual(parseArgs(['a', '--', '--json', '-n'], spec), { positionals: ['a', '--json', '-n'], options: {} })
    assert.deepEqual(parseArgs(['-'], spec), { positionals: ['-'], options: {} })
    assert.deepEqual(parseArgs(['--session', '-x'], spec).options, { session: '-x' })
  })
  it('rejects unknown options, missing values and values for booleans', () => {
    assert.throws(() => parseArgs(['--nope'], spec), UsageError)
    assert.throws(() => parseArgs(['-z'], spec), UsageError)
    assert.throws(() => parseArgs(['--n'], spec), UsageError)
    assert.throws(() => parseArgs(['--n', '--json'], spec), UsageError)
    // `--session ${CLAUDE_SESSION_ID}` expanding to nothing in a skill means "no session".
    assert.deepEqual(parseArgs(['status', '--session'], spec), { positionals: ['status'], options: {} })
    assert.deepEqual(parseArgs(['--session', '--json'], spec), { positionals: [], options: { json: true } })
    assert.throws(() => parseArgs(['--session'], { ...spec, optional: [] }), UsageError)
    assert.throws(() => parseArgs(['--json=1'], spec), UsageError)
  })
})

describe('cc-rsi main', () => {
  it('prints the version and the usage', async () => {
    const { env, home } = await hermeticEnv()
    const c = capture({ env, cwd: home })
    assert.equal(await main(['version'], c.io), 0)
    assert.match(c.out(), new RegExp(`^cc-rsi ${VERSION.replace(/\./g, '\\.')} \\(node `))
    const h = capture({ env, cwd: home })
    assert.equal(await main(['help'], h.io), 0)
    assert.match(h.out(), /human-only: refused inside Claude Code/)
    const none = capture({ env, cwd: home })
    assert.equal(await main([], none.io), 2)
    const bad = capture({ env, cwd: home })
    assert.equal(await main(['frobnicate'], bad.io), 2)
    assert.match(bad.err(), /unknown command "frobnicate"/)
    const badOpt = capture({ env, cwd: home })
    assert.equal(await main(['status', '--nope'], badOpt.io), 2)
  })

  it('refuses every command inside a role context with exit 64 (J2-4)', async () => {
    const { env, home } = await hermeticEnv({ CC_RSI_ROLE: 'actor' })
    for (const argv of [['version'], ['status'], ['doctor'], ['memory', 'show'], ['explore', 'list'], ['eval', 'show', 'x'], ['gc'], ['help'], []]) {
      const c = capture({ env, cwd: home })
      assert.equal(await main(argv, c.io), 64, argv.join(' '))
      assert.equal(c.err().trim(), 'cc-rsi: refusing to run inside a cc-rsi role context (CC_RSI_ROLE is set)')
      assert.equal(c.out(), '')
    }
    // The CommonJS bin refuses before loading any ESM module.
    const r = await runNode(BIN, ['status'], { env, cwd: home })
    assert.equal(r.code, 64)
    assert.match(r.stderr, /refusing to run inside a cc-rsi role context/)
  })

  it('refuses every human-only command under CLAUDECODE with exit 65 and changes nothing (J2-6)', async () => {
    const { env, home } = await hermeticEnv({ CLAUDECODE: '1' })
    const repo = await gitRepo({ 'a.txt': 'a\n' })
    const cases = [
      ['eval', 'run', 'deep-1'],
      ['eval', 'run', 'deep-1', '--json-out', join(home, 'x.json')],
      ['eval', 'show', 'deep-1'],
      ['memory', 'restore', '1'],
      ['memory', 'unfreeze'],
      ['memory', 'unfreeze', '--after-sealed'],
      ['memory', 'import', repo],
      ['memory', 'verify', '--accept-external'],
      ['memory', 'drafts', '--prune'],
      ['explore', 'abandon', 'broad-1'],
      ['doctor', '--release-lock', repo],
      ['verify', 'cancel'],
      ['verify', 'cancel', '--session', 'abc'],
    ]
    for (const argv of cases) {
      const c = capture({ env, cwd: repo })
      assert.equal(await main(argv, c.io), 65, argv.join(' '))
      // portability-6: the refusal names a command the user can run in a terminal (no shim yet: node + the bin).
      const runnable = `node ${shellQuote(join(ROOT, 'bin', 'cc-rsi'))} ${argv.map(shellQuote).join(' ')}`
      assert.equal(c.err(), `${c.err().split('\n')[0]}\nin a terminal, run: ${runnable}\n`, argv.join(' '))
      assert.match(c.err(), /^cc-rsi: ".+" is human-only: run it in a terminal outside Claude Code\n/, argv.join(' '))
    }
    // Nothing was created under the home by a refused command.
    assert.deepEqual(readdirSync(home).filter(n => n !== 'logs'), [])
    // Non-human-only subcommands of the same families still work under CLAUDECODE.
    for (const argv of [['memory', 'verify'], ['memory', 'drafts'], ['explore', 'list'], ['status']]) {
      const c = capture({ env, cwd: repo })
      assert.equal(await main(argv, c.io), 0, `${argv.join(' ')}: ${c.err()}`)
    }
    // The bin refuses the same way.
    const r = await runNode(BIN, ['memory', 'unfreeze'], { env, cwd: repo })
    assert.equal(r.code, 65)
  })

  it('verify cancel reports when nothing is running', async () => {
    const { env } = await hermeticEnv()
    const repo = await gitRepo({ 'a.txt': 'a\n' })
    const c = capture({ env, cwd: repo })
    assert.equal(await main(['verify', 'cancel'], c.io), 0)
    assert.match(c.out(), /no verification is running/)
    assert.equal(existsSync(join(env.CC_RSI_HOME, 'projects')), false)
  })

  it('a human-only refusal names the terminal shim once SessionStart wrote it (portability-6)', async () => {
    const { env, home } = await hermeticEnv({ CLAUDECODE: '1' })
    const repo = await gitRepo({ 'a.txt': 'a\n' })
    await writeShim(home, ROOT)
    const c = capture({ env, cwd: repo })
    assert.equal(await main(['memory', 'unfreeze', '--after-sealed'], c.io), 65)
    assert.ok(c.err().endsWith(`\nin a terminal, run: ${shellQuote(join(home, 'bin', 'cc-rsi'))} memory unfreeze --after-sealed\n`), c.err())
  })

  it('--report-exit prints the exit status in-band and exits 0 (cc-integration-4)', async () => {
    const { env, home } = await hermeticEnv()
    const repo = await gitRepo({ 'a.txt': 'a\n' })
    // A usage error (2), a human-only refusal (65) and success (0), each reported as the last stdout line.
    const usage = capture({ env, cwd: repo })
    assert.equal(await main(['memory', '--report-exit', 'frobnicate'], usage.io), 0)
    assert.match(usage.out(), /\[cc-rsi exit 2\]\n$/)
    const human = capture({ env: { ...env, CLAUDECODE: '1' }, cwd: repo })
    assert.equal(await main(['memory', 'unfreeze', '--report-exit'], human.io), 0)
    assert.match(human.out(), /^\[cc-rsi exit 65\]\n$/)
    assert.match(human.err(), /is human-only/)
    assert.doesNotMatch(human.err(), /--report-exit/, 'the runnable command omits the flag')
    const ok = capture({ env, cwd: home })
    assert.equal(await main(['version', '--report-exit'], ok.io), 0)
    assert.match(ok.out(), /^cc-rsi .*\n\[cc-rsi exit 0\]\n$/)
    // Without the flag the real code is returned; the command word is never taken as the flag.
    assert.equal(await main(['memory', 'frobnicate'], capture({ env, cwd: repo }).io), 2)
    assert.equal(await main(['--report-exit', 'version'], capture({ env, cwd: home }).io), 2)
    // After `--` it is an argument, not the flag.
    const after = capture({ env, cwd: home })
    assert.equal(await main(['engine', '--', '--report-exit'], after.io), 2)
    assert.doesNotMatch(after.out(), /cc-rsi exit/)
  })

  it('engine run needs a lineage directory', async () => {
    const { env, home } = await hermeticEnv()
    const c = capture({ env, cwd: home })
    assert.equal(await main(['engine'], c.io), 2)
  })
})

describe('saved plugin options (portability-3)', () => {
  /** A Claude Code config dir whose user settings hold `pluginConfigs`. */
  async function configDir(pluginConfigs) {
    const dir = await tmpDir('cc-rsi-claude-config-')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'opus', pluginConfigs }))
    return dir
  }

  it('reads the cc-rsi entry of Claude Code user settings; the installing marketplace wins; require always applies', async () => {
    const dir = await configDir({
      'cc-rsi@inline': { options: { sandbox: 'off', verifier_model: 'haiku', stop_policy: 'gate', api_token: 'x' } },
      'cc-rsi@mkt': { options: { sandbox: 'auto', verifier_model: 'sonnet' } },
      'other@mkt': { options: { sandbox: 'require' } },
    })
    const env = { CLAUDE_CONFIG_DIR: dir }
    assert.deepEqual(savedPluginOptions(env, { pluginRoot: '/srv/cc-rsi' }).options, { sandbox: 'off', verifier_model: 'haiku', stop_policy: 'gate' })
    const cached = savedPluginOptions(env, { pluginRoot: join(dir, 'plugins', 'cache', 'mkt', 'cc-rsi', '0.1.0') })
    assert.deepEqual(cached.options, { sandbox: 'auto', verifier_model: 'sonnet' })
    assert.equal(cached.source, `${join(dir, 'settings.json')} pluginConfigs["cc-rsi@mkt"]`)
    const strict = await configDir({ 'cc-rsi@a': { options: { sandbox: 'require' } }, 'cc-rsi@b': { options: { verifier_model: 'opus' } } })
    assert.deepEqual(savedPluginOptions({ CLAUDE_CONFIG_DIR: strict }, { pluginRoot: '/srv/cc-rsi' }).options, { sandbox: 'require' })
    assert.deepEqual(savedPluginOptions({ CLAUDE_CONFIG_DIR: await tmpDir() }).options, {})
    // CLAUDE_PLUGIN_OPTION_* (hook processes) overrides the saved value.
    const only = await configDir({ 'cc-rsi@inline': { options: { verifier_model: 'haiku' } } })
    assert.deepEqual(pluginUserConfig({ CLAUDE_CONFIG_DIR: only, CLAUDE_PLUGIN_OPTION_VERIFIER_MODEL: 'opus' }).options.verifier_model, 'opus')
  })

  it('a saved sandbox=require blocks lineages even with --allow-unconfined, and doctor uses the saved verifier_model', async () => {
    const { env, home } = await hermeticEnv()
    env.CLAUDE_CONFIG_DIR = await configDir({ 'cc-rsi@inline': { options: { sandbox: 'require', verifier_model: 'saved-verifier-model' } } })
    // No OS sandbox anywhere: an empty PATH hides bwrap and socat.
    env.PATH = await tmpDir('cc-rsi-empty-path-')
    const repo = await gitRepo({ 'a.txt': 'a\n' })
    writeFileSync(join(repo, 'ideas.md'), 'write a haiku file\n')
    let records = null
    try {
      records = await import('../../lib/engine/records.mjs')
    } catch {
      records = null
    }
    if (records?.preflight && process.platform !== 'darwin') {
      const c = capture({ env, cwd: repo })
      const code = await main(['explore', 'preflight', '--phase', 'broad', '--direction-file', 'ideas.md', '--allow-unconfined', '--skip-auth-probe'], c.io)
      assert.equal(code, 3, c.out() + c.err())
      assert.match(c.out(), /BLOCKERS:[\s\S]*required \(isolation\.sandbox=require\)/)
    }
    const { projectContext } = await import('../../lib/cli/main.mjs')
    const ctx = await projectContext({ env, cwd: repo })
    assert.equal(ctx.config.models.verifier, 'saved-verifier-model')
    assert.equal(ctx.config.isolation.sandbox, 'require')
    assert.equal(ctx.sources['isolation.sandbox'], 'userConfig')
    assert.ok(existsSync(home))
  })
})

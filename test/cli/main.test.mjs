// CLI dispatch, argument parsing and the two refusals (SPEC §13.1, §15.3 WP7 cli row):
// role context → exit 64 for every command; human-only commands → exit 65 under CLAUDECODE, before
// any side effect; usage errors → exit 2.

import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { main, parseArgs, VERSION } from '../../lib/cli/main.mjs'
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
      assert.match(c.err(), /^cc-rsi: ".+" is human-only: run it in a terminal outside Claude Code\n$/, argv.join(' '))
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

  it('engine run needs a lineage directory', async () => {
    const { env, home } = await hermeticEnv()
    const c = capture({ env, cwd: home })
    assert.equal(await main(['engine'], c.io), 2)
  })
})

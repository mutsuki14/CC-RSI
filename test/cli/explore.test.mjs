// `cc-rsi explore …` (SPEC §13.1, §12.2, §12.15, §15.3 WP7 cli row) against the real engine (WP6)
// and the fake claude: start without --yes → preflight; the unconfined blocker without
// --allow-unconfined; a foreground lineage; status/list/log/show (with --fork-session hints) that
// never print report text; stop → resume; abandon (human-only). Skipped when lib/engine is absent.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { main } from '../../lib/cli/main.mjs'
import { lineageLayout, projectKey, projectLayout } from '../../lib/core/paths.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { fakeClaude } from '../_helpers/fake.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const WORLD = join(ROOT, 'test', 'engine', 'scenarios', 'world.mjs')

let engineAvailable = false
try {
  await import('../../lib/engine/records.mjs')
  await import('../../lib/engine/daemon.mjs')
  engineAvailable = existsSync(WORLD)
} catch {
  engineAvailable = false
}
const skip = engineAvailable ? false : 'lib/engine (WP6) or its world scenario is not available'

const spawnedPids = new Set()
after(() => {
  for (const pid of spawnedPids) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
})

const sleep = ms => new Promise(res => setTimeout(res, ms))

async function setup(world = {}) {
  const { home } = await tmpHome()
  const fake = await fakeClaude({ scenario: WORLD, home })
  const env = { ...fake.env, CLAUDE_CONFIG_DIR: await tmpDir('cc-rsi-claude-config-') }
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_') || name === 'CLAUDE_CODE_EXECPATH' || name === 'ANTHROPIC_MODEL') delete env[name]
  }
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    children: { claudeBin: fake.bin },
    models: { actor: 'actor-model', verifier: 'verifier-model', curriculum: 'curriculum-model' },
    transport: { pauseSecs: 0, pauseMaxSecs: 0 },
  }))
  writeFileSync(join(fake.fakeHome, 'world.json'), JSON.stringify(world))
  const repo = await gitRepo({ 'README.md': 'project\n' })
  const root = await gitProjectRoot(repo)
  const pl = projectLayout(home, projectKey(root))
  const run = async (argv, extraEnv = {}) => {
    const out = []
    const err = []
    const code = await main(argv, { stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => err.push(s) }, env: { ...env, ...extraEnv }, cwd: repo, isTTY: false })
    return { code, stdout: out.join(''), stderr: err.join('') }
  }
  const state = id => {
    try { return JSON.parse(readFileSync(join(lineageLayout(pl, id).dir, 'state.json'), 'utf8')) } catch { return null }
  }
  return { home, env, fake, repo, root, pl, run, state, setWorld: w => writeFileSync(join(fake.fakeHome, 'world.json'), JSON.stringify(w)) }
}

/** Every stored Verifier report body (none of their text may appear in status/log/list output). */
function reportTexts(s) {
  const dir = join(s.pl.store, 'reports')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8')).filter(t => t.trim() !== '')
}

function assertNoReportText(s, text) {
  for (const report of reportTexts(s)) {
    for (const line of report.split('\n').map(l => l.trim()).filter(l => l.length > 20)) {
      assert.ok(!text.includes(line), `report text leaked: ${line}`)
    }
  }
}

async function waitFor(predicate, ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(100)
  }
  return false
}

const ONE_WAVE = { waves: [[{ id: 'alpha', files: { 'input.txt': 'alpha\n' } }]], afterWaves: 'SATURATED', verdicts: { '*': ['PASS'] } }

describe('cc-rsi explore', { skip }, () => {
  it('start without --yes prints the preflight; blockers refuse with exit 3 and create nothing', async () => {
    const s = await setup(ONE_WAVE)
    const blocked = await s.run(['explore', 'start', '--phase', 'broad', '--direction', 'tiny text tools'])
    assert.equal(blocked.code, 3)
    assert.match(blocked.stdout, /BLOCKERS:\n {2}- no OS sandbox is available .*Re-run with --allow-unconfined/s)
    assert.match(blocked.stdout, /resolve the blockers above, then re-run with --yes to launch/)
    const plan = await s.run(['explore', 'start', '--phase', 'broad', '--direction', 'tiny text tools', '--allow-unconfined', '--skip-auth-probe'])
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    assert.match(plan.stdout, /^cc-rsi explore start — broad lineage broad-\d{14}$/m)
    assert.match(plan.stdout, /isolation: unconfined .* WARNING: role children run Bash unattended/)
    assert.match(plan.stdout, /re-run with --yes to launch\n$/)
    const pre = await s.run(['explore', 'preflight', '--phase', 'deep', '--allow-unconfined'])
    assert.equal(pre.code, 3)
    assert.match(pre.stdout, /a deep lineage needs --target or --target-file/)
    const refused = await s.run(['explore', 'start', '--phase', 'broad', '--direction', 'tiny', '--yes', '--id', 'b-refused'])
    assert.equal(refused.code, 3)
    assert.match(refused.stdout, /explore start refused:\nBLOCKERS:\n {2}- no OS sandbox/)
    assert.equal(existsSync(s.pl.lineages) ? readdirSync(s.pl.lineages).length : 0, 0, 'no lineage was created')
    assert.equal(s.fake.log().filter(e => e.argv.includes('-p')).length, 0, 'no model call')
    const usage = await s.run(['explore', 'start', '--phase', 'sideways'])
    assert.equal(usage.code, 2)
  })

  it('runs a foreground lineage; status, list, log and show never print report text', async () => {
    const s = await setup(ONE_WAVE)
    const r = await s.run(['explore', 'start', '--phase', 'broad', '--direction', 'tiny text tools', '--id', 'b1', '--allow-unconfined', '--foreground', '--yes', '--model', 'haiku-x'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /lineage b1: completed \(termination saturated\)/)
    const result = JSON.parse(readFileSync(join(lineageLayout(s.pl, 'b1').dir, 'result.json'), 'utf8'))
    assert.equal(result.termination, 'saturated')
    // --model applies to the Actor, Verifier and Curriculum; the auth probe ran (no --skip-auth-probe).
    const calls = s.fake.log().filter(e => e.argv.includes('-p'))
    const models = new Set(calls.filter(c => c.ccRsi.CC_RSI_ROLE !== 'summarizer').map(c => c.argv[c.argv.indexOf('--model') + 1]))
    assert.deepEqual([...models], ['haiku-x'])
    assert.ok(calls.some(c => c.ccRsi.CC_RSI_ROLE === 'summarizer'), 'auth preflight call')
    assert.ok(reportTexts(s).length > 0)
    const status = await s.run(['explore', 'status', 'b1'])
    assert.equal(status.code, 0)
    assert.match(status.stdout, /^lineage b1 \(broad\): completed$/m)
    assert.match(status.stdout, /^ended: saturated/m)
    assert.match(status.stdout, /models: actor=haiku-x verifier=haiku-x curriculum=haiku-x/)
    const all = await s.run(['explore', 'status'])
    assert.match(all.stdout, /^b1 {2}broad {2}completed \[saturated\] {2}\(wave \d+, 1 projects\)/m)
    const json = JSON.parse((await s.run(['explore', 'status', 'b1', '--json'])).stdout)
    assert.equal(json.result.termination, 'saturated')
    const list = await s.run(['explore', 'list', '--session', 'ignored-session'])
    assert.equal(list.stdout, 'b1  broad  completed [saturated]\n')
    const log = await s.run(['explore', 'log', 'b1', '-n', '500'])
    assert.equal(log.code, 0)
    const types = log.stdout.trim().split('\n').map(l => l.split(/\s+/)[1])
    assert.ok(types.includes('LINEAGE_STARTED') && types.includes('PHASE1_TERMINATED'), types.join(','))
    assert.ok(log.stdout.trim().split('\n').every(l => /^\S+ {2}[A-Z_0-9]+/.test(l)))
    const show = await s.run(['explore', 'show', 'b1'])
    assert.equal(show.code, 0)
    assert.match(show.stdout, /inspect without mutating: claude --resume [0-9a-f-]{36} --fork-session/)
    for (const text of [status.stdout, all.stdout, list.stdout, log.stdout, JSON.stringify(json)]) assertNoReportText(s, text)
    const missing = await s.run(['explore', 'status', 'nope'])
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /no lineage nope/)
  })

  it('stops a detached engine (paused_user), resumes it to completion, and abandons only from a terminal', async () => {
    const s = await setup({ ...ONE_WAVE, delayMs: 400 })
    const started = await s.run(['explore', 'start', '--phase', 'broad', '--direction', 'tiny', '--id', 'b2', '--allow-unconfined', '--skip-auth-probe', '--yes'])
    assert.equal(started.code, 0, started.stdout + started.stderr)
    const pid = Number((/engine pid (\d+)/.exec(started.stdout) ?? [])[1])
    assert.ok(pid > 0)
    spawnedPids.add(pid)
    assert.ok(await waitFor(() => s.state('b2')?.status === 'running'), 'the engine started')
    await sleep(600)
    const stopped = await s.run(['explore', 'stop', 'b2', '--timeout', '30'])
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr)
    assert.match(stopped.stdout, /lineage b2: paused_user/)
    const paused = await s.run(['explore', 'status', 'b2'])
    assert.match(paused.stdout, /continue with: cc-rsi explore resume b2/)
    s.setWorld(ONE_WAVE)
    const resumed = await s.run(['explore', 'resume', 'b2', '--foreground'])
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr)
    assert.match(resumed.stdout, /lineage b2: completed \(termination saturated\)/)
    const again = await s.run(['explore', 'resume', 'b2'])
    assert.equal(again.code, 3)
    assert.match(again.stdout, /^resume refused: the lineage has ended/m)

    // Abandon a paused lineage: human-only.
    s.setWorld({ ...ONE_WAVE, delayMs: 400 })
    const third = await s.run(['explore', 'start', '--phase', 'broad', '--direction', 'tiny', '--id', 'b3', '--allow-unconfined', '--skip-auth-probe', '--yes'])
    const pid3 = Number((/engine pid (\d+)/.exec(third.stdout) ?? [])[1])
    spawnedPids.add(pid3)
    assert.ok(await waitFor(() => s.state('b3')?.status === 'running'))
    await sleep(300)
    assert.equal((await s.run(['explore', 'stop', 'b3', '--timeout', '30'])).code, 0)
    assert.equal((await s.run(['explore', 'abandon', 'b3'], { CLAUDECODE: '1' })).code, 65)
    assert.equal(existsSync(join(lineageLayout(s.pl, 'b3').dir, 'result.json')), false)
    const abandoned = await s.run(['explore', 'abandon', 'b3', '--reason', 'operator decision'])
    assert.equal(abandoned.code, 0, abandoned.stdout + abandoned.stderr)
    const result = JSON.parse(readFileSync(join(lineageLayout(s.pl, 'b3').dir, 'result.json'), 'utf8'))
    assert.deepEqual([result.termination, result.rationale], ['abandoned', 'operator decision'])
    const notRunning = await s.run(['explore', 'stop', 'b3'])
    assert.match(notRunning.stdout, /is not running/)
  })
})

describe('cc-rsi explore stop after a hostname change (portability-7)', () => {
  /** A lineage whose engine lease names another hostname, held by a live local stand-in engine. */
  async function renamedHost({ cmdline = 'daemon' } = {}) {
    const { home, env } = await tmpHome()
    for (const name of Object.keys(env)) if (name.startsWith('CC_RSI_') || name.startsWith('CLAUDE_PLUGIN_')) delete env[name]
    env.CC_RSI_HOME = home
    env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
    const repo = await gitRepo({ 'README.md': 'project\n' })
    const pl = projectLayout(home, projectKey(await gitProjectRoot(repo)))
    const id = '20261013-000000-abcd'
    const dir = lineageLayout(pl, id).dir
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'lineage.json'), JSON.stringify({ v: 1, id, phase: 'broad' }))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, id, phase: 'broad', status: 'running' }))
    const bin = await tmpDir('cc-rsi-engine-')
    mkdirSync(join(bin, 'lib', 'engine'), { recursive: true })
    const script = cmdline === 'daemon' ? join(bin, 'lib', 'engine', 'daemon.mjs') : join(bin, 'cc-rsi-tool.mjs')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
process.on('SIGTERM', () => {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, status: 'paused_user', pausedAt: new Date().toISOString() }))
  process.exit(0)
})
setInterval(() => {}, 1000)
`)
    const child = spawn(process.execPath, [script, dir], { detached: true, stdio: 'ignore' })
    spawnedPids.add(child.pid)
    await sleep(300)
    // Written moments ago by this machine under its previous name: the lease is live.
    writeFileSync(join(dir, 'engine.lock'), `${JSON.stringify({ pid: child.pid, host: 'Johns-MacBook-Pro.local', token: 'other-process:1', at: new Date().toISOString() })}\n`)
    const run = async argv => {
      const out = []
      const code = await main(argv, { stdout: { write: x => out.push(x), isTTY: false }, stderr: { write: x => out.push(x) }, env, cwd: repo, isTTY: false })
      return { code, text: out.join('') }
    }
    return { id, dir, child, run }
  }

  it('stops its own engine when the lease names an older hostname of this machine', async () => {
    const s = await renamedHost()
    const r = await s.run(['explore', 'stop', s.id, '--timeout', '10'])
    assert.equal(r.code, 0, r.text)
    assert.match(r.text, /sent SIGTERM to the engine of lineage/)
    assert.match(r.text, /paused_user/)
  })

  it('still refuses a lease of another host when the local pid is not that engine', async () => {
    const s = await renamedHost({ cmdline: 'other' })
    const r = await s.run(['explore', 'stop', s.id, '--timeout', '1'])
    assert.equal(r.code, 3, r.text)
    assert.match(r.text, /runs on host Johns-MacBook-Pro\.local .*stop it there\. If this machine was renamed, check pid \d+/)
    assert.doesNotThrow(() => process.kill(s.child.pid, 0), 'nothing was signalled')
  })
})

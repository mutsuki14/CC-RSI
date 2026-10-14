// `cc-rsi doctor` (SPEC §13.5): check lines, store tamper, restore-failed and stale locks with the
// human-only release, a lineage whose engine died, hooks for a session, the MCP tool list, and the
// --live auth + hook probes against the fake claude (§15.2).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { main } from '../../lib/cli/main.mjs'
import { writeShim } from '../../lib/cli/shim.mjs'
import { sha256Hex } from '../../lib/core/digest.mjs'
import { globalLayout, projectKey, projectLayout, sessionLayout } from '../../lib/core/paths.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { fakeClaude, scenarioPath } from '../_helpers/fake.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const LINE = /^(PASS|WARN|FAIL) [a-z-]+: .+$/

async function setup({ runHooks = true, scenario = 'ok' } = {}) {
  const { home } = await tmpHome()
  const fake = await fakeClaude({ scenario: scenarioPath(scenario), home, runHooks })
  const env = { ...fake.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_') || name === 'CLAUDE_CODE_EXECPATH' || name === 'ANTHROPIC_MODEL') delete env[name]
  }
  env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ children: { claudeBin: fake.bin }, models: { verifier: 'verifier-model' } }))
  chmodSync(home, 0o700)
  const repo = await gitRepo({ 'a.txt': 'a\n' })
  const root = await gitProjectRoot(repo)
  const pl = projectLayout(home, projectKey(root))
  const run = async (argv, extraEnv = {}) => {
    const out = []
    const err = []
    const code = await main(argv, { stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => err.push(s) }, env: { ...env, ...extraEnv }, cwd: repo, isTTY: false })
    return { code, stdout: out.join(''), stderr: err.join('') }
  }
  return { home, env, fake, repo, root, pl, run }
}

function lines(stdout) {
  return stdout.trim().split('\n').slice(1)
}

function find(stdout, name) {
  return lines(stdout).filter(l => l.split(' ')[1] === `${name}:`)
}

describe('cc-rsi doctor', () => {
  it('prints one PASS/WARN/FAIL line per check and passes on a healthy install', async () => {
    const s = await setup()
    const r = await s.run(['doctor'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const l of lines(r.stdout)) assert.match(l, LINE)
    assert.match(find(r.stdout, 'node')[0], /^PASS node: Node \d+/)
    assert.match(find(r.stdout, 'claude')[0], /^PASS claude: .*2\.1\.296; every required flag is present$/)
    assert.match(find(r.stdout, 'home')[0], /^PASS home: .* writable, mode 700/)
    assert.match(find(r.stdout, 'locks')[0], /^PASS locks: no workspace locks$/)
    assert.match(find(r.stdout, 'models')[0], /^PASS models: Verifier verifier-model \(config\); session model not yet known \(read from the transcript at the first cc-rsi tool call\)$/)
    if (existsSync(join(ROOT, 'mcp', 'server.mjs'))) assert.match(find(r.stdout, 'mcp')[0], /^PASS mcp: the rsi server lists submit, wait_verdict, learn, memory_commit, status$/)
    assert.equal(find(r.stdout, 'live-auth').length, 0, 'no model call without --live')
    assert.equal(s.fake.log().filter(e => e.argv.includes('-p')).length, 0)
    const json = JSON.parse((await s.run(['doctor', '--json'])).stdout)
    assert.equal(json.ok, true)
    assert.ok(json.checks.every(c => ['PASS', 'WARN', 'FAIL'].includes(c.status)))
  })

  it('fails on tamper, a restore-failed lock and an unusable claude; warns on stale state', async () => {
    const s = await setup()
    // Tamper.
    const store = await MemoryStore.open(s.pl.store, { sessionsDir: s.pl.sessions, lineagesDir: s.pl.lineages })
    const draft = await store.openDraft('ep-1', { owner: { kind: 'engine', pid: process.pid } })
    writeFileSync(join(draft.dir, 'a.md'), 'a\n')
    await store.commit('ep-1', { kind: 'practice', outcome: 'PASS' })
    await store.close()
    writeFileSync(join(s.pl.store, 'memory', 'planted.md'), 'x\n')
    // A restore-failed lock on the repo and a stale lock elsewhere.
    const g = globalLayout(s.home)
    mkdirSync(g.locks, { recursive: true })
    const lockPath = join(g.locks, `${sha256Hex(s.root).slice(0, 24)}.json`)
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, host: hostname(), token: 't:1', at: new Date().toISOString(), owner: { root: s.root, jobId: 'j-1', sessionId: 'sess-1', restoreFailed: true } }))
    const stale = join(g.locks, 'aaaaaaaaaaaaaaaaaaaaaaaa.json')
    writeFileSync(stale, JSON.stringify({ pid: 2147483646, host: hostname(), token: 't:2', at: new Date().toISOString(), owner: { root: '/nonexistent/root', jobId: 'j-2', sessionId: 'sess-2', restoreFailed: false } }))
    const old = new Date(Date.now() - 120000)
    utimesSync(stale, old, old)
    mkdirSync(join(s.pl.sessions, 'sess-1', 'displaced', 'j-1'), { recursive: true })
    // A lineage marked running whose engine is gone.
    mkdirSync(join(s.pl.lineages, 'broad-dead'), { recursive: true })
    writeFileSync(join(s.pl.lineages, 'broad-dead', 'state.json'), JSON.stringify({ v: 1, id: 'broad-dead', phase: 'broad', status: 'running' }))
    const r = await s.run(['doctor'])
    assert.equal(r.code, 1)
    assert.match(find(r.stdout, 'store')[0], /^FAIL store: canonical memory changed outside a commit .* → cc-rsi memory verify --accept-external \| cc-rsi memory restore <N>/)
    const lockLines = find(r.stdout, 'locks')
    assert.ok(lockLines.some(l => /^FAIL locks: a verification \(job j-1\) failed to restore .* → inspect .*displaced\/j-1, then cc-rsi doctor --release-lock /.test(l)), lockLines.join('\n'))
    assert.ok(lockLines.some(l => /^WARN locks: stale workspace lock for \/nonexistent\/root/.test(l)), lockLines.join('\n'))
    assert.match(find(r.stdout, 'lineages')[0], /^WARN lineages: lineage broad-dead is marked running but its engine is gone → cc-rsi explore resume broad-dead$/)
    // The human-only release (refused inside Claude Code), then the lock is gone.
    assert.equal((await s.run(['doctor', '--release-lock', s.repo], { CLAUDECODE: '1' })).code, 65)
    assert.ok(existsSync(lockPath))
    const released = await s.run(['doctor', '--release-lock', s.repo])
    assert.equal(released.code, 0, released.stderr)
    assert.match(released.stdout, /released the workspace lock of /)
    assert.equal(existsSync(lockPath), false)
    // An unusable claude binary fails its check, and --live then makes no call.
    writeFileSync(join(s.home, 'config.json'), JSON.stringify({ children: { claudeBin: '/nonexistent/claude' } }))
    const broken = await s.run(['doctor', '--live'])
    assert.equal(broken.code, 1)
    assert.match(find(broken.stdout, 'claude')[0], /^FAIL claude: \/nonexistent\/claude is missing or reported no version → install Claude Code/)
    // portability-6: remedies name the real config file, not a hard-coded ~/.cc-rsi.
    assert.ok(find(broken.stdout, 'claude')[0].endsWith(`set children.claudeBin in ${join(s.home, 'config.json')}`), find(broken.stdout, 'claude')[0])
    assert.match(find(broken.stdout, 'live')[0], /^FAIL live: skipped: claude is not usable/)
  })

  it('checks hooks for a session', async () => {
    const s = await setup()
    const sid = '11111111-2222-4333-8444-555555555555'
    const sl = sessionLayout(s.pl, sid)
    const r1 = await s.run(['doctor', '--session', sid, '--project', s.repo])
    assert.match(find(r1.stdout, 'hooks')[0], /^WARN hooks: no request was captured for session /)
    mkdirSync(sl.dir, { recursive: true })
    writeFileSync(sl.requests, `${JSON.stringify({ seq: 1, ts: 'x', promptId: 'p', text: 'hello' })}\n`)
    const r2 = await s.run(['doctor', '--session', sid, '--project', s.repo])
    assert.match(find(r2.stdout, 'hooks')[0], /^PASS hooks: the cc-rsi hooks are active in session .* \(1 request\(s\) captured\)$/)
  })

  it('--live proves auth and the role guard on the first message and on --resume', async () => {
    const s = await setup()
    const r = await s.run(['doctor', '--live'])
    assert.equal(r.code, 0, r.stdout)
    assert.match(find(r.stdout, 'live-auth')[0], /^PASS live-auth: a role child authenticated and replied/)
    assert.match(find(r.stdout, 'live-hooks')[0], /^PASS live-hooks: the role guard ran on the first message and on --resume$/)
    const calls = s.fake.log().filter(e => e.argv.includes('-p'))
    assert.equal(calls.length, 2, 'two tiny calls')
    assert.deepEqual(calls.map(c => c.mode), ['new', 'resume'])
    assert.equal(calls[0].sessionId, calls[1].sessionId)
    const tools = calls[0].argv[calls[0].argv.indexOf('--tools') + 1]
    assert.equal(tools, '', '--tools ""')
    assert.equal(calls[0].argv[calls[0].argv.indexOf('--model') + 1], 'verifier-model')
    assert.ok(calls.every(c => c.ccRsi.CC_RSI_ROLE === 'summarizer' && !c.envKeys.includes('CLAUDECODE')))
    assert.equal(existsSync(join(s.home, 'run', 'probe')) ? (await import('node:fs')).readdirSync(join(s.home, 'run', 'probe')).length : 0, 0, 'probe dirs are removed')
  })

  it('--live reports hooks_not_run when role hooks do not fire', async () => {
    const s = await setup({ runHooks: false })
    const r = await s.run(['doctor', '--live'])
    assert.equal(r.code, 1)
    assert.match(find(r.stdout, 'live-hooks')[0], /^FAIL live-hooks: hooks_not_run: /)
    assert.match(find(r.stdout, 'live-auth')[0], /^WARN live-auth: not proven/)
  })

  it('checks the terminal shim and PATH, and names the real home in remedies (portability-6)', async () => {
    const s = await setup()
    // No shim yet.
    const none = await s.run(['doctor'])
    assert.match(find(none.stdout, 'shim')[0], /^WARN shim: .*\/bin\/cc-rsi does not exist yet: "cc-rsi" does not run in a terminal .* → start a Claude Code session/)
    assert.ok(find(none.stdout, 'shim')[0].includes(`export PATH="${join(s.home, 'bin')}:$PATH"`))
    // The shim exists, but <home>/bin is not on PATH.
    await writeShim(s.home, ROOT)
    const off = await s.run(['doctor'])
    assert.equal(find(off.stdout, 'shim')[0], `WARN shim: ${join(s.home, 'bin')} is not on PATH, so "cc-rsi" does not run in a terminal (human-only commands need it) → export PATH="${join(s.home, 'bin')}:$PATH" (in your shell profile)`)
    const on = await s.run(['doctor'], { PATH: `${join(s.home, 'bin')}:${s.env.PATH}` })
    assert.match(find(on.stdout, 'shim')[0], /^PASS shim: .* → .*\/bin\/cc-rsi; .* is on PATH$/)
    // A shim pointing at a removed plugin root.
    writeFileSync(join(s.home, 'bin', 'cc-rsi'), '#!/bin/sh\nexec node "/nonexistent/plugin/bin/cc-rsi" "$@"\n')
    const stale = await s.run(['doctor'], { PATH: `${join(s.home, 'bin')}:${s.env.PATH}` })
    assert.match(find(stale.stdout, 'shim')[0], /^WARN shim: .* points at \/nonexistent\/plugin\/bin\/cc-rsi, which no longer exists/)
    assert.equal(stale.code, 0, 'a shim warning never fails doctor')
    // The models remedy names <home>/config.json.
    writeFileSync(join(s.home, 'config.json'), JSON.stringify({ children: { claudeBin: s.fake.bin }, models: { verifier: 'same-model', actor: 'same-model' } }))
    const same = await s.run(['doctor'])
    assert.ok(find(same.stdout, 'models')[0].endsWith(`set the verifier_model plugin option (/plugin configure) or models.verifier in ${join(s.home, 'config.json')}`), find(same.stdout, 'models')[0])
    // Two unknown models are not "equal" (cc-integration-3): no false warning.
    writeFileSync(join(s.home, 'config.json'), JSON.stringify({ children: { claudeBin: s.fake.bin } }))
    const unknown = await s.run(['doctor'], { ANTHROPIC_MODEL: '' })
    assert.match(find(unknown.stdout, 'models')[0], /^PASS models: Verifier \(default\) \(\w+\); session model not yet known/, find(unknown.stdout, 'models')[0])
  })

  it('--release-lock never releases a live lock, whatever host it names (portability-7)', async () => {
    const s = await setup()
    const g = globalLayout(s.home)
    mkdirSync(g.locks, { recursive: true })
    const lockPath = join(g.locks, `${sha256Hex(s.root).slice(0, 24)}.json`)
    // Written by this machine under its previous hostname a moment ago: the lease is live.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'Johns-MacBook-Pro.local', token: 't:1', at: new Date().toISOString(), owner: { root: s.root, jobId: 'j-7', sessionId: 'sess-7', restoreFailed: false } }))
    const refused = await s.run(['doctor', '--release-lock', s.repo])
    assert.equal(refused.code, 3, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /was renewed within the last 30 s; a verification may still run/)
    assert.ok(existsSync(lockPath))
    // Once the lease expired it is released.
    const old = new Date(Date.now() - 120000)
    utimesSync(lockPath, old, old)
    const released = await s.run(['doctor', '--release-lock', s.repo])
    assert.equal(released.code, 0, released.stdout + released.stderr)
    assert.equal(existsSync(lockPath), false)
  })

  it('reports a dead job\'s checkpoint-open lock as recovery pending; --release-lock removes the lock and every restore-failed marker (memory-crash-2/-3)', async () => {
    const s = await setup()
    const g = globalLayout(s.home)
    mkdirSync(g.locks, { recursive: true })
    const base = sha256Hex(s.root).slice(0, 24)
    const lockPath = join(g.locks, `${base}.json`)
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    const jobFile = join(s.pl.dir, 'sessions', 'sess-9', 'jobs', 'j-9.json')
    writeFileSync(lockPath, JSON.stringify({ pid: dead, host: hostname(), token: 't:9', at: new Date().toISOString(),
      owner: { root: s.root, jobId: 'j-9', sessionId: 'sess-9', jobFile, restoreFailed: false, checkpointOpen: true } }))
    const old = new Date(Date.now() - 120000)
    utimesSync(lockPath, old, old)
    const r = await s.run(['doctor'])
    assert.match(find(r.stdout, 'locks')[0], /^WARN locks: job j-9 died with its checkpoint of .* open; recovery pending/, find(r.stdout, 'locks')[0])
    // A restore failure recorded for another job of the same root is a separate sticky marker.
    const marker = join(g.locks, `${base}.restore-failed-j-8.json`)
    writeFileSync(marker, JSON.stringify({ pid: dead, host: hostname(), token: 'restore-failed:x', at: new Date().toISOString(),
      owner: { root: s.root, jobId: 'j-8', restoreFailed: true, marker: true } }))
    const released = await s.run(['doctor', '--release-lock', s.repo])
    assert.equal(released.code, 0, released.stdout + released.stderr)
    assert.match(released.stdout, /may still hold the Verifier's changes/)
    assert.equal(existsSync(lockPath), false)
    assert.equal(existsSync(marker), false, 'the marker alone would keep the root blocked')
  })

  it('counts only drafts of gone owners or committed episodes as abandoned (memory-crash-4/-5)', async () => {
    const s = await setup()
    const store = await MemoryStore.open(s.pl.store, { sessionsDir: s.pl.sessions, lineagesDir: s.pl.lineages })
    const dir = join(s.pl.drafts, 'live-ep')
    await store.openDraft('live-ep', { dir, owner: { kind: 'engine', pid: process.pid } })
    await store.close()
    // A live owner's directory momentarily missing is transient, not abandoned.
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
    const r = await s.run(['doctor'])
    assert.match(find(r.stdout, 'store-drafts')[0], /^PASS store-drafts: 1 open draft\(s\): live-ep$/, find(r.stdout, 'store-drafts')[0])
  })

  it('uses the plugin options saved in Claude Code user settings (portability-3)', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'config.json'), JSON.stringify({ children: { claudeBin: s.fake.bin } }))
    writeFileSync(join(s.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ pluginConfigs: { 'cc-rsi@inline': { options: { verifier_model: 'saved-verifier-model' } } } }))
    const r = await s.run(['doctor'])
    assert.match(find(r.stdout, 'models')[0], /^PASS models: Verifier saved-verifier-model \(config\); /)
    assert.ok(find(r.stdout, 'config')[0].includes(`plugin options verifier_model=saved-verifier-model from ${join(s.env.CLAUDE_CONFIG_DIR, 'settings.json')} pluginConfigs["cc-rsi@inline"]`), find(r.stdout, 'config')[0])
  })
})


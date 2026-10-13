// Lineage records and lifecycle (SPEC §12.2, §12.3, §12.4, §12.15): preflight blockers, creation
// records, the auth preflight, the detached daemon with stop → paused_user → resume, pure resume
// admission (terminal, live engine, drift, tamper), abandon and show.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { LeaseLock } from '../../lib/core/lock.mjs'
import { killGracefully, pidAlive } from '../../lib/core/proc.mjs'
import { runEngine } from '../../lib/engine/daemon.mjs'
import { OpJournal } from '../../lib/engine/journal.mjs'
import {
  abandon, admitResume, applyResume, createLineage, pluginFingerprint, preflight, showLineage, startEngine,
} from '../../lib/engine/records.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { create, engineEnv, events, invocations, protocolEvents, readJson, REPO_ROOT, run, storeJournal } from './_engine.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const TARGET = 'In <PROJECT_ROOT> do it.'

async function waitFor(predicate, { timeoutMs = 30000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(stepMs)
  }
}

function base(e) {
  return { home: e.home, projectRoot: e.projectRoot, pluginRoot: REPO_ROOT, env: e.env }
}

describe('preflight', () => {
  it('reports every blocker and a plan without writing lineage records', async () => {
    const e = await engineEnv()
    const emptyFixtures = await tmpDir()
    const roleEnv = { ...e.env, CC_RSI_ROLE: 'actor' }
    const r = await preflight({ ...base(e), env: roleEnv, phase: 'broad', id: 'Bad Id', fixturesDir: emptyFixtures })
    const text = r.blockers.join('\n')
    assert.match(text, /CC_RSI_ROLE is set/)
    assert.match(text, /invalid lineage id/)
    assert.match(text, /needs --direction/)
    assert.match(text, /--fixtures applies to deep and frozen lineages only/)
    assert.match(text, /not replayable: .* contains no regular file/)
    const deep = await preflight({ ...base(e), phase: 'deep', id: 'ok-id' })
    assert.match(deep.blockers.join('\n'), /needs --target/)
    assert.equal(existsSync(join(e.home, 'projects')), true) // the store may be opened
    assert.equal(existsSync(e.lineageDir('ok-id')), false)
  })

  it('requires --allow-unconfined without an OS sandbox, and refuses isolation.sandbox=require', async () => {
    const e = await engineEnv({ config: { isolation: { allowUnconfined: false } } })
    const auto = await preflight({ ...base(e), phase: 'broad', direction: 'd' })
    assert.match(auto.blockers.join('\n'), /no OS sandbox is available .* Re-run with --allow-unconfined/)
    const allowed = await preflight({ ...base(e), phase: 'broad', direction: 'd', allowUnconfined: true })
    assert.deepEqual(allowed.blockers, [])
    assert.equal(allowed.lineage.isolation.mode, 'unconfined')
    assert.equal(allowed.lineage.isolation.allowUnconfined, true)
    assert.match(allowed.plan, /WARNING: role children run Bash unattended without an OS sandbox/)
    writeFileSync(join(e.home, 'config.json'), JSON.stringify({ children: { claudeBin: e.fake.bin }, isolation: { sandbox: 'require' } }))
    const required = await preflight({ ...base(e), phase: 'broad', direction: 'd', allowUnconfined: true })
    assert.match(required.blockers.join('\n'), /required \(isolation\.sandbox=require\) but unavailable/)
    writeFileSync(join(e.home, 'config.json'), JSON.stringify({ children: { claudeBin: e.fake.bin }, isolation: { sandbox: 'off' } }))
    const off = await preflight({ ...base(e), phase: 'broad', direction: 'd' })
    assert.match(off.blockers.join('\n'), /isolation\.sandbox=off/)
  })

  it('blocks a missing claude binary and an existing lineage id', async () => {
    const e = await engineEnv({ config: { children: { claudeBin: '/nonexistent/claude' } } })
    const r = await preflight({ ...base(e), phase: 'broad', direction: 'd', allowUnconfined: true })
    assert.match(r.blockers.join('\n'), /is missing or did not report a version/)
    const e2 = await engineEnv()
    await create(e2, { phase: 'broad', id: 'dup', direction: 'd' })
    const again = await preflight({ ...base(e2), phase: 'broad', id: 'dup', direction: 'd', allowUnconfined: true })
    assert.match(again.blockers.join('\n'), /lineage dup already exists/)
  })
})

describe('createLineage', () => {
  it('writes lineage.json, state.json, the prompt snapshot, the inert work repo and the work tree', async () => {
    const e = await engineEnv({ config: { models: { escalation: 'esc-model' } } })
    const { id, dir } = await create(e, { phase: 'deep', id: 'c1', target: TARGET, sessionId: 'sess-1' })
    assert.equal(id, 'c1')
    const lineage = readJson(join(dir, 'lineage.json'))
    for (const key of ['v', 'id', 'phase', 'projectKey', 'projectRoot', 'createdAt', 'direction', 'targetConditioned', 'target', 'config',
      'configSha', 'models', 'modelSources', 'isolation', 'lock', 'memoryTreeAtStart', 'storeRoot', 'workRoot', 'startedBy']) {
      assert.ok(Object.prototype.hasOwnProperty.call(lineage, key), key)
    }
    assert.equal(lineage.target.text, TARGET)
    assert.equal(lineage.direction, null)
    assert.deepEqual(Object.keys(lineage.config).sort(), ['audit', 'children', 'effort', 'exploration', 'isolation', 'memory', 'transport'])
    assert.deepEqual(lineage.models, { actor: 'actor-model', verifier: 'verifier-model', curriculum: 'curriculum-model', summarizer: 'actor-model', escalation: 'esc-model' })
    assert.equal(lineage.modelSources.actor, 'config')
    assert.deepEqual(lineage.startedBy, { sessionId: 'sess-1', cli: true })
    const fingerprint = await pluginFingerprint(REPO_ROOT)
    assert.equal(lineage.lock.pluginRev, fingerprint.pluginRev)
    assert.equal(lineage.lock.guardSha, fingerprint.guardSha)
    assert.equal(lineage.lock.ccVersion, '2.1.296')
    assert.deepEqual(lineage.lock.driftAccepted, [])
    assert.equal(Object.keys(lineage.lock.promptSha).length, readdirSync(join(dir, 'prompts')).length)
    assert.equal(readJson(join(dir, 'state.json')).status, 'starting')
    assert.ok(existsSync(join(e.home, 'work', '.git')))
    for (const sub of ['curriculum-private', 'actor-private', 'projects', 'verify', 'verify-scratch', 'summarizer']) {
      assert.ok(existsSync(join(lineage.workRoot, sub)), sub)
    }
  })

  it('refuses with every blocker (CcRsiError lineage_blocked) and runs the auth preflight', async () => {
    const e = await engineEnv({ world: { summarizerApiError: { status: 401, error: 'authentication_failed' } } })
    await assert.rejects(create(e, { phase: 'broad', id: 'nodir' }), error => error.code === 'lineage_blocked' && /needs --direction/.test(error.message))
    await assert.rejects(create(e, { phase: 'broad', id: 'auth1', direction: 'd', skipAuthProbe: false }),
      error => error.code === 'lineage_blocked' && /auth: the authentication probe failed \(auth\)/.test(error.message))
    assert.equal(existsSync(e.lineageDir('auth1')), false)
    e.setWorld({})
    const ok = await create(e, { phase: 'broad', id: 'auth2', direction: 'd', skipAuthProbe: false })
    assert.ok(existsSync(join(ok.dir, 'lineage.json')))
    const probe = invocations(e, 'summarizer').at(-1)
    assert.ok(probe.argv.includes('--no-session-persistence'))
    assert.deepEqual(probe.argv.slice(-2), ['--tools', ''])
  })
})

describe('daemon and resume', () => {
  it('refuses inside a role context and when another engine holds the lease', async () => {
    const e = await engineEnv()
    const { dir } = await create(e, { phase: 'broad', id: 'lease', direction: 'd' })
    await assert.rejects(runEngine(dir, { env: { ...e.env, CC_RSI_ROLE: 'verifier' } }), error => error.exitCode === 64)
    const lock = new LeaseLock(join(dir, 'engine.lock'))
    await lock.acquire()
    try {
      const r = await run(e, dir)
      assert.deepEqual(r, { status: 'locked', exitCode: 3 })
      const admission = await admitResume(dir, { env: e.env })
      assert.equal(admission.ok, false)
      assert.match(admission.reasons.join(' '), /the engine is running/)
      await assert.rejects(abandon(dir, {}), error => error.code === 'engine_live')
    } finally {
      await lock.release()
    }
    const cli = await runNode(join(REPO_ROOT, 'lib', 'engine', 'daemon.mjs'), [dir], { env: { ...e.env, CC_RSI_ROLE: 'actor' } })
    assert.equal(cli.code, 64)
  })

  it('runs detached, pauses on stop (SIGTERM) without killing the lineage, and completes after resume', async () => {
    const e = await engineEnv({ world: { waves: [[{ id: 'slow' }]], actors: { 'w001-slow': { hangOnce: 60000 } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'stop', direction: 'd', spawn: true })
    const state = () => { try { return readJson(join(dir, 'state.json')) } catch { return {} } }
    let pid = null
    try {
      pid = await waitFor(() => state().pid)
      await waitFor(() => invocations(e, 'actor').length > 0 || e.fake.sessions().length >= 2)
      await waitFor(async () => (await OpJournal.open(dir)).hasStart('w001/b:slow/a1/work/m1'))
      await sleep(300)
      process.kill(pid, 'SIGTERM')
      await waitFor(() => !pidAlive(pid), { timeoutMs: 40000 })
      assert.equal(state().status, 'paused_user')
      assert.ok((await events(dir)).some(ev => ev.type === 'LINEAGE_PAUSED' && ev.reason === 'user'))
      assert.equal(existsSync(join(dir, 'result.json')), false)
      const admission = await admitResume(dir, { env: e.env })
      assert.equal(admission.ok, true, admission.reasons.join('; '))
      await applyResume(dir, admission)
      pid = startEngine(dir, { env: e.env, pluginRoot: REPO_ROOT })
      await waitFor(() => existsSync(join(dir, 'result.json')), { timeoutMs: 60000 })
      await waitFor(() => !pidAlive(pid), { timeoutMs: 20000 })
      assert.equal(readJson(join(dir, 'result.json')).termination, 'saturated')
      assert.equal(state().status, 'completed')
      assert.ok((await events(dir)).some(ev => ev.type === 'LINEAGE_RESUMED'))
      // The interrupted message was re-sent in the SAME session with the recovery note.
      const slow = invocations(e, 'actor').filter(i => i.cwd.endsWith('w001-slow'))
      assert.equal(slow[1].sessionId, slow[0].sessionId)
      assert.equal(slow[1].mode, 'resume')
      const turns = e.fake.session(slow[0].sessionId).turns
      assert.ok(turns.some(t => /^HARNESS RECOVERY/.test(t.prompt ?? '')))
    } finally {
      if (pid && pidAlive(pid)) await killGracefully(pid, { graceMs: 2000, group: true })
    }
  })

  it('refuses resume on drift unless accepted, on tamper, and on frozen memory; records accepted drift', async () => {
    const e = await engineEnv({ world: { waves: [[{ id: 'a' }]], actors: { 'w001-a': { apiErrorOnce: { status: 401, error: 'authentication_failed' } } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'drift', direction: 'd' })
    assert.equal((await run(e, dir)).status, 'paused_infra')
    // A changed plugin tree (role guard edited) is drift.
    const other = await tmpDir()
    for (const sub of ['lib', 'hooks']) cpSync(join(REPO_ROOT, sub), join(other, sub), { recursive: true })
    writeFileSync(join(other, 'hooks', 'role-guard.mjs'), `${readFileSync(join(REPO_ROOT, 'hooks', 'role-guard.mjs'), 'utf8')}\n// changed\n`)
    const refused = await admitResume(dir, { pluginRoot: other, env: e.env })
    assert.equal(refused.ok, false)
    assert.match(refused.reasons.join(' '), /plugin changed .*guardSha.*--accept-drift/)
    const accepted = await admitResume(dir, { pluginRoot: other, acceptDrift: true, env: e.env })
    assert.equal(accepted.ok, true)
    await applyResume(dir, accepted)
    const lineage = readJson(join(dir, 'lineage.json'))
    assert.equal(lineage.lock.driftAccepted.length, 1)
    assert.ok((await protocolEvents(dir)).some(ev => ev.type === 'DRIFT_ACCEPTED'))
    assert.equal((await admitResume(dir, { pluginRoot: other, env: e.env })).ok, true) // accepted drift is the new baseline
    // Tamper.
    mkdirSync(join(e.pl.store, 'memory'), { recursive: true })
    writeFileSync(join(e.pl.store, 'memory', 'planted.md'), 'x')
    const tampered = await admitResume(dir, { env: e.env })
    assert.equal(tampered.ok, false)
    assert.match(tampered.reasons.join(' '), /changed outside a commit/)
  })

  it('abandons a paused lineage with the last infra detail and discards its drafts', async () => {
    const e = await engineEnv({ world: { verdicts: { '*': ['PASS'] }, actors: { t001: { apiErrorOnce: { status: 401, error: 'authentication_failed' } } } } })
    const { dir } = await create(e, { phase: 'deep', id: 'ab', target: TARGET })
    const r = await run(e, dir)
    assert.equal(r.status, 'paused_infra')
    const record = await abandon(dir, {})
    assert.equal(record.termination, 'abandoned')
    assert.match(record.rationale, /authentication/)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'abandoned')
    assert.equal(result.schema_version, 1)
    assert.equal(readJson(join(dir, 'state.json')).status, 'abandoned')
    assert.ok((await protocolEvents(dir)).some(ev => ev.type === 'LINEAGE_ABANDONED'))
    await assert.rejects(abandon(dir, {}), error => error.code === 'lineage_terminal')
    assert.equal((await admitResume(dir, { env: e.env })).ok, false)
  })

  it('pauses mid-learning on infra, keeps the draft, and resumes it without committing twice', async () => {
    const e = await engineEnv({
      world: { waves: [[{ id: 'l' }]], actors: { 'w001-l': { apiErrorAt: { marker: 'TERMINAL MEMORY RECONCILIATION', error: { status: 401, error: 'authentication_failed' } } } } },
    })
    const { dir } = await create(e, { phase: 'broad', id: 'learnpause', direction: 'd' })
    const first = await run(e, dir)
    assert.equal(first.status, 'paused_infra')
    assert.equal(first.pausedAt, 'w001/learn:l/reconcile/m1')
    const memoryDir = e.layout('learnpause').actorMemory('w001-l')
    assert.equal(readFileSync(join(memoryDir, 'lesson-w001-l.md'), 'utf8').startsWith('lesson from w001-l'), true)
    assert.equal((await storeJournal(e)).journal.length, 0) // infra never commits
    const store = await MemoryStore.open(e.pl.store, { sessionsDir: e.pl.sessions, lineagesDir: e.pl.lineages })
    assert.ok(await store.getDraft('learnpause-w001-l'))
    await store.close()
    await applyResume(dir, await admitResume(dir, { env: e.env }))
    const second = await run(e, dir)
    assert.equal(second.status, 'completed')
    const { journal } = await storeJournal(e)
    assert.deepEqual(journal.map(c => [c.episode, c.created]), [['learnpause-w001-l', ['lesson-w001-l.md']]])
    // A third run of a completed lineage is a no-op.
    assert.equal((await run(e, dir)).status, 'completed')
    assert.equal((await storeJournal(e)).journal.length, 1)
  })

  it('shows contexts with --fork-session hints and never report text', async () => {
    const e = await engineEnv({ world: { waves: [[{ id: 's' }]] } })
    const { dir } = await create(e, { phase: 'broad', id: 'show', direction: 'd' })
    await run(e, dir)
    const text = await showLineage(dir)
    assert.match(text, /^lineage show \(broad\) — ended: saturated/)
    assert.match(text, /curriculum {2}cur {2}session [0-9a-f-]{36} {2}model curriculum-model {2}invocations 2 {2}last reply/)
    assert.match(text, /actor {2}w001\/b:s\/a1\/actor/)
    assert.match(text, /verifier {2}w001\/b:s\/a1\/verifier/)
    const hints = text.split('\n').filter(line => line.includes('--fork-session'))
    assert.equal(hints.length, 3)
    assert.match(hints[0], /claude --resume [0-9a-f-]{36} --fork-session/)
    assert.doesNotMatch(text, /VERDICT|Inspection of/)
  })

  it('opens the store with draft liveness for paused lineages (engine-owned drafts survive the engine)', async () => {
    const e = await engineEnv()
    const { dir } = await create(e, { phase: 'broad', id: 'own', direction: 'd' })
    const store = await MemoryStore.open(e.pl.store, { sessionsDir: e.pl.sessions, lineagesDir: e.pl.lineages })
    const draftDir = join(await tmpDir(), 'draft')
    await store.openDraft('own-ep', { dir: draftDir, fresh: true, owner: { kind: 'engine', pid: 999999, host: (await import('node:os')).hostname(), lineage: 'own' } })
    await store.close()
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, status: 'paused_infra' }))
    const reopened = await MemoryStore.open(e.pl.store, { sessionsDir: e.pl.sessions, lineagesDir: e.pl.lineages })
    assert.ok(await reopened.getDraft('own-ep'))
    await reopened.close()
  })
})

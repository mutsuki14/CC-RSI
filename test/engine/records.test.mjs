// Lineage records and lifecycle (SPEC §12.2, §12.3, §12.4, §12.15): preflight blockers, creation
// records, the auth preflight, the detached daemon with stop → paused_user → resume, pure resume
// admission (terminal, live engine, drift, tamper), abandon and show.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { readJsonl as readJsonlRecords } from '../../lib/core/jsonl.mjs'
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
    // The remedy names the real <home> (portability-6), never a hard-coded ~/.cc-rsi.
    assert.ok(auto.blockers.join('\n').includes(`set isolation.allowUnconfined in ${join(e.home, 'config.json')}`), auto.blockers.join('\n'))
    assert.ok(!auto.blockers.join('\n').includes('~/.cc-rsi'))
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
    assert.ok(off.blockers.join('\n').includes(`set isolation.allowUnconfined in ${join(e.home, 'config.json')}`))
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
    // A snapshot taken by an older plugin lacks a template the current builders need.
    const snapshot = e.layout('drift').promptsSnapshot
    rmSync(join(snapshot, 'frozen-runtime-boundary.md'))
    await applyResume(dir, accepted)
    const lineage = readJson(join(dir, 'lineage.json'))
    assert.equal(lineage.lock.driftAccepted.length, 1)
    // Accepting drift refreshes the snapshot with the code it now serves.
    assert.ok(existsSync(join(snapshot, 'frozen-runtime-boundary.md')))
    assert.match(lineage.lock.promptSha['frozen-runtime-boundary'], /^[0-9a-f]{64}$/)
    assert.equal(lineage.lock.driftAccepted[0].promptsRefreshed, true)
    assert.ok((await protocolEvents(dir)).some(ev => ev.type === 'DRIFT_ACCEPTED'))
    assert.equal((await admitResume(dir, { pluginRoot: other, env: e.env })).ok, true) // accepted drift is the new baseline
    // Tamper.
    mkdirSync(join(e.pl.store, 'memory'), { recursive: true })
    writeFileSync(join(e.pl.store, 'memory', 'planted.md'), 'x')
    const tampered = await admitResume(dir, { env: e.env })
    assert.equal(tampered.ok, false)
    assert.match(tampered.reasons.join(' '), /changed outside a commit/)
  })

  it('pauses before any role child starts when the plugin code changed under a running lineage (security-4)', async () => {
    const e = await engineEnv({ world: { waves: [[{ id: 'a' }]] } })
    const other = await tmpDir('cc-rsi-plugin-copy-')
    for (const sub of ['lib', 'hooks', 'prompts']) cpSync(join(REPO_ROOT, sub), join(other, sub), { recursive: true })
    const { dir } = await create(e, { phase: 'broad', id: 'codechange', direction: 'd', pluginRoot: other })
    // A role (or anything else) edits the role guard after the lineage recorded its baseline.
    writeFileSync(join(other, 'hooks', 'role-guard.mjs'), `${readFileSync(join(other, 'hooks', 'role-guard.mjs'), 'utf8')}\n// edited\n`)
    const r = await run(e, dir, { pluginRoot: other })
    assert.equal(r.status, 'paused_infra')
    assert.equal(r.infra.cls, 'plugin_changed')
    assert.match(r.infra.detail, /guardSha/)
    assert.equal(e.fake.log().filter(entry => entry.ccRsi?.CC_RSI_ROLE).length, 0, 'no role child ran on the changed code')
  })

  it('an accepted drift survives the deletion of the old plugin version dir (r2-engine-1)', async () => {
    const world = { waves: [[{ id: 'a' }]], actors: { 'w001-a': { apiErrorOnce: { status: 401, error: 'authentication_failed' } } } }
    const copy = async (from, prefix) => {
      const to = await tmpDir(prefix)
      for (const sub of ['lib', 'hooks', 'prompts']) cpSync(join(from, sub), join(to, sub), { recursive: true })
      return to
    }
    // The version dir the lineage started from is cleaned up after an update to identical code.
    const e = await engineEnv({ world })
    const v1 = await copy(REPO_ROOT, 'cc-rsi-plugin-v1-')
    const { dir } = await create(e, { phase: 'broad', id: 'gone', direction: 'd', pluginRoot: v1 })
    assert.equal((await run(e, dir, { pluginRoot: v1 })).status, 'paused_infra')
    const v2 = await copy(v1, 'cc-rsi-plugin-v2-')
    rmSync(v1, { recursive: true, force: true })
    assert.equal((await admitResume(dir, { pluginRoot: v2, env: e.env })).ok, false, 'a vanished root is drift to accept')
    const admitted = await admitResume(dir, { pluginRoot: v2, acceptDrift: true, env: e.env })
    assert.equal(admitted.ok, true)
    await applyResume(dir, admitted)
    const resumed = await run(e, dir, { pluginRoot: v2 })
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.infra))
    // Drift accepted onto new code first, the old dir deleted afterwards.
    const f = await engineEnv({ world })
    const w1 = await copy(REPO_ROOT, 'cc-rsi-plugin-w1-')
    const second = await create(f, { phase: 'broad', id: 'later', direction: 'd', pluginRoot: w1 })
    assert.equal((await run(f, second.dir, { pluginRoot: w1 })).status, 'paused_infra')
    const w2 = await copy(w1, 'cc-rsi-plugin-w2-')
    writeFileSync(join(w2, 'lib', 'runtime', 'errors.mjs'), `${readFileSync(join(w2, 'lib', 'runtime', 'errors.mjs'), 'utf8')}\n// v2\n`)
    await applyResume(second.dir, await admitResume(second.dir, { pluginRoot: w2, acceptDrift: true, env: f.env }))
    rmSync(w1, { recursive: true, force: true })
    const later = await run(f, second.dir, { pluginRoot: w2 })
    assert.equal(later.status, 'completed', JSON.stringify(later.infra))
  })

  it('accepting drift whose templates reword a sent message replays the recorded reply (r2-engine-2)', async () => {
    const e = await engineEnv({ world: { waves: [[{ id: 'a' }]], actors: { 'w001-a': { apiErrorOnce: { status: 401, error: 'authentication_failed' } } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'reword', direction: 'd' })
    const first = await run(e, dir)
    assert.equal(first.status, 'paused_infra')
    // The update changes engine code and one sentence of the Curriculum contract the first wave already sent.
    const v2 = await tmpDir('cc-rsi-plugin-v2-')
    for (const sub of ['lib', 'hooks', 'prompts']) cpSync(join(REPO_ROOT, sub), join(v2, sub), { recursive: true })
    writeFileSync(join(v2, 'lib', 'runtime', 'errors.mjs'), `${readFileSync(join(v2, 'lib', 'runtime', 'errors.mjs'), 'utf8')}\n// v2\n`)
    const contract = join(v2, 'prompts', 'curriculum-runtime-contract.md')
    writeFileSync(contract, `${readFileSync(contract, 'utf8')}\nOne more sentence in v2.\n`)
    const admitted = await admitResume(dir, { pluginRoot: v2, acceptDrift: true, env: e.env })
    assert.equal(admitted.ok, true)
    // applyResume refreshes the snapshot from the running plugin (the engine's own prompts dir).
    await applyResume(dir, admitted)
    const snapshot = join(e.layout('reword').promptsSnapshot, 'curriculum-runtime-contract.md')
    writeFileSync(snapshot, `${readFileSync(snapshot, 'utf8')}\nOne more sentence in v2.\n`)
    const resumed = await run(e, dir, { pluginRoot: v2 })
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.infra))
    const drifted = (await events(dir)).filter(ev => ev.type === 'REPLAY_TEXT_DRIFT')
    assert.ok(drifted.some(ev => ev.op === 'w001/cur/m1' && ev.status === 'done'), 'the recorded Curriculum reply was replayed and reported')
    // A changed message of a record written after the accepted drift is still a divergence.
    const { ReplayDivergence } = await import('../../lib/engine/journal.mjs')
    const j = await OpJournal.open(dir)
    const sent = j.keysWithPrefix('w001/cur/').find(key => j.isDone(key))
    await assert.rejects(j.op('late-send', 'send', { ctx: 'x', msgSha: 'a', phase: 'p' }, async () => 1, { tolerate: { shapeSha: 's' } }).then(() =>
      j.op('late-send', 'send', { ctx: 'x', msgSha: 'b', phase: 'p' }, async () => 2, { tolerate: { shapeSha: 's' } })), ReplayDivergence)
    assert.ok(sent)
  })

  describe('the journal record of an accepted drift (r3-engine-concurrency-5)', () => {
    // As in the r2-engine-2 test: the update changes engine code, and the refreshed prompt snapshot
    // rewords a message the first wave already sent.
    async function driftedLineage(id) {
      const e = await engineEnv({ world: { waves: [[{ id: 'a' }]], actors: { 'w001-a': { apiErrorOnce: { status: 401, error: 'authentication_failed' } } } } })
      const { dir } = await create(e, { phase: 'broad', id, direction: 'd' })
      assert.equal((await run(e, dir)).status, 'paused_infra')
      const v2 = await tmpDir('cc-rsi-plugin-v2-')
      for (const sub of ['lib', 'hooks', 'prompts']) cpSync(join(REPO_ROOT, sub), join(v2, sub), { recursive: true })
      writeFileSync(join(v2, 'lib', 'runtime', 'errors.mjs'), `${readFileSync(join(v2, 'lib', 'runtime', 'errors.mjs'), 'utf8')}\n// v2\n`)
      const reword = () => {
        const snapshot = join(e.layout(id).promptsSnapshot, 'curriculum-runtime-contract.md')
        writeFileSync(snapshot, `${readFileSync(snapshot, 'utf8')}\nOne more sentence in v2.\n`)
      }
      const admit = async () => {
        const admitted = await admitResume(dir, { pluginRoot: v2, acceptDrift: true, env: e.env })
        assert.equal(admitted.ok, true, admitted.reasons.join('; '))
        return admitted
      }
      return { e, dir, v2, reword, admit }
    }

    async function assertReplayed(e, dir, v2) {
      const resumed = await run(e, dir, { pluginRoot: v2 })
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed.infra))
      assert.ok((await events(dir)).some(ev => ev.type === 'REPLAY_TEXT_DRIFT' && ev.op === 'w001/cur/m1'))
      assert.equal(readJson(join(dir, 'lineage.json')).lock.driftAccepted.length, 1)
    }

    it('an --accept-drift interrupted before its record leaves the drift to accept again', async () => {
      const { e, dir, v2, reword, admit } = await driftedLineage('gap1')
      const realEvent = OpJournal.prototype.event
      OpJournal.prototype.event = async function (key, ...rest) {
        if (String(key).startsWith('drift:')) throw new Error('interrupted before the DRIFT_ACCEPTED record')
        return realEvent.call(this, key, ...rest)
      }
      try {
        await assert.rejects(applyResume(dir, await admit()), /interrupted/)
      } finally {
        OpJournal.prototype.event = realEvent
      }
      assert.deepEqual(readJson(join(dir, 'lineage.json')).lock.driftAccepted, [], 'nothing names the drift without its record')
      await applyResume(dir, await admit())
      reword()
      await assertReplayed(e, dir, v2)
    })

    it('an --accept-drift interrupted after its record writes a fresh one when it is accepted again', async () => {
      const { e, dir, v2, reword, admit } = await driftedLineage('gap2')
      const fsp = (await import('node:fs/promises')).default
      const { syncBuiltinESMExports } = await import('node:module')
      const { rename } = fsp
      const lineageJson = join(dir, 'lineage.json')
      fsp.rename = async (from, to) => {
        if (String(to) === lineageJson) throw new Error('interrupted before lineage.json was written')
        return rename(from, to)
      }
      syncBuiltinESMExports()
      try {
        await assert.rejects(applyResume(dir, await admit()), /interrupted/)
      } finally {
        fsp.rename = rename
        syncBuiltinESMExports()
      }
      assert.ok((await OpJournal.open(dir)).isDone('drift:1'))
      await applyResume(dir, await admit())
      reword()
      const j = await OpJournal.open(dir)
      assert.deepEqual(j.keysWithPrefix('drift:').filter(key => j.isDone(key)), ['drift:1', 'drift:2'])
      await assertReplayed(e, dir, v2)
    })

    it('the engine writes the missing record of a drift an older version accepted', async () => {
      const { e, dir, v2, reword, admit } = await driftedLineage('gap3')
      await applyResume(dir, await admit())
      reword()
      // An older `explore resume --accept-drift` wrote lineage.json, then stopped before the record.
      for (const name of ['ops.jsonl', 'events.jsonl']) {
        const path = join(dir, name)
        const kept = readFileSync(path, 'utf8').split('\n').filter(Boolean).filter(line => {
          const record = JSON.parse(line)
          return !/^drift:/.test(String(record.key ?? record.op ?? ''))
        })
        writeFileSync(path, `${kept.join('\n')}\n`)
      }
      assert.equal((await OpJournal.open(dir)).hasStart('drift:1'), false)
      await assertReplayed(e, dir, v2)
      const j = await OpJournal.open(dir)
      assert.ok(j.isDone('drift:1'))
      assert.ok((await events(dir)).some(ev => ev.type === 'DRIFT_ACCEPTED' && ev.backfilled === true))
    })
  })

  it('an engine whose lease was taken over stops without touching the journal or the state (memory-crash-9)', async () => {
    const e = await engineEnv({ world: { waves: [[{ id: 'slow' }]], actors: { 'w001-slow': { hangOnce: 60000 } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'fenced', direction: 'd' })
    const pending = run(e, dir)
    await waitFor(async () => (await OpJournal.open(dir)).hasStart('w001/b:slow/a1/work/m1'))
    await sleep(200)
    // `explore resume` took the lineage over while this engine was stopped past its lease.
    const lockFile = join(dir, 'engine.lock')
    writeFileSync(lockFile, `${JSON.stringify({ pid: 1, host: 'other-host', token: 'other:engine', at: new Date().toISOString(), owner: { kind: 'engine' } })}\n`)
    const sentinel = `${JSON.stringify({ status: 'running', pid: 1, by: 'the new engine' })}\n`
    writeFileSync(join(dir, 'state.json'), sentinel)
    const opsBefore = readFileSync(join(dir, 'ops.jsonl'), 'utf8')
    const r = await pending
    assert.deepEqual(r, { status: 'lock_lost', exitCode: 3 })
    assert.equal(readFileSync(join(dir, 'ops.jsonl'), 'utf8'), opsBefore, 'no journal record after the takeover')
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), sentinel, 'the new engine\'s state is untouched')
    assert.match(readFileSync(lockFile, 'utf8'), /other:engine/)
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

  it('a draft whose store record was lost is kept as .prev and re-applied, never wiped (memory-crash-4/-5)', async () => {
    const e = await engineEnv({
      world: { waves: [[{ id: 'l' }]], actors: { 'w001-l': { apiErrorAt: { marker: 'TERMINAL MEMORY RECONCILIATION', error: { status: 401, error: 'authentication_failed' } } } } },
    })
    const { dir } = await create(e, { phase: 'broad', id: 'lostmeta', direction: 'd' })
    assert.equal((await run(e, dir)).status, 'paused_infra')
    const memoryDir = e.layout('lostmeta').actorMemory('w001-l')
    assert.ok(existsSync(join(memoryDir, 'lesson-w001-l.md')))
    // The draft's meta is gone (written by an older version, or removed by hand); the Actor's directory survives.
    const meta = join(e.pl.store, 'drafts', 'lostmeta-w001-l.json')
    assert.ok(existsSync(meta), meta)
    rmSync(meta)
    await applyResume(dir, await admitResume(dir, { env: e.env }))
    const second = await run(e, dir)
    assert.equal(second.status, 'completed', JSON.stringify(second))
    const { journal } = await storeJournal(e)
    assert.deepEqual(journal.map(c => [c.episode, c.created]), [['lostmeta-w001-l', ['lesson-w001-l.md']]])
    assert.ok((await protocolEvents(dir)).some(ev => ev.type === 'MEMORY_CONFLICT_REBASED'), 'the same Actor re-applied its draft')
  })

  it('a crash anywhere in the repair of a lost draft record never loses the lesson (r2-engine-3)', async () => {
    const WORLD = { waves: [[{ id: 'a' }]], afterWaves: 'SATURATED' }
    const ref = await engineEnv({ world: WORLD })
    const r0 = await create(ref, { phase: 'broad', id: 'ref', direction: 'd' })
    await run(ref, r0.dir)
    const S = (await readJsonlRecords(join(r0.dir, 'ops.jsonl'))).find(r => r.key === 'w001/learn:a/commit:1' && r.status === 'start').seq
    // After the meta is lost: commit:1 start S, done S+1 (draft_missing), rebase:1 start S+2, done S+3.
    for (const fault of [{ atSeq: S + 1, when: 'before' }, { atSeq: S + 3, when: 'before' }, { atSeq: S + 3, when: 'after' }]) {
      const e = await engineEnv({ world: WORLD })
      const { dir } = await create(e, { phase: 'broad', id: 'x', direction: 'd' })
      assert.equal((await run(e, dir, { fault: { atSeq: S, mode: 'throw', when: 'before' } })).status, 'paused_infra')
      for (const name of readdirSync(join(e.pl.store, 'drafts'))) if (name.endsWith('.json')) rmSync(join(e.pl.store, 'drafts', name))
      assert.equal((await run(e, dir, { fault: { ...fault, mode: 'throw' } })).status, 'paused_infra', JSON.stringify(fault))
      const last = await run(e, dir)
      assert.equal(last.status, 'completed', `${JSON.stringify(fault)}: ${JSON.stringify(last.infra)}`)
      const { journal } = await storeJournal(e)
      assert.deepEqual(journal.map(c => c.created), [['lesson-w001-a.md']], JSON.stringify(fault))
    }
  })

  it('the lost-draft repair is idempotent in every intermediate state (r2-engine-3)', async () => {
    const { rebaseOrRepair } = await import('../../lib/engine/learn.mjs')
    const e = await engineEnv()
    const store = await MemoryStore.open(e.pl.store, { sessionsDir: e.pl.sessions, lineagesDir: e.pl.lineages })
    const owner = { kind: 'engine', pid: process.pid, host: (await import('node:os')).hostname(), lineage: 'x' }
    const base = await tmpDir()
    const work = (dir, text) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'lesson.md'), text) }
    // A commit lands so the canonical tree differs from an older copy.
    await store.openDraft('seed', { dir: join(base, 'seed'), fresh: true, owner })
    writeFileSync(join(base, 'seed', 'seed.md'), 'seed\n')
    await store.commit('seed', { kind: 'practice' })
    const dirOf = n => join(base, n, 'memory')
    // (1) No record, the Actor's directory only.
    work(dirOf('one'), 'one')
    assert.deepEqual(await rebaseOrRepair(store, 'one', dirOf('one'), owner), { prevDir: `${dirOf('one')}.prev` })
    assert.equal(readFileSync(join(`${dirOf('one')}.prev`, 'lesson.md'), 'utf8'), 'one')
    assert.ok(existsSync(join(dirOf('one'), 'seed.md')), 'the current memory opened in its place')
    // (2) Interrupted after the rename: .prev only.
    work(`${dirOf('two')}.prev`, 'two')
    await rebaseOrRepair(store, 'two', dirOf('two'), owner)
    assert.equal(readFileSync(join(`${dirOf('two')}.prev`, 'lesson.md'), 'utf8'), 'two')
    assert.ok(await store.getDraft('two'))
    // (3) Interrupted inside the open: an untouched copy of an OLDER canonical tree beside .prev.
    work(`${dirOf('three')}.prev`, 'three')
    mkdirSync(dirOf('three'), { recursive: true }) // the empty tree before the seed commit
    await rebaseOrRepair(store, 'three', dirOf('three'), owner)
    assert.equal(readFileSync(join(`${dirOf('three')}.prev`, 'lesson.md'), 'utf8'), 'three', 'the Actor\'s .prev is never moved aside for a copy')
    assert.deepEqual(readdirSync(base).filter(n => n.startsWith('three') && n !== 'three'), [])
    assert.deepEqual(readdirSync(join(base, 'three')).sort(), ['memory', 'memory.prev'])
    // (4) Repeated after it finished (meta, pristine draft, .prev): unchanged.
    await rebaseOrRepair(store, 'three', dirOf('three'), owner)
    assert.equal(readFileSync(join(`${dirOf('three')}.prev`, 'lesson.md'), 'utf8'), 'three')
    // (5) Nothing of the Actor's left: refused, never an empty draft.
    await assert.rejects(rebaseOrRepair(store, 'none', dirOf('none'), owner), e2 => e2.code === 'memory_draft_missing')
    await store.close()
  })

  it('a crash inside the canonical copy of a lost-draft repair never takes a partial copy for the Actor\'s draft (r3-engine-concurrency-4)', async () => {
    const { rebaseOrRepair } = await import('../../lib/engine/learn.mjs')
    const fsp = (await import('node:fs/promises')).default
    const { syncBuiltinESMExports } = await import('node:module')
    const e = await engineEnv()
    const store = await MemoryStore.open(e.pl.store, { sessionsDir: e.pl.sessions, lineagesDir: e.pl.lineages })
    const owner = { kind: 'engine', pid: process.pid, host: (await import('node:os')).hostname(), lineage: 'x' }
    const base = await tmpDir()
    await store.openDraft('seed', { dir: join(base, 'seed'), fresh: true, owner })
    for (const name of ['a.md', 'b.md', 'c.md']) writeFileSync(join(base, 'seed', name), `canonical ${name}\n`)
    await store.commit('seed', { kind: 'practice' })
    // The Actor's draft of e1 holds its lesson; the draft's record is lost.
    const memoryDir = join(base, 't001', 'memory')
    await store.openDraft('e1', { dir: memoryDir, fresh: true, owner })
    writeFileSync(join(memoryDir, 'actor-lesson.md'), 'the Actor work\n')
    rmSync(join(e.pl.store, 'drafts', 'e1.json'))
    // The repair dies inside the canonical copy: one file written, then the process stops.
    const { open } = fsp
    let written = 0
    fsp.open = async (path, flags, ...rest) => {
      if (flags === 'wx' && String(path).startsWith(memoryDir) && ++written === 2) throw new Error('injected crash inside the canonical copy')
      return open(path, flags, ...rest)
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(rebaseOrRepair(store, 'e1', memoryDir, owner), /injected crash/)
    } finally {
      fsp.open = open
      syncBuiltinESMExports()
    }
    assert.equal(written, 2)
    assert.equal(existsSync(memoryDir), false, 'no partial copy sits where the draft belongs')
    assert.equal(readFileSync(join(`${memoryDir}.prev`, 'actor-lesson.md'), 'utf8'), 'the Actor work\n')
    // The recovering op.
    assert.deepEqual(await rebaseOrRepair(store, 'e1', memoryDir, owner), { prevDir: `${memoryDir}.prev` })
    assert.equal(readFileSync(join(`${memoryDir}.prev`, 'actor-lesson.md'), 'utf8'), 'the Actor work\n', '.prev still holds the Actor\'s work')
    assert.deepEqual(readdirSync(memoryDir).sort(), ['a.md', 'b.md', 'c.md'])
    assert.deepEqual(readdirSync(join(base, 't001')).sort(), ['memory', 'memory.prev'])
    assert.ok(await store.getDraft('e1'))
    await store.close()
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

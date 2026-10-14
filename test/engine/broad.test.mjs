// Phase 1 broad waves (SPEC §12.12, §15.3 WP6 broad row), ported from dsh-rsi test/engine.test.ts
// `runBroadExploration` to the fake claude: authored-order serial consolidation on the latest
// canonical memory, wave budget at boundaries, missing fixtures → same-context continuation, unscored
// branch restart, the wave barrier (no commits on infra; resume completes), absorbing quarantine,
// and the Actor memory hidden from (and deleted before) every inspection.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { admitResume, applyResume } from '../../lib/engine/records.mjs'
import { OpJournal } from '../../lib/engine/journal.mjs'
import { create, engineEnv, invocations, protocolEvents, readJson, run, storeJournal } from './_engine.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const wave = (...ids) => ids.map(id => ({ id, files: { 'input.txt': `${id}\n` } }))

async function sessionPrompts(e, dir, ctxKey) {
  const j = await OpJournal.open(dir)
  const ids = [j.result(`${ctxKey}/open`)?.sessionId]
  for (const key of j.keysWithPrefix(`${ctxKey}/restart:`)) if (j.isDone(key)) ids.push(j.result(key).sessionId)
  return ids.flatMap(id => (e.fake.session(id)?.turns ?? []).map(t => t.prompt))
}

describe('the Actor root put back across filesystems (r2-engine-7)', () => {
  it('a crash while the moved-away copy is deleted never replaces the restored tree with a partial one', async () => {
    const fsp = (await import('node:fs/promises')).default
    const { syncBuiltinESMExports } = await import('node:module')
    const { restoreActorRoot } = await import('../../lib/engine/inspect.mjs')
    const base = await tmpDir()
    const root = join(base, 'work', 'projects', 'w001-a')
    const aside = join(base, 'priv', 'w001-a-actor-root')
    mkdirSync(aside, { recursive: true })
    for (const name of ['a.txt', 'b.txt', 'out.txt']) writeFileSync(join(aside, name), `${name}\n`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'replay.txt'), 'the practice replay\n')
    const { rename, rm } = fsp
    // Different filesystems: renaming the Actor's tree back fails with EXDEV, so it is copied; the
    // engine then dies while it deletes the moved-away copy (one file gone, then a crash).
    let crash = true
    fsp.rename = async (from, to) => {
      if (from === aside && to === root) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      return rename(from, to)
    }
    fsp.rm = async (path, options) => {
      if (crash && (path === aside || String(path).startsWith(`${aside}.trash-`))) {
        crash = false
        await rm(join(path, 'a.txt'), { force: true })
        throw new Error('injected crash while deleting the moved-away tree')
      }
      return rm(path, options)
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(restoreActorRoot(root, aside), /injected crash/)
      // The recovering op runs the same step again.
      await restoreActorRoot(root, aside)
    } finally {
      fsp.rename = rename
      fsp.rm = rm
      syncBuiltinESMExports()
    }
    assert.deepEqual(readdirSync(root).sort(), ['a.txt', 'b.txt', 'out.txt'], 'the restored Actor tree is complete')
    assert.equal(existsSync(aside), false)
    await restoreActorRoot(root, aside)
    assert.deepEqual(readdirSync(join(base, 'priv')), [], 'no trash is left behind')
  })
})

describe('broad lineage', () => {
  it('runs two waves from snapshots, consolidates serially in authored order, then ends SATURATED', async () => {
    const e = await engineEnv({ world: { waves: [wave('beta', 'alpha'), wave('gamma')], afterWaves: 'SATURATED', verdicts: { 'w001-alpha': ['FAIL'], '*': ['PASS'] } } })
    const { dir } = await create(e, { phase: 'broad', id: 'b1', direction: 'tiny text tools' })
    const r = await run(e, dir)
    assert.equal(r.status, 'completed')
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'saturated')
    assert.equal(result.waves, 2)
    assert.equal(result.official_evaluator_calls, 0)
    assert.equal(result.official_evaluator_feedback_entered_learning, false)
    assert.deepEqual(result.projects.map(p => [p.id, p.wave, p.verdict]), [['beta', 1, 'PASS'], ['alpha', 1, 'FAIL'], ['gamma', 2, 'PASS']])
    const { journal, tree } = await storeJournal(e)
    // Authored order (beta before alpha), each on the LATEST canonical memory.
    assert.deepEqual(journal.map(c => c.episode), ['b1-w001-beta', 'b1-w001-alpha', 'b1-w002-gamma'])
    assert.equal(result.final_memory_tree_sha256, tree)
    assert.equal(journal[1].treeBefore, journal[0].treeAfter)
    const distills = e.observations().filter(o => o.kind === 'distill')
    assert.deepEqual(distills.map(o => [o.ep, o.seen]), [
      ['w001-beta', []],
      ['w001-alpha', ['lesson-w001-beta.md']],
      ['w002-gamma', ['lesson-w001-alpha.md', 'lesson-w001-beta.md']],
    ])
    // Both branches of wave 1 started from the same pre-wave snapshot (empty memory).
    const layout = e.layout('b1')
    assert.deepEqual(readdirSync(join(layout.priv, 'w001', 'memory_snapshot')), [])
    // Captured fixtures stay private; the authoring tree is emptied after capture.
    assert.equal(readFileSync(join(layout.priv, 'w001', 'projects', 'alpha', 'fixtures', 'tree', 'input.txt'), 'utf8'), 'alpha\n')
    assert.deepEqual(readJson(join(layout.priv, 'w001', 'decision.json')).projects.map(p => p.id), ['beta', 'alpha'])
    // SATURATED: the (empty) authoring root of the last turn is archived privately as leftover.
    assert.equal(existsSync(layout.authoring), false)
    assert.deepEqual(readdirSync(join(layout.priv, 'w003')), ['leftover_001'])
    // The second charter carries the latest wave's outcomes rendered RSIAgent-style.
    const prompts = await sessionPrompts(e, dir, 'cur')
    assert.match(prompts[0], /PERSISTENT PHASE-1 PARALLEL SEARCH/)
    assert.match(prompts[1], /WAVE 1 CURRICULUM RATIONALE:\nexplore wave 1/)
    assert.match(prompts[1], /PROJECT 1\.1 \(beta\)/)
    assert.match(prompts[1], /PROJECT 1\.2 \(alpha\)/)
    assert.match(prompts[1], /TERMINAL OUTCOME: FAIL/)
    assert.match(prompts[1], /MEMORY CHANGES:\n\{\n {2}"created": \[\n {4}"lesson-w001-alpha\.md"/)
    // The Verifier never saw the Actor memory: removed before every inspection, absent from its tree.
    const inspections = e.observations().filter(o => o.kind === 'inspect')
    assert.equal(inspections.length, 3)
    for (const o of inspections) {
      assert.equal(o.actorMemoryExists, false)
      assert.equal(o.candidateHasMemoryDir, false)
      assert.equal(o.unverifiedAllowed, false) // Phase-1 Verifiers answer PASS/FAIL only
      assert.equal(o.cwd, layout.projectRoot(o.ep)) // the replay sits at the Actor's own root (prompts-2)
    }
    const types = (await protocolEvents(dir)).map(ev => ev.type)
    assert.equal(types.filter(t => t === 'WAVE_COMPLETED').length, 2)
    assert.equal(types.at(-1), 'PHASE1_TERMINATED')
    const state = readJson(join(dir, 'state.json'))
    assert.equal(state.status, 'completed')
    assert.equal(state.projectsDone, 3)
  })

  it('stops at a wave boundary when the project budget is reached (a wave may overshoot it)', async () => {
    const e = await engineEnv({ world: { waves: [wave('a', 'b'), wave('c')] }, config: { exploration: { broadProjectBudget: 1 } } })
    const { dir } = await create(e, { phase: 'broad', id: 'budget', direction: 'd' })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'budget_exhausted')
    assert.equal(result.waves, 1)
    assert.equal(result.projects.length, 2)
    assert.equal(invocations(e, 'curriculum').length, 1)
  })

  it('continues the same Curriculum context when a declared fixture tree is missing (drafts kept)', async () => {
    const e = await engineEnv({ world: { waves: [wave('only')], missingOnce: ['only'], afterWaves: 'STALLED' } })
    const { dir } = await create(e, { phase: 'broad', id: 'missing', direction: 'd' })
    await run(e, dir)
    assert.equal(readJson(join(dir, 'result.json')).termination, 'stalled')
    const cur = invocations(e, 'curriculum')
    assert.equal(cur[0].mode, 'new')
    assert.equal(cur[1].mode, 'resume')
    assert.equal(cur[1].sessionId, cur[0].sessionId)
    const prompts = await sessionPrompts(e, dir, 'cur')
    assert.match(prompts[1], /SAME-CONTEXT WAVE CONTINUATION/)
    assert.match(prompts[1], /the fixture tree for project "only" is not replayable/)
  })

  it('refuses an emptied project root as a transport issue and continues the same Actor', async () => {
    const e = await engineEnv({ world: { waves: [wave('p')], afterWaves: 'STALLED', actors: { 'w001-p': { emptyRootOnce: true } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'empty', direction: 'd' })
    await run(e, dir)
    const prompts = await sessionPrompts(e, dir, 'w001/b:p/a1/actor')
    assert.match(prompts[1], /SAME-CONTEXT TRANSPORT CONTINUATION/)
    assert.match(prompts[1], /must stay nonempty/)
    assert.equal(readJson(join(dir, 'result.json')).projects[0].verdict, 'PASS')
  })

  it('restarts a branch unscored from its immutable fixtures after a runtime crash', async () => {
    const e = await engineEnv({ world: { waves: [wave('good', 'flaky')], actors: { 'w001-flaky': { crashOnce: 'after-init' } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'retry', direction: 'd' })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'saturated')
    assert.deepEqual(result.projects.map(p => p.episode), ['retry-w001-good', 'retry-w001-flaky'])
    const layout = e.layout('retry')
    const receipt = readJson(join(layout.priv, 'w001', 'projects', 'flaky', 'infra_attempts', 'a1.retry_receipt.json'))
    assert.equal(receipt.mode, 'restart_unscored_branch_from_immutable_fixtures')
    assert.equal(receipt.priorMemoryPromoted, false)
    assert.equal(receipt.cls, 'crash')
    assert.ok(existsSync(join(layout.priv, 'w001', 'projects', 'flaky', 'infra_attempts', 'attempt_001')))
    assert.ok(existsSync(layout.projectRoot('w001-flaky-a2')))
    const restarted = (await protocolEvents(dir)).filter(ev => ev.type === 'PROJECT_RESTARTED_UNSCORED')
    assert.deepEqual(restarted.map(ev => [ev.episode, ev.attempt, ev.cls]), [['retry-w001-flaky', 2, 'crash']])
    const { journal } = await storeJournal(e)
    assert.deepEqual(journal.map(c => c.episode), ['retry-w001-good', 'retry-w001-flaky'])
  })

  describe('an abandon interrupted after it started (protocol-2)', () => {
    const retryWorld = { waves: [wave('alpha')], afterWaves: 'SATURATED', actors: { 'w001-alpha': { crashOnce: 'after-init' } } }
    const ABANDON = 'w001/b:alpha/a1/abandon'
    const opsOf = dir => readFileSync(join(dir, 'ops.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    let reference = null

    async function referenceRun() {
      if (reference) return reference
      const e = await engineEnv({ world: retryWorld })
      const { dir } = await create(e, { phase: 'broad', id: 'ab', direction: 'd' })
      assert.equal((await run(e, dir)).status, 'completed')
      const records = opsOf(dir).filter(r => r.key === ABANDON)
      reference = {
        result: readJson(join(dir, 'result.json')),
        startSeq: records.find(r => r.status === 'start').seq,
        doneSeq: records.find(r => r.status === 'done').seq,
      }
      return reference
    }

    async function resumeToEnd(e, dir) {
      const admission = await admitResume(dir, { env: e.env })
      assert.equal(admission.ok, true, admission.reasons.join('; '))
      await applyResume(dir, admission)
      return run(e, dir)
    }

    async function assertCompletedLikeReference(e, dir, ref) {
      const result = readJson(join(dir, 'result.json'))
      assert.equal(result.termination, ref.result.termination)
      assert.deepEqual(result.projects.map(p => [p.id, p.episode, p.verdict]), [['alpha', 'ab-w001-alpha', 'PASS']])
      assert.deepEqual((await storeJournal(e)).journal.map(c => c.episode), ['ab-w001-alpha'])
      const priv = join(e.layout('ab').priv, 'w001', 'projects', 'alpha')
      assert.deepEqual(readdirSync(join(priv, 'infra_attempts')).sort(), ['a1.retry_receipt.json', 'attempt_001'])
      assert.equal(existsSync(e.layout('ab').projectRoot('w001-alpha')), false) // archived, never re-entered
      assert.ok(existsSync(join(e.layout('ab').projectRoot('w001-alpha-a2'), 'out.txt')))
      assert.equal(opsOf(dir).filter(r => r.key === ABANDON && r.status === 'done').length, 1)
      return readJson(join(priv, 'infra_attempts', 'a1.retry_receipt.json'))
    }

    it('completes the abandon on resume when the engine died before its done record', async () => {
      const ref = await referenceRun()
      assert.equal(ref.result.termination, 'saturated')
      const e = await engineEnv({ world: retryWorld })
      const { dir } = await create(e, { phase: 'broad', id: 'ab', direction: 'd' })
      const first = await run(e, dir, { fault: `${ref.doneSeq}:throw` })
      assert.equal(first.status, 'paused_infra')
      const second = await resumeToEnd(e, dir)
      assert.equal(second.status, 'completed', JSON.stringify(second.infra))
      const receipt = await assertCompletedLikeReference(e, dir, ref)
      assert.equal(receipt.cls, 'crash') // written by the interrupted run, kept by the recovery
    })

    it('completes the abandon on resume when the engine died right after its start record', async () => {
      const ref = await referenceRun()
      const e = await engineEnv({ world: retryWorld })
      const { dir } = await create(e, { phase: 'broad', id: 'ab', direction: 'd' })
      const first = await run(e, dir, { fault: `${ref.startSeq}:throw:after` })
      assert.equal(first.status, 'paused_infra')
      assert.ok(existsSync(e.layout('ab').projectRoot('w001-alpha'))) // nothing was moved yet
      const second = await resumeToEnd(e, dir)
      assert.equal(second.status, 'completed', JSON.stringify(second.infra))
      const receipt = await assertCompletedLikeReference(e, dir, ref)
      assert.equal(receipt.cls, null) // the abandoning error is gone; the receipt says so
    })

    it('completes the abandon on resume when writing the retry receipt failed once', async () => {
      const ref = await referenceRun()
      const e = await engineEnv({ world: retryWorld })
      const { dir } = await create(e, { phase: 'broad', id: 'ab', direction: 'd' })
      // The receipt path is a non-empty directory: the atomic rename onto it fails. The intent
      // receipt is written before anything moves (r2-engine-8), so nothing was moved.
      const blocker = join(e.layout('ab').priv, 'w001', 'projects', 'alpha', 'infra_attempts', 'a1.retry_receipt.json')
      mkdirSync(join(blocker, 'x'), { recursive: true })
      const first = await run(e, dir)
      assert.equal(first.status, 'paused_infra')
      assert.ok(existsSync(e.layout('ab').projectRoot('w001-alpha')), 'nothing moved before the receipt could be written')
      rmSync(blocker, { recursive: true, force: true })
      const second = await resumeToEnd(e, dir)
      assert.equal(second.status, 'completed', JSON.stringify(second.infra))
      const receipt = await assertCompletedLikeReference(e, dir, ref)
      assert.equal(receipt.attempt, 1)
    })

    it('a crash between archiving the root and rewriting the receipt keeps the class and the archive (r2-engine-8)', async () => {
      const ref = await referenceRun()
      const e = await engineEnv({ world: retryWorld })
      const { dir } = await create(e, { phase: 'broad', id: 'ab', direction: 'd' })
      const priv = join(e.layout('ab').priv, 'w001', 'projects', 'alpha')
      const receiptPath = join(priv, 'infra_attempts', 'a1.retry_receipt.json')
      const fsp = (await import('node:fs/promises')).default
      const { syncBuiltinESMExports } = await import('node:module')
      const { rename } = fsp
      let writes = 0
      // The second write of the receipt (after the root was archived) dies.
      fsp.rename = async (from, to) => {
        if (to === receiptPath && ++writes === 2) throw new Error('injected crash before the receipt was rewritten')
        return rename(from, to)
      }
      syncBuiltinESMExports()
      let first
      try {
        first = await run(e, dir)
      } finally {
        fsp.rename = rename
        syncBuiltinESMExports()
      }
      assert.equal(first.status, 'paused_infra')
      assert.equal(existsSync(e.layout('ab').projectRoot('w001-alpha')), false, 'the root was archived before the crash')
      const second = await resumeToEnd(e, dir)
      assert.equal(second.status, 'completed', JSON.stringify(second.infra))
      const receipt = await assertCompletedLikeReference(e, dir, ref)
      assert.equal(receipt.cls, 'crash', 'the abandoning class survives in the intent receipt')
      assert.equal(receipt.moved, join(priv, 'infra_attempts', 'attempt_001'))
      assert.ok(existsSync(receipt.moved), 'the receipt points at the archived attempt')
      const restarted = (await protocolEvents(dir)).filter(ev => ev.type === 'PROJECT_RESTARTED_UNSCORED')
      assert.deepEqual(restarted.map(ev => ev.cls), ['crash'])
    })

    it('archives the root across filesystems, and completes after a crash while the copied root is deleted (r3-engine-concurrency-2)', async () => {
      const ref = await referenceRun()
      const e = await engineEnv({ world: retryWorld })
      const { dir } = await create(e, { phase: 'broad', id: 'ab', direction: 'd' })
      const root = e.layout('ab').projectRoot('w001-alpha')
      const slot = join(e.layout('ab').priv, 'w001', 'projects', 'alpha', 'infra_attempts', 'attempt_001')
      const fsp = (await import('node:fs/promises')).default
      const { syncBuiltinESMExports } = await import('node:module')
      const { rename, rm } = fsp
      let exdev = 0
      let crash = true
      // The work tree sits on another filesystem than the lineage records: the root cannot be renamed into its slot.
      fsp.rename = async (from, to) => {
        if (String(from) === root && String(to) === slot) {
          exdev++
          throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
        }
        return rename(from, to)
      }
      // The engine dies while it deletes the copied root: one file gone, then a crash.
      fsp.rm = async (path, options) => {
        if (crash && String(path).startsWith(`${root}.trash-`)) {
          crash = false
          await rm(join(String(path), 'input.txt'), { force: true })
          throw new Error('injected crash while deleting the copied root')
        }
        return rm(path, options)
      }
      syncBuiltinESMExports()
      let first
      let second
      try {
        first = await run(e, dir)
        assert.equal(first.status, 'paused_infra')
        assert.equal(exdev, 1)
        assert.equal(crash, false, 'the copied root was being deleted')
        assert.equal(existsSync(root), false, 'the root is retired by a rename: it is never left half-deleted')
        assert.equal(readFileSync(join(slot, 'input.txt'), 'utf8'), 'alpha\n', 'the slot holds the complete copy')
        second = await resumeToEnd(e, dir)
      } finally {
        fsp.rename = rename
        fsp.rm = rm
        syncBuiltinESMExports()
      }
      assert.equal(second.status, 'completed', JSON.stringify(second.infra))
      const receipt = await assertCompletedLikeReference(e, dir, ref)
      assert.equal(receipt.moved, slot)
      assert.equal(receipt.cls, 'crash')
      assert.deepEqual(readdirSync(join(root, '..')).filter(name => name.includes('.trash-')), [], 'no trash is left behind')
    })
  })

  it('puts the Actor tree back before archiving an attempt whose Verifier crashed mid-inspection', async () => {
    const e = await engineEnv({ world: { waves: [wave('v')], afterWaves: 'SATURATED', verifierCrashOnce: ['w001-v'] } })
    const { dir } = await create(e, { phase: 'broad', id: 'vc', direction: 'd' })
    const r = await run(e, dir)
    assert.equal(r.status, 'completed', JSON.stringify(r.infra))
    const priv = join(e.layout('vc').priv, 'w001', 'projects', 'v')
    assert.equal(readJson(join(priv, 'infra_attempts', 'a1.retry_receipt.json')).cls, 'crash')
    assert.ok(existsSync(join(priv, 'infra_attempts', 'attempt_001', 'out.txt')))
    assert.deepEqual(readdirSync(join(priv, 'a1')).filter(name => name.startsWith('actor-root-')), []) // nothing left aside
    assert.equal(existsSync(e.layout('vc').projectRoot('w001-v')), false)
    assert.deepEqual(readJson(join(dir, 'result.json')).projects.map(p => [p.id, p.verdict]), [['v', 'PASS']])
  })

  it('blocks the whole wave on non-retryable infra (no commits), pauses, and completes after resume', async () => {
    const e = await engineEnv({ world: { waves: [wave('good', 'broken')], actors: { 'w001-broken': { apiErrorOnce: { status: 401, error: 'authentication_failed' } } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'barrier', direction: 'd' })
    const first = await run(e, dir)
    assert.equal(first.status, 'paused_infra')
    assert.equal(first.infra.cls, 'auth')
    assert.match(first.pausedAt, /^w001\/b:broken\/a1\/work\/m1$/)
    assert.equal((await storeJournal(e)).journal.length, 0) // the barrier: the good branch is not learned either
    assert.equal(existsSync(join(dir, 'result.json')), false)
    const state = readJson(join(dir, 'state.json'))
    assert.equal(state.status, 'paused_infra')
    assert.deepEqual(state.infra.cls, 'auth')
    const blocked = (await protocolEvents(dir)).filter(ev => ev.type === 'WAVE_BLOCKED')
    assert.deepEqual(blocked.map(ev => ev.failed), [[{ pid: 'broken', cls: 'auth' }]])
    const admission = await admitResume(dir, { env: e.env })
    assert.equal(admission.ok, true, admission.reasons.join('; '))
    assert.deepEqual(admission.overrides, [])
    await applyResume(dir, admission)
    const second = await run(e, dir)
    assert.equal(second.status, 'completed')
    const { journal } = await storeJournal(e)
    assert.deepEqual(journal.map(c => c.episode), ['barrier-w001-good', 'barrier-w001-broken'])
    // The good branch replayed instantly: its Actor was invoked only for work + learning.
    assert.equal(invocations(e, 'actor').filter(i => i.cwd.endsWith('w001-good')).length, 3)
  })

  it('quarantines the lineage on an audit hit (absorbing; the reason is never recorded)', async () => {
    const sealedDir = await tmpDir()
    const sealedFile = join(sealedDir, 'heldout.md')
    const sealed = 'the hidden grader expects exactly forty two widgets arranged in seven neat rows'
    writeFileSync(sealedFile, `${sealed}\n`)
    const e = await engineEnv({
      world: { waves: [wave('x')], curriculumAuditText: sealed },
      config: { audit: { sealedTextFiles: [sealedFile] } },
    })
    const { dir } = await create(e, { phase: 'broad', id: 'quar', direction: 'd' })
    const r = await run(e, dir)
    assert.equal(r.status, 'quarantined')
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'quarantined')
    assert.equal(result.rationale, '')
    assert.doesNotMatch(JSON.stringify(result), /grader|widgets/)
    assert.equal(readJson(join(dir, 'state.json')).status, 'quarantined')
    assert.ok((await protocolEvents(dir)).some(ev => ev.type === 'LINEAGE_QUARANTINED'))
    assert.equal(invocations(e, 'actor').length, 0)
    const admission = await admitResume(dir, { env: e.env })
    assert.equal(admission.ok, false)
    assert.match(admission.reasons.join(' '), /result\.json exists/)
  })

  it('observes (and never captures) Verifier effects on a practice replay copy', async () => {
    const e = await engineEnv({ world: { waves: [wave('m')], verifierMutate: ['w001-m'] } })
    const { dir } = await create(e, { phase: 'broad', id: 'effects', direction: 'd' })
    await run(e, dir)
    const observed = (await protocolEvents(dir)).filter(ev => ev.type === 'VERIFIER_EFFECTS_OBSERVED')
    assert.deepEqual(observed.map(ev => [ev.episode, ev.generation]), [['effects-w001-m', 1]])
    const layout = e.layout('effects')
    const manifest = readJson(join(layout.priv, 'w001', 'projects', 'm', 'a1', 'candidate-g001', 'manifest.json'))
    assert.deepEqual(Object.keys(manifest.files).sort(), ['input.txt', 'out.txt'])
    // The replay at the Actor's root is discarded: the Actor's own tree is back, without the effect.
    assert.equal(existsSync(join(layout.projectRoot('w001-m'), 'tampered-by-verifier.txt')), false)
    assert.equal(readFileSync(join(layout.projectRoot('w001-m'), 'out.txt'), 'utf8'), 'result for w001-m\n')
    assert.equal(existsSync(join(layout.priv, 'w001', 'projects', 'm', 'a1', 'actor-root-g001')), false)
  })

  it('verifies a practice candidate at the same absolute root the Actor used (prompts-2)', async () => {
    const e = await engineEnv({ world: { waves: [wave('cfg')], afterWaves: 'SATURATED', actors: { 'w001-cfg': { absoluteConfig: true } } } })
    const { dir } = await create(e, { phase: 'broad', id: 'reloc', direction: 'd' })
    const r = await run(e, dir)
    assert.equal(r.status, 'completed')
    const layout = e.layout('reloc')
    const root = layout.projectRoot('w001-cfg')
    const [o] = e.observations().filter(x => x.kind === 'inspect')
    assert.equal(o.cwd, root)
    assert.equal(o.root, root) // CANDIDATE ROOT in the charter
    assert.equal(o.configDataDir, join(root, 'data')) // the Actor's absolute path resolves inside the candidate
    assert.equal(o.configDataDirExists, true)
    const verifierPrompts = await sessionPrompts(e, dir, 'w001/b:cfg/a1/verifier')
    assert.match(verifierPrompts[0], new RegExp(`In ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} transform input\\.txt`))
    // The Verifier's probe of that absolute path was not refused as a harness-private path.
    const verifierRuns = invocations(e, 'verifier')
    assert.equal(verifierRuns.length, 1)
    assert.ok(verifierRuns[0].hooksRun.filter(h => h.event === 'PreToolUse').length >= 2)
    assert.ok(verifierRuns[0].hooksRun.every(h => h.decision !== 'deny'), JSON.stringify(verifierRuns[0].hooksRun))
    // After the inspection the Actor's own tree (with its config) is back and learning ran in it.
    assert.equal(readFileSync(join(root, 'config.ini'), 'utf8'), `data_dir=${join(root, 'data')}\n`)
    assert.deepEqual((await storeJournal(e)).journal.map(c => c.episode), ['reloc-w001-cfg'])
  })

  it('restarts a Curriculum whose first message crashed before init with a new uuid (R3, never R4)', async () => {
    const e = await engineEnv({ world: { waves: [], afterWaves: 'STALLED', curriculumCrashOnce: 'before-init' } })
    const { dir } = await create(e, { phase: 'broad', id: 'r3', direction: 'd' })
    const first = await run(e, dir)
    assert.equal(first.status, 'paused_infra')
    assert.equal(first.infra.cls, 'crash')
    const admission = await admitResume(dir, { env: e.env })
    await applyResume(dir, admission)
    const second = await run(e, dir)
    assert.equal(second.status, 'completed')
    const log = invocations(e, 'curriculum')
    assert.equal(log.length, 3) // crash; --resume → R3 (No conversation found); new uuid with the original message
    assert.equal(log[1].mode, 'resume')
    assert.equal(log[1].sessionId, log[0].sessionId)
    assert.equal(log[2].mode, 'new')
    assert.notEqual(log[2].sessionId, log[0].sessionId)
    assert.ok(!e.fake.log().some(entry => entry.exit === 1 && /already in use/.test(JSON.stringify(entry))))
    const restarted = (await protocolEvents(dir)).filter(ev => ev.type === 'ROLE_CONTEXT_RESTARTED')
    assert.equal(restarted.length, 1)
    assert.equal(restarted[0].oldSessionId, log[0].sessionId)
    assert.equal(restarted[0].newSessionId, log[2].sessionId)
  })
})

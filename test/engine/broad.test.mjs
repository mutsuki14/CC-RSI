// Phase 1 broad waves (SPEC §12.12, §15.3 WP6 broad row), ported from dsh-rsi test/engine.test.ts
// `runBroadExploration` to the fake claude: authored-order serial consolidation on the latest
// canonical memory, wave budget at boundaries, missing fixtures → same-context continuation, unscored
// branch restart, the wave barrier (no commits on infra; resume completes), absorbing quarantine,
// and the Actor memory hidden from (and deleted before) every inspection.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
      assert.match(o.cwd, /\/verify\/w00\d-[a-z]+\/candidate$/)
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

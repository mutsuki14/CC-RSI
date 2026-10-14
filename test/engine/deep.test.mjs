// Phase 2 deep target/practice (SPEC §12.9, §12.13, §15.3 WP6 deep row), ported from dsh-rsi
// test/engine.test.ts `runDeepExploration` and `engine learning` to the fake claude.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { OpJournal } from '../../lib/engine/journal.mjs'
import { admitResume, applyResume } from '../../lib/engine/records.mjs'
import { treeFingerprint } from '../../lib/workspace/fingerprint.mjs'
import { create, engineEnv, flagValue, invocations, protocolEvents, readJson, run, storeJournal } from './_engine.mjs'

const TARGET = 'In <PROJECT_ROOT> convert data.csv to JSON.'

async function promptsOf(e, dir, ctxKey) {
  const j = await OpJournal.open(dir)
  const ids = [j.result(`${ctxKey}/open`)?.sessionId]
  for (const key of j.keysWithPrefix(`${ctxKey}/restart:`)) if (j.isDone(key)) ids.push(j.result(key).sessionId)
  return ids.flatMap(id => (e.fake.session(id)?.turns ?? []).map(t => t.prompt))
}

const stage = prompt => (prompt.includes('FINAL MEMORY DISTILLATION') ? 'distill'
  : prompt.includes('TERMINAL MEMORY RECONCILIATION') ? 'reconcile'
    : prompt.includes('FREE-FORM LEARNING DIAGNOSIS') ? 'diagnosis'
      : prompt.includes('MEMORY LIMITS') ? 'limits'
        : prompt.includes('MEMORY CONFLICT') ? 'conflict' : 'work')

describe('deep lineage', () => {
  it('learns a target FAIL, practices with an evidence round, then a fresh target PASS ends curriculum-ready', async () => {
    const e = await engineEnv({
      world: { verdicts: { t001: ['FAIL'], p001: ['UNVERIFIED', 'PASS'], '*': ['PASS'] }, deepPlan: { 1: ['PROJECT', 'READY_FOR_TARGET'] }, sentinel: true },
      files: { 'data.csv': 'a,b\n1,2\n' },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd1', target: TARGET, fixturesDir: e.projectRoot })
    const r = await run(e, dir)
    assert.equal(r.status, 'completed')
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'verifier_pass_curriculum_ready')
    assert.equal(result.target_cycles, 2)
    assert.equal(result.practice_projects, 1)
    assert.equal(result.target_verifier_verdict, 'PASS')
    assert.equal(result.curriculum_decision, 'READY_FOR_TARGET') // readiness is recorded, never a verdict
    assert.deepEqual(result.history, ['- Phase-2 target attempt 1: FAIL', '- Phase-2 practice project p001: PASS', '- Phase-2 target attempt 2: PASS'])
    assert.equal(result.candidate_root, e.layout('d1').projectRoot('t002'))
    assert.match(result.candidate_digest, /^[0-9a-f]{64}$/)
    assert.equal(result.official_evaluator_calls, 0)
    // The target fixtures were replayed into every fresh target root.
    assert.equal(readFileSync(join(e.layout('d1').projectRoot('t001'), 'data.csv'), 'utf8'), 'a,b\n1,2\n')
    assert.equal(readFileSync(join(result.candidate_copy, 'tree', 'data.csv'), 'utf8'), 'a,b\n1,2\n')
    const { journal } = await storeJournal(e)
    assert.deepEqual(journal.map(c => [c.episode, c.kind, c.outcome]), [['d1-t001', 'target', 'FAIL'], ['d1-p001', 'practice', 'PASS'], ['d1-t002', 'target', 'PASS']])
    // Learning order: distill → reconcile → diagnosis, then the harness commits.
    const practice = await promptsOf(e, dir, 'p001/b/a1/actor')
    assert.deepEqual(practice.map(stage).filter(s => s !== 'work'), ['distill', 'reconcile', 'diagnosis'])
    // Only the CLAIM/PROBE pairs reached the Verifier, as NOT_RUN leads; the narrative never did.
    const inspections = e.observations().filter(o => o.kind === 'inspect' && o.ep === 'p001')
    assert.deepEqual(inspections.map(o => [o.gen, o.leads, o.narrativeLeak, o.originalFixtures]), [[1, false, false, true], [2, true, false, true]])
    // prompts-2: both practice inspections replayed the capture at the Actor's own root.
    for (const o of inspections) assert.equal(o.cwd, e.layout('d1').projectRoot('p001'))
    assert.equal(result.candidate_changed_after_verdict, false)
    const verifierPrompts = await promptsOf(e, dir, 'p001/b/a1/verifier')
    assert.match(verifierPrompts[1], /Harness execution classification: NOT_RUN/)
    assert.match(verifierPrompts[1], /test -f out\.txt && echo PASS/)
    assert.doesNotMatch(verifierPrompts[1], /NARRATIVE-SENTINEL/)
    // The Curriculum saw the target outcome with the Actor's diagnosis.
    const cur = await promptsOf(e, dir, 'cur')
    assert.match(cur[0], /ORIGINAL NORTH-STAR TARGET \(verbatim\):\nIn <PROJECT_ROOT> convert data\.csv to JSON\./)
    assert.match(cur[0], /SAME TARGET ACTOR AGENT LEARNING DIAGNOSIS \(verbatim\):\ndiagnosis for t001/)
    assert.match(cur[1], /- Phase-2 practice project p001: PASS/)
    // The original-fixture view is removed after verification.
    assert.equal(existsSync(e.layout('d1').verifyOriginal('p001')), false)
    for (const o of e.observations().filter(x => x.kind === 'inspect')) assert.equal(o.actorMemoryExists, false)
  })

  it('stops right after PASS and its memory commit under the verifier_pass policy (no Curriculum)', async () => {
    const e = await engineEnv({ world: {}, config: { exploration: { stopPolicy: 'verifier_pass' } } })
    const { dir } = await create(e, { phase: 'deep', id: 'd2', target: TARGET })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'verifier_pass')
    assert.equal(result.target_cycles, 1)
    assert.equal(result.stop_policy, 'verifier_pass')
    assert.equal((await storeJournal(e)).journal.length, 1)
    assert.equal(invocations(e, 'curriculum').length, 0)
  })

  it('gives a STALLED Curriculum exactly one final target test', async () => {
    const e = await engineEnv({ world: { verdicts: { '*': ['FAIL'] }, deepPlan: { 1: ['STALLED'] } } })
    const { dir } = await create(e, { phase: 'deep', id: 'd3', target: TARGET })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'curriculum_stalled_final_target_test')
    assert.equal(result.target_cycles, 2)
    assert.equal(result.target_verifier_verdict, 'FAIL')
    assert.equal(result.curriculum_decision, 'STALLED')
    assert.equal(invocations(e, 'curriculum').length, 1)
  })

  it('resumes a stalled target with the escalated Actor and a swapped Verifier on the original Actor model, without prior reports', async () => {
    const e = await engineEnv({
      world: { actors: { t001: { stall: true } }, verdicts: { t001: ['UNVERIFIED', 'PASS'] } },
      config: { models: { escalation: 'verifier-model' }, exploration: { stopPolicy: 'verifier_pass' } },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd4', target: TARGET })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'verifier_pass')
    const actors = invocations(e, 'actor').filter(i => i.cwd.endsWith('/t001'))
    // One acting segment, then three consecutive actionless ones end the segment as stalled (dsh: 4 turns).
    const firstSession = actors[0].sessionId
    const stalled = actors.filter(i => i.sessionId === firstSession)
    assert.equal(stalled.length, 4)
    assert.ok(stalled.every(i => flagValue(i.argv, '--model') === 'actor-model'))
    const resumed = actors.filter(i => i.sessionId !== firstSession)
    assert.ok(resumed.length >= 1)
    assert.equal(flagValue(resumed[0].argv, '--model'), 'verifier-model')
    const verifiers = invocations(e, 'verifier')
    assert.deepEqual(verifiers.map(i => flagValue(i.argv, '--model')), ['verifier-model', 'actor-model'])
    assert.notEqual(verifiers[0].sessionId, verifiers[1].sessionId)
    const [original, swapped] = e.observations().filter(o => o.kind === 'inspect')
    assert.equal(swapped.handoverReports, false) // J1-10: no history and no prior reports by default
    // protocol-6: the fresh second-model context is told it is fresh, never that it has prior investigations.
    assert.deepEqual([original.otherVerifier, original.priorInvestigations], [false, true])
    assert.deepEqual([swapped.gen, swapped.otherVerifier, swapped.priorInvestigations], [2, true, false])
    const events = await protocolEvents(dir)
    const resumedEvent = events.find(ev => ev.type === 'TARGET_RESUMED')
    assert.deepEqual([resumedEvent.mode, resumedEvent.escalated, resumedEvent.verifierSwapped], ['handoff', true, true])
    assert.deepEqual(events.filter(ev => ev.type === 'TARGET_VERIFIED').map(ev => [ev.generation, ev.verdict, ev.forced]), [[1, 'UNVERIFIED', true], [2, 'PASS', false]])
    // The resumed Actor's opening carried the synthesized work log (summarizer) and the handoff note.
    const resumedPrompt = e.fake.session(resumed[0].sessionId).turns[0].prompt
    assert.match(resumedPrompt, /a previous attempt already worked on this task/)
    assert.match(resumedPrompt, /WORK LOG: partial\.txt was written/)
    assert.equal(invocations(e, 'summarizer').length, 1)
    assert.match(readFileSync(join(e.layout('d4').priv, 't001', 'worklog.md'), 'utf8'), /WORK LOG: partial\.txt was written/)
  })

  it('pivots with a strategy self-review when the stalled attempt changed no file (no escalation configured)', async () => {
    const e = await engineEnv({
      world: { actors: { t001: { stall: 'quiet' } }, verdicts: { t001: ['UNVERIFIED', 'PASS'] } },
      config: { exploration: { stopPolicy: 'verifier_pass' } },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd12', target: TARGET })
    await run(e, dir)
    assert.equal(readJson(join(dir, 'result.json')).termination, 'verifier_pass')
    const resumedEvent = (await protocolEvents(dir)).find(ev => ev.type === 'TARGET_RESUMED')
    assert.deepEqual([resumedEvent.mode, resumedEvent.escalated, resumedEvent.verifierSwapped], ['pivot', false, false])
    const actors = invocations(e, 'actor').filter(i => i.cwd.endsWith('/t001'))
    const resumed = actors.filter(i => i.sessionId !== actors[0].sessionId)
    assert.equal(flagValue(resumed[0].argv, '--model'), 'actor-model')
    const opening = e.fake.session(resumed[0].sessionId).turns[0].prompt
    assert.match(opening, /stalled WITHOUT changing any files/)
    assert.match(opening, /REVIEW: try a different entry point\./)
    assert.equal(invocations(e, 'summarizer').length, 2) // work log + strategy review
    // Without escalation the same Verifier context persists across the Actor resume.
    const verifiers = invocations(e, 'verifier')
    assert.equal(new Set(verifiers.map(i => i.sessionId)).size, 1)
  })

  it('runs a final fresh target test when the practice budget runs out (budget_exhausted)', async () => {
    const e = await engineEnv({ world: { verdicts: { '*': ['FAIL'] }, deepPlan: { 1: ['PROJECT', 'PROJECT'] } }, config: { exploration: { deepPracticeBudget: 1 } } })
    const { dir } = await create(e, { phase: 'deep', id: 'd5', target: TARGET })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'budget_exhausted')
    assert.equal(result.target_cycles, 2)
    assert.equal(result.practice_projects, 1)
    assert.equal(invocations(e, 'curriculum').length, 1)
  })

  it('sends an over-limit draft back to the same Actor to condense instead of failing', async () => {
    const e = await engineEnv({
      world: { actors: { t001: { extraMemoryFiles: 2 } } },
      config: { memory: { maxFiles: 2 }, exploration: { stopPolicy: 'verifier_pass' } },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd6', target: TARGET })
    await run(e, dir)
    assert.equal(readJson(join(dir, 'result.json')).termination, 'verifier_pass')
    const prompts = await promptsOf(e, dir, 't001/actor@0')
    assert.deepEqual(prompts.map(stage), ['work', 'distill', 'reconcile', 'diagnosis', 'limits'])
    const { journal } = await storeJournal(e)
    assert.deepEqual(journal[0].created, ['lesson-t001.md'])
  })

  it('rebases a conflicting draft and lets the same Actor re-apply its changes', async () => {
    const e = await engineEnv({ world: { actors: { t001: { concurrentCommitOnce: true } } }, config: { exploration: { stopPolicy: 'verifier_pass' } } })
    const { dir } = await create(e, { phase: 'deep', id: 'd7', target: TARGET })
    await run(e, dir)
    assert.equal(readJson(join(dir, 'result.json')).termination, 'verifier_pass')
    const prompts = await promptsOf(e, dir, 't001/actor@0')
    assert.equal(prompts.map(stage).at(-1), 'conflict')
    const { journal } = await storeJournal(e)
    assert.deepEqual(journal.map(c => c.episode), ['concurrent-session-1', 'd7-t001'])
    assert.deepEqual(journal[1].created, ['lesson-t001.md'])
    assert.ok((await protocolEvents(dir)).some(ev => ev.type === 'MEMORY_CONFLICT_REBASED'))
  })

  it('never learns an UNVERIFIED target and ends target_harness_unverified', async () => {
    const e = await engineEnv({
      world: { verdicts: { '*': ['UNVERIFIED'] }, actors: { t001: { evidenceNoAction: true } } },
      config: { exploration: { targetResumes: 0, unverifiedRounds: 2 } },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd8', target: TARGET })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'target_harness_unverified')
    assert.equal(result.target_verifier_verdict, 'UNVERIFIED')
    assert.equal((await storeJournal(e)).journal.length, 0)
    const verified = (await protocolEvents(dir)).filter(ev => ev.type === 'TARGET_VERIFIED')
    assert.deepEqual(verified.map(ev => [ev.generation, ev.forced]), [[1, false], [2, false], [3, true]])
  })

  it('stalls hollow UNVERIFIED re-submissions at unverifiedRounds, but evidence work only at the emergency ceiling (protocol-3)', async () => {
    const stalledAt = async (id, actorConf) => {
      const e = await engineEnv({ world: { verdicts: { '*': ['UNVERIFIED'] }, actors: { t001: actorConf } }, config: { exploration: { targetResumes: 0 } } })
      const { dir } = await create(e, { phase: 'deep', id, target: TARGET })
      await run(e, dir)
      const result = readJson(join(dir, 'result.json'))
      assert.equal(result.termination, 'target_harness_unverified')
      assert.equal((await storeJournal(e)).journal.length, 0)
      const events = await protocolEvents(dir)
      return {
        reasons: events.filter(ev => ev.type === 'TARGET_STALLED').map(ev => ev.reason),
        verified: events.filter(ev => ev.type === 'TARGET_VERIFIED').map(ev => [ev.generation, ev.forced]),
      }
    }
    // RSIAgent max_consec_done: re-declarations without any tool action stall at the 3rd UNVERIFIED.
    const hollow = await stalledAt('d13', { evidenceNoAction: true })
    assert.deepEqual(hollow.reasons, ['3 consecutive UNVERIFIED rounds'])
    assert.deepEqual(hollow.verified, [[1, false], [2, false], [3, false], [4, true]])
    // Every evidence round acted (wrote evidence.txt): the count resets; only the emergency ceiling (8) stalls.
    const working = await stalledAt('d14', {})
    assert.deepEqual(working.reasons, ['emergency ceiling: 8 UNVERIFIED rounds in one Actor context'])
    assert.deepEqual(working.verified, [...Array.from({ length: 8 }, (_, i) => [i + 1, false]), [9, true]])
  })

  it('reports the verified tree as the final candidate even when the Actor rewrote its root while learning (protocol-1)', async () => {
    const e = await engineEnv({ world: { actors: { t001: { learnWritesRoot: true } } }, config: { exploration: { stopPolicy: 'verifier_pass' } } })
    const { dir } = await create(e, { phase: 'deep', id: 'd15', target: TARGET })
    assert.equal((await run(e, dir)).status, 'completed')
    const result = readJson(join(dir, 'result.json'))
    assert.deepEqual([result.termination, result.target_verifier_verdict], ['verifier_pass', 'PASS'])
    const root = e.layout('d15').projectRoot('t001')
    assert.equal(readFileSync(join(root, 'out.txt'), 'utf8'), 'REWRITTEN AFTER THE VERDICT\n') // the live root changed after the PASS
    assert.equal(result.candidate_changed_after_verdict, true)
    // The candidate copy (what a sealed evaluation scores) is the tree the Verifier inspected.
    assert.equal(readFileSync(join(result.candidate_copy, 'tree', 'out.txt'), 'utf8'), 'result for t001\n')
    assert.equal(await treeFingerprint(join(result.candidate_copy, 'tree')), result.candidate_digest)
    const j = await OpJournal.open(dir)
    assert.equal(j.result('t001/g1/pre').fp, j.result('t001/verified-candidate').rootFp)
    assert.equal(result.candidate_digest, j.result('t001/verified-candidate').digest)
    assert.equal(readFileSync(join(e.layout('d15').priv, 't001', 'verified-candidate', 'tree', 'out.txt'), 'utf8'), 'result for t001\n')
  })

  it('reports only the decision that ended the last evolution as curriculum_decision (protocol-9)', async () => {
    const e = await engineEnv({
      world: { verdicts: { t001: ['FAIL'], '*': ['PASS'] }, deepPlan: { 1: ['READY_FOR_TARGET'], 2: ['PROJECT', 'PROJECT', 'PROJECT'] } },
      config: { exploration: { deepPracticeBudget: 2 } },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd16', target: TARGET })
    await run(e, dir)
    const result = readJson(join(dir, 'result.json'))
    assert.deepEqual([result.termination, result.target_verifier_verdict, result.target_cycles], ['budget_exhausted', 'PASS', 3])
    const decided = (await protocolEvents(dir)).filter(ev => ev.type === 'CURRICULUM_DECIDED').map(ev => ev.decision)
    assert.deepEqual(decided, ['READY_FOR_TARGET', 'PROJECT', 'PROJECT'])
    assert.equal(result.curriculum_decision, null) // the last evolution was cut off by the budget, not judged ready
  })

  it('pauses on practice UNVERIFIED exhaustion and grants one more evidence round on resume', async () => {
    const e = await engineEnv({
      world: { verdicts: { t001: ['FAIL'], p001: ['UNVERIFIED', 'UNVERIFIED', 'PASS'], '*': ['PASS'] }, deepPlan: { 1: ['PROJECT', 'READY_FOR_TARGET'] } },
      config: { exploration: { unverifiedRounds: 2 } },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd9', target: TARGET })
    const first = await run(e, dir)
    assert.equal(first.status, 'paused_infra')
    assert.equal(first.infra.cls, 'unverified_exhausted')
    assert.equal(first.pausedAt, 'p001/b/a1/unverified@2')
    assert.deepEqual((await storeJournal(e)).journal.map(c => c.episode), ['d9-t001']) // infra never commits
    const admission = await admitResume(dir, { env: e.env })
    assert.equal(admission.ok, true)
    assert.deepEqual(admission.overrides, ['p001/b/a1/unverified@2'])
    await applyResume(dir, admission)
    const second = await run(e, dir)
    assert.equal(second.status, 'completed')
    const verified = (await protocolEvents(dir)).filter(ev => ev.type === 'PRACTICE_VERIFIED')
    assert.deepEqual(verified.map(ev => [ev.generation, ev.verdict]), [[1, 'UNVERIFIED'], [2, 'UNVERIFIED'], [3, 'PASS']])
    assert.equal(readJson(join(dir, 'result.json')).termination, 'verifier_pass_curriculum_ready')
  })

  it('re-seeds a practice Verifier whose transcript vanished with its own prior reports', async () => {
    const e = await engineEnv({
      world: { verdicts: { t001: ['FAIL'], p001: ['UNVERIFIED', 'PASS'], '*': ['PASS'] }, deepPlan: { 1: ['PROJECT', 'READY_FOR_TARGET'] }, loseVerifierTranscript: 'p001' },
    })
    const { dir } = await create(e, { phase: 'deep', id: 'd11', target: TARGET })
    const r = await run(e, dir)
    assert.equal(r.status, 'completed')
    const restarted = (await protocolEvents(dir)).filter(ev => ev.type === 'ROLE_CONTEXT_RESTARTED')
    assert.equal(restarted.length, 1)
    assert.equal(restarted[0].ctx, 'p001/b/a1/verifier')
    const fresh = e.fake.session(restarted[0].newSessionId).turns[0].prompt
    assert.match(fresh, /candidate generation 2/)
    assert.match(fresh, /--- generation 1 ---\nInspection of p001 generation 1\.\nVERDICT: UNVERIFIED/)
    assert.match(fresh, /LEAD 1/)
    const verified = (await protocolEvents(dir)).filter(ev => ev.type === 'PRACTICE_VERIFIED')
    assert.deepEqual(verified.map(ev => [ev.generation, ev.verdict]), [[1, 'UNVERIFIED'], [2, 'PASS']])
  })

  it('rolls back Verifier effects on the live target root', async () => {
    const e = await engineEnv({ world: { verifierMutate: ['t001'] }, config: { exploration: { stopPolicy: 'verifier_pass' } } })
    const { dir } = await create(e, { phase: 'deep', id: 'd10', target: TARGET })
    await run(e, dir)
    const rolled = (await protocolEvents(dir)).filter(ev => ev.type === 'VERIFIER_EFFECTS_ROLLED_BACK')
    assert.deepEqual(rolled.map(ev => [ev.episode, ev.generation, ev.paths]), [['t001', 1, ['tampered-by-verifier.txt']]])
    const root = e.layout('d10').projectRoot('t001')
    assert.equal(existsSync(join(root, 'tampered-by-verifier.txt')), false)
    assert.equal(readFileSync(join(root, 'out.txt'), 'utf8'), 'result for t001\n')
    assert.equal(existsSync(join(e.layout('d10').priv, 't001', 'checkpoints', 'g001')), false)
    // The Actor memory view was re-materialized after the inspection.
    assert.equal(existsSync(e.layout('d10').actorMemory('t001')), false) // committed: the draft dir is discarded
  })
})

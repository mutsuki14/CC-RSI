// Phase 3 frozen lineage (SPEC §12.14, §15.3 WP6 frozen row): FAIL → same-Actor repair inspected by
// the same Verifier context; no learning; the memory hash is unchanged; frozen tamper → infra.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { preflight } from '../../lib/engine/records.mjs'
import { OpJournal } from '../../lib/engine/journal.mjs'
import { create, engineEnv, invocations, protocolEvents, readJson, REPO_ROOT, run, storeJournal } from './_engine.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const TARGET = 'In <PROJECT_ROOT> write the report.'

/** Commits one memory file and freezes the store. Returns the frozen tree hash. */
async function seedAndFreeze(e) {
  const store = await MemoryStore.open(e.pl.store, { sessionsDir: e.pl.sessions, lineagesDir: e.pl.lineages })
  try {
    const dir = join(await tmpDir(), 'draft')
    await store.openDraft('seed-1', { dir, fresh: true })
    writeFileSync(join(dir, 'procedure.md'), 'verify before you hand off\n')
    await store.commit('seed-1', { kind: 'task', outcome: 'PASS' })
    return (await store.freeze({ by: 'test' })).treeHash
  } finally {
    await store.close()
  }
}

describe('frozen lineage', () => {
  it('repairs a FAIL with the same Actor and the same Verifier context, learns nothing, keeps the frozen tree', async () => {
    const e = await engineEnv({ world: { verdicts: { t001: ['FAIL', 'PASS'] } } })
    const frozenTree = await seedAndFreeze(e)
    const { dir } = await create(e, { phase: 'frozen', id: 'f1', target: TARGET })
    const r = await run(e, dir)
    assert.equal(r.status, 'completed')
    const result = readJson(join(dir, 'result.json'))
    assert.equal(result.termination, 'frozen_attempt_complete')
    assert.equal(result.target_verifier_verdict, 'PASS')
    assert.equal(result.frozen_tree_sha256, frozenTree)
    assert.equal(result.final_memory_tree_sha256, frozenTree)
    assert.equal(result.official_evaluator_calls, 0)
    assert.match(result.candidate_digest, /^[0-9a-f]{64}$/)
    const { journal, tree } = await storeJournal(e)
    assert.deepEqual(journal.map(c => c.episode), ['seed-1']) // nothing learned
    assert.equal(tree, frozenTree)
    // One Actor context (repair, no fresh-context pivot) and one Verifier context: --resume of the same session.
    const actors = invocations(e, 'actor')
    assert.equal(new Set(actors.map(i => i.sessionId)).size, 1)
    assert.deepEqual(actors.map(i => i.mode), ['new', 'resume'])
    const verifiers = invocations(e, 'verifier')
    assert.deepEqual(verifiers.map(i => i.mode), ['new', 'resume'])
    assert.equal(verifiers[0].sessionId, verifiers[1].sessionId)
    const j = await OpJournal.open(dir)
    const actorSession = j.result('t001/actor@0/open').sessionId
    const prompts = e.fake.session(actorSession).turns.map(t => t.prompt)
    assert.match(prompts[0], /Durable memory is frozen/)
    assert.match(prompts[1], /found concrete evidence that the task is NOT complete/)
    assert.match(prompts[1], /STATUS: SUBMIT/)
    assert.equal(invocations(e, 'curriculum').length, 0)
    const types = (await protocolEvents(dir)).map(ev => ev.type)
    assert.ok(!types.includes('MEMORY_COMMITTED'))
    assert.ok(types.includes('FROZEN_ATTEMPT_COMPLETED'))
    // The Actor saw the frozen memory read-only.
    assert.match(prompts[0], /procedure\.md/)
  })

  it('a stalled frozen attempt resumes in a fresh Actor context that keeps the frozen boundary and its scratch (prompts-8, protocol-7, prompts-3)', async () => {
    // The stalled context's forced inspection FAILs (frozen: not terminal), so a fresh context resumes.
    const e = await engineEnv({ world: { actors: { t001: { stall: true } }, verdicts: { t001: ['FAIL', 'PASS'] } } })
    const frozenTree = await seedAndFreeze(e)
    const { dir } = await create(e, { phase: 'frozen', id: 'f3', target: TARGET })
    const r = await run(e, dir)
    assert.equal(r.status, 'completed', JSON.stringify(r))
    const j = await OpJournal.open(dir)
    const scratch = join(e.layout('f3').W, 'actor-private', 't001', 'scratch')
    const opening = e.fake.session(j.result('t001/actor@0/open').sessionId).turns[0].prompt
    assert.ok(opening.includes(`in your private scratch directory ${scratch}`), 'the first opening names the Actor scratch')
    const resumed = e.fake.session(j.result('t001/actor@1/open').sessionId).turns[0].prompt
    assert.match(resumed, /continuing this target attempt/)
    assert.match(resumed, /Durable memory is frozen/)
    assert.doesNotMatch(resumed, /memory-distillation/)
    assert.ok(resumed.includes(`in your private scratch directory ${scratch}`))
    assert.equal((await storeJournal(e)).tree, frozenTree)
  })

  it('pauses with infra memory_frozen_tamper when the frozen tree changed', async () => {
    const e = await engineEnv({ world: {} })
    await seedAndFreeze(e)
    const { dir } = await create(e, { phase: 'frozen', id: 'f2', target: TARGET })
    writeFileSync(join(e.pl.store, 'memory', 'procedure.md'), 'tampered\n')
    const r = await run(e, dir)
    assert.equal(r.status, 'paused_infra')
    assert.equal(r.infra.cls, 'memory_frozen_tamper')
    assert.equal(readJson(join(dir, 'state.json')).infra.cls, 'memory_frozen_tamper')
    assert.equal(invocations(e, 'actor').length, 0)
  })

  it('refuses to start a frozen lineage on unfrozen memory, and a learning lineage on frozen memory', async () => {
    const e = await engineEnv({ world: {} })
    const opts = { home: e.home, projectRoot: e.projectRoot, allowUnconfined: true, pluginRoot: REPO_ROOT, env: e.env }
    const frozenOnLearning = await preflight({ ...opts, phase: 'frozen', target: TARGET })
    assert.match(frozenOnLearning.blockers.join('\n'), /memory is not frozen/)
    await seedAndFreeze(e)
    const learningOnFrozen = await preflight({ ...opts, phase: 'deep', target: TARGET })
    assert.match(learningOnFrozen.blockers.join('\n'), /memory is frozen/)
    const ok = await preflight({ ...opts, phase: 'frozen', target: TARGET })
    assert.deepEqual(ok.blockers, [])
  })
})

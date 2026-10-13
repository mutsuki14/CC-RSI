// Phase 3 — frozen lineage (SPEC §12.14; RSIAgent Phase-3 test-time reuse with baseline.yaml:
// FAIL → REVISE by the same Actor, no learning, no Curriculum).
//
// The store must be frozen and intact. One target attempt runs on a read-only copy of the frozen
// memory; a Verifier FAIL goes back to the SAME Actor for repair, inspected again by the same
// Verifier context. Nothing is learned. The frozen tree is re-checked at the end (a mismatch is
// infra `memory_frozen_tamper`). The sealed evaluator is never run here (SPEC §13.4).

import { MemoryError } from '../memory/errors.mjs'
import { InfraError } from '../runtime/errors.mjs'
import { captureFinalCandidate, ensureTargetFixtures } from './deep.mjs'
import { countInfraPauses, resultRecord } from './records.mjs'
import { targetAttempt } from './target.mjs'

async function frozenIntact(store) {
  try {
    await store.assertFrozenIntact()
  } catch (error) {
    if (error instanceof MemoryError) throw new InfraError('memory_frozen_tamper', error.message)
    throw error
  }
}

/** Phase 3 (SPEC §12.14). Returns `{ termination, attempt }` after the `final` op wrote result.json. */
export async function runFrozen(run) {
  const { j, lineage, store } = run
  const init = await j.op('init', 'init', { phase: 'frozen' }, async () => {
    const frozen = await store.frozen()
    if (!frozen) throw new InfraError('memory_not_frozen', 'a frozen lineage needs frozen memory (it was unfrozen)')
    await frozenIntact(store)
    const fixtures = await ensureTargetFixtures(run)
    return { frozenTree: frozen.treeHash, memoryTree: await store.treeHash(), fixtures }
  })
  await run.event('init/ev:started', 'LINEAGE_STARTED', { phase: 'frozen', memoryTree: init.memoryTree, isolation: lineage.isolation })
  run.setCounters({ targetCycles: 1 })
  const attempt = await targetAttempt(j, 't001', { lineage, store, frozen: true, run })
  await run.event('ev:completed', 'FROZEN_ATTEMPT_COMPLETED', { verdict: attempt.verdict })
  const termination = attempt.verdict === 'UNVERIFIED' ? 'target_harness_unverified' : 'frozen_attempt_complete'
  await j.op('final', 'final', { termination }, async () => {
    await frozenIntact(store)
    const { candidateCopy, candidateDigest } = await captureFinalCandidate(run, attempt.root)
    const record = resultRecord(lineage, {
      termination,
      rationale: termination === 'frozen_attempt_complete' ? `the frozen attempt ended with ${attempt.verdict}` : 'the frozen attempt ended without a PASS or FAIL verdict',
      targetCycles: 1,
      history: [`- Phase-3 frozen attempt: ${attempt.verdict}`],
      targetVerdict: attempt.verdict,
      candidateRoot: attempt.root,
      candidateCopy,
      candidateDigest,
      initialTree: init.memoryTree,
      finalTree: await store.treeHash(),
      frozenTree: init.frozenTree,
      costUsd: run.costUsd(),
      infraPauses: await countInfraPauses(run.lineageDir),
    })
    await run.complete(record)
    return { termination }
  })
  return { termination, attempt }
}

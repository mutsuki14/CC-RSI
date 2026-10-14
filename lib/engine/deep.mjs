// Phase 2 — deep target/practice (SPEC §12.13; RSIAgent `run_self_evolving_loop`, dsh-rsi
// lineage.ts:647-777 `runDeepExploration`).
//
// Each cycle attempts the immutable target with a fresh Actor; a grounded PASS/FAIL is learned by
// that same Actor. The persistent Curriculum then chooses focused practice (PROJECT) until it
// declares READY_FOR_TARGET or STALLED. Invariants: readiness is never a verdict (it is recorded as
// `curriculum_decision`); any practice forces a fresh unchanged-target attempt; STALLED buys exactly
// one final target test; UNVERIFIED is never learned; infra never commits. Stop policies:
// `curriculum_review` (default; a target PASS is reviewed by the Curriculum) and `verifier_pass`.

import { join } from 'node:path'
import { exists } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { pad3 } from '../core/ids.mjs'
import { MemoryQuarantineError } from '../memory/errors.mjs'
import { curriculumContinuation, curriculumRuntimeContract, deepCharter, outcomeText, stallContinuation, targetOutcomeText } from '../prompts/roles.mjs'
import { fail, ok, parseDecision } from '../protocol/tokens.mjs'
import { PROJECT_ROOT_TOKEN } from '../protocol/wave.mjs'
import { removeTree } from '../workspace/copy.mjs'
import { captureTree, shapeGate } from '../workspace/fixtures.mjs'
import { treeFingerprint } from '../workspace/fingerprint.mjs'
import { auditCurriculum, curriculumContext, prepareCurriculum } from './broad.mjs'
import { learnOp, snapshotCanonical } from './learn.mjs'
import { practiceActorContext, runProjectWithRetry } from './project.mjs'
import { countInfraPauses, resultRecord } from './records.mjs'
import { journaledConverse, transportPolicy } from './steps.mjs'
import { captureCandidate, targetAttempt } from './target.mjs'

const DEEP_DECISIONS = ['PROJECT', 'READY_FOR_TARGET', 'STALLED']

/**
 * Captures the final candidate privately (SPEC §12.13 finish): `priv/final-candidate/{tree,
 * manifest.json}` and its treeFingerprint (what a sealed evaluation measures). `root` is the tree
 * the last Verifier inspected: a learned target attempt's frozen `verified-candidate` copy, else
 * its live root. A tree the capture refuses (links leaving the tree, special files) is copied
 * verbatim instead.
 */
export async function captureFinalCandidate(run, root) {
  const { dir, digest } = await captureCandidate(root, join(run.layout.priv, 'final-candidate'))
  return { candidateCopy: dir, candidateDigest: digest }
}

/** Ensures the immutable target fixtures exist when lineage.json says they were captured (SPEC §12.13 op init). */
export async function ensureTargetFixtures(run) {
  const target = run.lineage.target
  const dest = join(run.layout.priv, 'target-fixtures')
  if (!target?.fixturesCaptured) return false
  if (await exists(join(dest, 'manifest.json'))) return true
  if (target.fixturesDir && (await exists(target.fixturesDir))) {
    await captureTree(target.fixturesDir, dest)
    return true
  }
  return false
}

/**
 * Phase 2 (SPEC §12.13). Returns `{ termination, attempt }` after the `final` op wrote result.json.
 */
export async function runDeep(run) {
  const { j, lineage, layout, store } = run
  const exploration = run.config.exploration ?? {}
  const init = await j.op('init', 'init', { phase: 'deep' }, async () => {
    await store.assertCanonicalIntact()
    const fixtures = await ensureTargetFixtures(run)
    return { memoryTree: await store.treeHash(), fixtures }
  })
  await run.event('init/ev:started', 'LINEAGE_STARTED', { phase: 'deep', memoryTree: init.memoryTree, isolation: lineage.isolation })

  const target = lineage.target.text
  const policy = transportPolicy(run.config)
  const memoryAccess = exploration.curriculumMemoryAccess === 'none' ? 'none' : 'read_only'
  const authoringRoot = layout.practiceAuthoring
  const history = []
  const projects = []
  let finalAfterStall = false
  let finalAfterBudget = false
  let practiceProjects = 0
  let decisions = 0
  let curriculumDecision = null
  let cur = null
  let attempt = null

  const finish = async termination => {
    await run.event('ev:terminated', 'TARGET_LOOP_TERMINATED', { termination })
    const result = await j.op('final', 'final', { termination }, async () => {
      // The candidate is the tree the Verifier judged (protocol-1); whether the same Actor changed its
      // live root while it learned is recorded, never scored.
      const { candidateCopy, candidateDigest } = await captureFinalCandidate(run, attempt.verifiedCandidate ?? attempt.root)
      const changedAfterVerdict = attempt.verifiedRootFp ? (await treeFingerprint(attempt.root)) !== attempt.verifiedRootFp : false
      const record = resultRecord(lineage, {
        termination,
        rationale: RATIONALE[termination] ?? '',
        projects,
        targetCycles: run.counters.targetCycles,
        practiceProjects,
        history,
        targetVerdict: attempt.verdict,
        curriculumDecision,
        candidateRoot: attempt.root,
        candidateCopy,
        candidateDigest,
        candidateChangedAfterVerdict: changedAfterVerdict,
        initialTree: init.memoryTree,
        finalTree: await store.treeHash(),
        costUsd: run.costUsd(),
        infraPauses: await countInfraPauses(run.lineageDir),
        learningAfterSealed: (await store.sealed())?.learningAfterSealed === true,
      })
      await run.complete(record)
      return { termination }
    })
    return { termination: result.termination, attempt }
  }

  for (let c = 1; ; c++) {
    run.setCounters({ targetCycles: c })
    attempt = await targetAttempt(j, `t${pad3(c)}`, { lineage, store, frozen: false, run })
    history.push(`- Phase-2 target attempt ${c}: ${attempt.verdict}`)
    if (finalAfterBudget) return finish('budget_exhausted') // the verdict is recorded, even PASS
    const reviewPass = attempt.verdict === 'PASS' && exploration.stopPolicy !== 'verifier_pass' && !finalAfterStall
    if (attempt.verdict === 'PASS' && !reviewPass) return finish('verifier_pass')
    if (finalAfterStall) return finish('curriculum_stalled_final_target_test')
    if (attempt.verdict === 'UNVERIFIED') return finish('target_harness_unverified')
    if ((exploration.targetCycleBudget ?? 6) > 0 && c >= exploration.targetCycleBudget) return finish('budget_exhausted')

    if (cur === null) {
      cur = curriculumContext(j, run) // opened lazily after the first attempt; persists for the lineage
      await cur.open()
    }
    let latest = targetOutcomeText({ target, verdict: attempt.verdict, report: attempt.report, diagnosis: attempt.diagnosis, lifecycle: true })
    let practiceThisEvolution = 0
    // result.json carries only the decision that ended the LAST evolution (protocol-9): one cut off
    // by a budget, with no readiness judgment, reports null.
    curriculumDecision = null
    for (;;) {
      const practiceBudget = exploration.deepPracticeBudget ?? 6
      const overBudget = practiceBudget > 0 && practiceProjects >= practiceBudget
      const overCost = (exploration.maxCostUsd ?? 0) > 0 && run.costUsd() >= exploration.maxCostUsd
      if (overBudget || overCost) {
        if (practiceThisEvolution === 0) return finish('budget_exhausted')
        finalAfterBudget = true // practice changed memory since the last attempt: a final fresh test is mandatory
        break
      }
      decisions++
      const D = `d${pad3(decisions)}`
      const P = `p${pad3(practiceProjects + 1)}`
      const fixturesCapture = join(layout.priv, P, 'fixtures')
      const prep = await j.op(`${D}/prep`, 'prep', { decision: decisions }, () => prepareCurriculum(run, authoringRoot))
      const d = await journaledConverse(j, `${D}/cur`, cur, {
        first: deepCharter({
          target, history: history.join('\n'), latestOutcome: latest, notes: prep.notes, memoryAccess, authoringRoot,
          memoryDir: memoryAccess === 'none' ? undefined : layout.curriculumMemory,
        }) + curriculumRuntimeContract({ cwd: layout.curriculum, authoringRoot, notesFile: layout.notes }),
        // PROJECT: the body names <PROJECT_ROOT> and the fixture root passes the shape gate; the
        // fixtures are captured inside the same recorded parse (J2-5).
        parse: async reply => {
          const parsed = parseDecision(String(reply?.text ?? ''), DEEP_DECISIONS)
          if (!parsed.ok) return parsed
          const decision = parsed.value
          if (decision.decision === 'PROJECT') {
            if (!decision.body.includes(PROJECT_ROOT_TOKEN)) return fail(`the PROJECT handoff does not name ${PROJECT_ROOT_TOKEN} as its project root`)
            const problem = await shapeGate(authoringRoot)
            if (problem) return fail(`the fixture tree at ${authoringRoot} is not replayable: ${problem}`)
            try {
              await captureTree(authoringRoot, fixturesCapture)
            } catch (error) {
              if (typeof error?.code !== 'string' || !error.code.startsWith('capture_')) throw error
              return fail(`the fixture tree at ${authoringRoot} could not be captured: ${error.message}`)
            }
          }
          return ok({ ...decision, text: reply.text })
        },
        continuation: detail => curriculumContinuation({ detail }),
        stallContinuation: () => stallContinuation({ role: 'CURRICULUM' }),
        policy,
        who: 'Curriculum Agent',
      })
      const decision = d.value
      const audit = await j.op(`${D}/audit`, 'audit', { decision: decisions }, () => auditCurriculum(run, {
        surface: 'decision', episode: D, text: decision.text, captures: decision.decision === 'PROJECT' ? [fixturesCapture] : [],
      }))
      if (audit.hit) throw new MemoryQuarantineError({ lineage: lineage.id, surface: 'decision' })
      if (decision.decision !== 'PROJECT') curriculumDecision = decision.decision // readiness is never a verdict
      await run.event(`${D}/ev:decided`, 'CURRICULUM_DECIDED', { k: decisions, decision: decision.decision })
      if (decision.decision === 'READY_FOR_TARGET') break
      if (decision.decision === 'STALLED') {
        finalAfterStall = true
        break
      }
      // PROJECT
      practiceProjects++
      run.setCounters({ practiceProjects })
      const snapshot = join(layout.priv, P, 'memory_snapshot')
      await j.op(`${P}/capture`, 'capture', { p: practiceProjects }, async () => {
        if (!(await exists(join(fixturesCapture, 'manifest.json')))) await captureTree(authoringRoot, fixturesCapture)
        const snapshotTree = await snapshotCanonical(store, snapshot)
        await removeTree(authoringRoot)
        return { snapshotTree }
      })
      await run.event(`${P}/ev:started`, 'PRACTICE_STARTED', { p: practiceProjects })
      const b = await runProjectWithRetry(j, `${P}/b`, {
        phase: 2, ep: P, episode: `${lineage.id}-${P}`, instruction: decision.body, fixturesCapture, memorySource: snapshot, privBase: join(layout.priv, P), run,
      })
      const actor = practiceActorContext(j, run, b.actorKey, b.ep)
      const L = await learnOp(j, `${P}/learn`, actor, {
        store, episode: b.episode, kind: 'practice', outcome: b.verdict, report: b.report, memoryDir: b.memoryDir, diagnosis: true, lineage, run,
      })
      history.push(`- Phase-2 practice project ${P}: ${b.verdict}`)
      latest = outcomeText({
        label: `Phase-2 practice project ${P}`,
        instruction: decision.body,
        verdict: b.verdict,
        reports: b.reports,
        // No MEMORY CHANGES in a Phase-2 outcome (RSIAgent target_learning.py _outcome_text; prompts-6).
        diagnosis: L.diagnosisText,
      })
      projects.push({ id: P, wave: null, episode: b.episode, instructionSha256: sha256Hex(decision.body), verdict: b.verdict, reportSha: b.reportSha, commit: L.record })
      await run.event(`${P}/ev:learned`, 'PRACTICE_LEARNING_COMPLETED', { p: practiceProjects, verdict: b.verdict, treeAfter: L.record.treeAfter })
      practiceThisEvolution++
    }
    if (finalAfterBudget) continue // the final fresh target test follows
    if (attempt.verdict === 'PASS' && practiceThisEvolution === 0) {
      return finish(finalAfterStall ? 'verifier_pass_curriculum_stalled' : 'verifier_pass_curriculum_ready')
    }
    // Otherwise a fresh attempt on the unchanged target is MANDATORY (after any practice, and after
    // FAIL + READY_FOR_TARGET with no practice).
  }
}

const RATIONALE = {
  verifier_pass: 'the target Verifier returned PASS',
  verifier_pass_curriculum_ready: 'the target Verifier returned PASS and the Curriculum requested no further practice',
  verifier_pass_curriculum_stalled: 'the target Verifier returned PASS and the Curriculum stalled',
  curriculum_stalled_final_target_test: 'the Curriculum stalled; the one final target test was run',
  target_harness_unverified: 'the target attempt ended without a PASS or FAIL verdict',
  budget_exhausted: 'an emergency budget was exhausted; this is not convergence',
}

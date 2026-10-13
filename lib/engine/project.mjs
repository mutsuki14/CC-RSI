// Practice projects (SPEC §12.11): one Phase-1 wave branch or one Phase-2 practice project, and the
// unscored restart from immutable fixtures (RSIAgent `_execute_branch_with_infra_retry`,
// explore/phase1_wave.py:448-489; dsh-rsi lineage.ts:315-392 `runProject` / `runProjectWithRetry`).
//
// A fresh Actor works in a byte-exact replay of the Curriculum's fixtures with a read-only copy of
// the pre-project memory snapshot; its handoff is captured immutably; a fresh Verifier inspects a
// fresh replay of that capture (never the Actor's live tree), with the Actor memory removed first.
// Phase 1 Verifiers answer PASS/FAIL only (one inspection); Phase 2 allows UNVERIFIED, which asks
// the same Actor for CLAIM/PROBE evidence leads and re-inspects in the same Verifier context. The
// Actor context stays resumable for learning after the wave barrier / the project.

import { join } from 'node:path'
import { writeJsonAtomic } from '../core/atomic.mjs'
import { pad3 } from '../core/ids.mjs'
import { safeName } from '../core/paths.mjs'
import { materializeView } from '../memory/view.mjs'
import { actorRuntimeContract, leadsRequest, practiceActorCharter, unverified } from '../prompts/roles.mjs'
import { BRANCH_RETRYABLE, InfraError, TransportInfraError, isInfraError } from '../runtime/errors.mjs'
import { moveAside } from '../workspace/copy.mjs'
import { captureTree, replayTree } from '../workspace/fixtures.mjs'
import { inspectPractice } from './inspect.mjs'
import { inventoryOf } from './learn.mjs'
import { EngineContext, specFor } from './roles.mjs'
import { actorContinuation, actorStall, journaledConverse, parseActorHandoff, parseEvidenceHandoff, transportPolicy } from './steps.mjs'

/** The EngineContext of a practice Actor `key` working on episode `ep` (also used for learning). */
export function practiceActorContext(j, run, key, ep) {
  const layout = run.layout
  return new EngineContext(j, key, async (phase, { sandboxOff } = {}) => specFor({
    role: 'actor',
    kind: 'practice',
    phase,
    key,
    root: layout.projectRoot(ep),
    memoryDir: layout.actorMemory(ep),
    W: layout.W,
    home: run.home,
    pluginRoot: run.pluginRoot,
    config: run.config,
    model: run.models.actor ?? null,
    isolation: run.isolation,
    logDir: join(run.lineageDir, 'ctx', safeName(key)),
    env: run.env,
    sandboxOff,
  }), { model: run.models.actor ?? null, role: 'actor', run })
}

function practiceVerifierContext(j, run, key, ep, phase, vk) {
  const layout = run.layout
  return new EngineContext(j, key, async (_phase, { sandboxOff } = {}) => specFor({
    role: 'verifier',
    kind: 'practice',
    phase: null,
    key,
    root: layout.verifyCandidate(ep),
    scratch: layout.verifyScratch(`${ep}-v${vk}`),
    original: phase === 2 ? layout.verifyOriginal(ep) : null,
    allowUnverified: phase === 2,
    W: layout.W,
    home: run.home,
    pluginRoot: run.pluginRoot,
    config: run.config,
    model: run.models.verifier ?? null,
    isolation: run.isolation,
    logDir: join(run.lineageDir, 'ctx', safeName(key)),
    env: run.env,
    sandboxOff,
  }), { model: run.models.verifier ?? null, role: 'verifier', run })
}

/**
 * One practice project attempt (SPEC §12.11 runProject). `opts` = { phase: 1|2, ep, episode,
 * instruction, fixturesCapture, memorySource, privBase, attempt, run, inventoryLimit }.
 * Returns BranchResult `{ ep, episode, verdict, report, reportSha, reports, actorKey, memoryDir,
 * instruction, generations }`.
 */
export async function runProject(j, K, { phase, ep, episode, instruction, fixturesCapture, memorySource, privBase, attempt = 1, run } = {}) {
  const layout = run.layout
  const root = layout.projectRoot(ep)
  const memoryDir = layout.actorMemory(ep)
  const verdictEvent = phase === 2 ? 'PRACTICE_VERIFIED' : 'PROJECT_VERIFIED'
  // 1. Byte-exact fixtures and a read-only copy of the pre-project memory snapshot.
  const replay = await j.op(`${K}/replay`, 'replay', { ep, fixturesCapture, memorySource }, async () => {
    await replayTree(fixturesCapture, root)
    await materializeView(memorySource, memoryDir, { readOnly: true })
    return inventoryOf(memorySource, run.config.memory?.promptInventory ?? 40)
  })
  // 2. A fresh Actor works until a usable STATUS: SUBMIT handoff (shape gate on the root).
  const actorKey = `${K}/actor`
  const actor = practiceActorContext(j, run, actorKey, ep)
  await actor.open()
  const policy = transportPolicy(run.config)
  await journaledConverse(j, `${K}/work`, actor, {
    first: practiceActorCharter({ instruction, projectRoot: root, memoryDir, inventory: replay, empty: replay.empty })
      + actorRuntimeContract({ projectRoot: root, memoryDir }),
    parse: reply => parseActorHandoff(reply, root),
    continuation: actorContinuation,
    stallContinuation: actorStall,
    policy,
    who: 'Actor Agent',
  })
  await run.event(`${K}/ev:submitted`, 'PROJECT_SUBMITTED', { episode })
  // 3. Immutable capture of the submitted candidate.
  const captureDir = gen => join(privBase, `a${attempt}`, `candidate-g${pad3(gen)}`)
  await j.op(`${K}/capture:g1`, 'capture', { ep, gen: 1 }, async () => {
    const manifest = await captureTree(root, captureDir(1))
    return { files: Object.keys(manifest.files).length }
  })
  // 4. A fresh Verifier (Phase 1: PASS/FAIL, exactly one inspection; Phase 2: UNVERIFIED allowed).
  const verifier = practiceVerifierContext(j, run, `${K}/verifier`, ep, phase, 1)
  await verifier.open()
  const allowUnverified = phase === 2
  let gen = 1
  let r = await inspectPractice(j, `${K}/inspect:g1`, {
    verifierCtx: verifier, ep, gen, candidateCapture: captureDir(1), fixturesCapture, phase, instruction, leads: '', allowUnverified, run, episode,
  })
  const reports = [r.report]
  await run.event(`${K}/ev:verified:g1`, verdictEvent, phase === 2
    ? { p: episodeLabel(ep), generation: gen, verdict: r.verdict }
    : { episode, generation: gen, verdict: r.verdict, reportSha: r.reportSha })
  // 5. Phase 2: UNVERIFIED asks the same Actor for evidence leads (RSIAgent practice_evidence_recovery).
  let n = 0
  while (phase === 2 && r.verdict === 'UNVERIFIED') {
    n++
    if (n >= (run.config.exploration?.unverifiedRounds ?? 3) && !j.hasOverride(`${K}/unverified@${gen}`)) {
      // RSIAgent: a practice project without PASS/FAIL is infrastructure, never a learned outcome.
      throw new InfraError('unverified_exhausted', `${episode}: ${n} UNVERIFIED inspections without a terminal verdict`, { pausedAt: `${K}/unverified@${gen}` })
    }
    await j.op(`${K}/remat:g${gen}`, 'materialize', { ep, gen }, async () => {
      await materializeView(memorySource, memoryDir, { readOnly: true })
      return null
    })
    const h = await journaledConverse(j, `${K}/evidence:${gen}`, actor, {
      first: unverified({ report: r.report }) + leadsRequest({ interactive: false }),
      parse: reply => parseEvidenceHandoff(reply, root),
      continuation: actorContinuation,
      stallContinuation: actorStall,
      policy,
      who: 'Actor Agent',
    })
    const next = gen + 1
    await j.op(`${K}/capture:g${next}`, 'capture', { ep, gen: next }, async () => {
      const manifest = await captureTree(root, captureDir(next))
      return { files: Object.keys(manifest.files).length }
    })
    gen = next
    r = await inspectPractice(j, `${K}/inspect:g${gen}`, {
      verifierCtx: verifier, ep, gen, candidateCapture: captureDir(gen), fixturesCapture, phase, instruction, leads: h.value.leads, allowUnverified, run, episode,
      ownReports: reports.map((text, i) => ({ generation: i + 1, text })),
    })
    reports.push(r.report)
    await run.event(`${K}/ev:verified:g${gen}`, verdictEvent, { p: episodeLabel(ep), generation: gen, verdict: r.verdict })
  }
  return {
    ep, episode, verdict: r.verdict, report: r.report, reportSha: r.reportSha, reports, actorKey, memoryDir, instruction, generations: gen,
  }
}

/** The practice number of `p003` / `p003-a2` (PRACTICE_VERIFIED{p}, like PRACTICE_STARTED{p}). */
function episodeLabel(ep) {
  const m = /^p(\d+)/.exec(String(ep))
  return m ? Number.parseInt(m[1], 10) : String(ep)
}

/**
 * runProject with RSIAgent's unscored restart (SPEC §12.11 runProjectWithRetry): an InfraError of a
 * BRANCH_RETRYABLE class raised before the attempt's Verifier published a report archives the
 * attempt's project root under `<privBase>/infra_attempts/` with a retry receipt and restarts from
 * the same immutable fixtures as `<ep>-a<n>` with fresh contexts. Transport exhaustion and every
 * other class are rethrown (RSIAgent never retries boundary or liveness errors).
 */
export async function runProjectWithRetry(j, Kbase, opts = {}) {
  const run = opts.run
  const retries = run.config.exploration?.branchRetries ?? 1
  for (let a = 1; a <= retries + 1; a++) {
    const ep = a === 1 ? opts.ep : `${opts.ep}-a${a}`
    const K = `${Kbase}/a${a}`
    if (j.isDone(`${K}/abandon`)) {
      // Replay: the attempt was abandoned; its restart event is idempotent by key.
      await run.event(`${K}/ev:restarted`, 'PROJECT_RESTARTED_UNSCORED', { episode: opts.episode, attempt: a + 1, cls: j.result(`${K}/abandon`)?.cls ?? null })
      continue
    }
    try {
      return await runProject(j, K, { ...opts, ep, attempt: a })
    } catch (error) {
      const retryable = isInfraError(error) && !(error instanceof TransportInfraError) && BRANCH_RETRYABLE.has(error.cls)
      const published = j.isDone(`${K}/inspect:g1/post`)
      if (!retryable || published || a > retries) throw error
      await j.op(`${K}/abandon`, 'abandon-attempt', { ep, attempt: a }, async () => {
        const moved = await moveAside(run.layout.projectRoot(ep), join(opts.privBase, 'infra_attempts'))
        const receipt = {
          mode: 'restart_unscored_branch_from_immutable_fixtures',
          priorMemoryPromoted: false,
          cls: error.cls,
          detail: error.detail,
          attempt: a,
          moved,
          maximumRetries: retries,
        }
        await writeJsonAtomic(join(opts.privBase, 'infra_attempts', `a${a}.retry_receipt.json`), receipt)
        return { moved, cls: error.cls }
      })
      await run.event(`${K}/ev:restarted`, 'PROJECT_RESTARTED_UNSCORED', { episode: opts.episode, attempt: a + 1, cls: error.cls })
    }
  }
  throw new InfraError('branch_retries_exhausted', `${opts.episode}: every attempt was abandoned`)
}

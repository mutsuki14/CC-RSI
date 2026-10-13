// Target attempt (SPEC §12.9): RSIAgent `run_with_resume` with the Phase-2 rules, shared by deep
// (Phase 2) and frozen (Phase 3) lineages; port of dsh-rsi lineage.ts:515-645 `runTargetAttempt`.
//
// A fresh Actor works on the live target root with a read-only memory snapshot. One Verifier
// context per identity persists through the attempt. PASS is terminal; a Phase-2 FAIL is terminal
// (verifier_failure_starts_evolution) while a Phase-3 FAIL goes back to the SAME Actor for repair
// (RSIAgent baseline.yaml). UNVERIFIED asks the same Actor for CLAIM/PROBE leads; only the LEAD
// blocks reach the Verifier. A stall (the Actor's transport exhaustion, or exhausted UNVERIFIED /
// repair rounds) buys exactly one forced inspection; when that is still unresolved, a fresh Actor
// resumes on the same root with a synthesized work log (handoff when the root changed, strategy
// pivot when it did not), optionally on the escalation model with the asymmetric Verifier swap:
// the new Verifier takes the ORIGINAL Actor model and gets no history and no prior reports by
// default (J1-10). A Verifier FAIL never triggers a fresh-context pivot; Verifier transport
// exhaustion is not a stall but a pause.

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { exists, writeFileAtomic } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { safeName } from '../core/paths.mjs'
import { materializeView } from '../memory/view.mjs'
import { disagreement, leadsRequest, resumeOpening, targetActorOpening, unverified, verifierSystem } from '../prompts/roles.mjs'
import { PROJECT_ROOT_TOKEN } from '../protocol/wave.mjs'
import { TransportInfraError } from '../runtime/errors.mjs'
import { effective } from '../runtime/models.mjs'
import { removeTree } from '../workspace/copy.mjs'
import { manifestDelta, projectManifest } from '../workspace/fingerprint.mjs'
import { replayTree } from '../workspace/fixtures.mjs'
import { inspectTarget } from './inspect.mjs'
import { inventoryOf, learnOp, snapshotCanonical } from './learn.mjs'
import { EngineContext, specFor } from './roles.mjs'
import { actorContinuation, actorStall, journaledConverse, parseActorHandoff, parseEvidenceHandoff, transportPolicy } from './steps.mjs'
import { strategyReview, synthesizeWorklog, worklogMessages } from './worklog.mjs'

/** A semantic stall of the target Actor (never a pause): one forced inspection follows. */
class Stall extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'Stall'
    this.reason = reason
  }
}

function sameManifest(a, b) {
  const d = manifestDelta(a, b)
  return d.created.length === 0 && d.modified.length === 0 && d.deleted.length === 0
}

function targetActorContext(j, run, key, { T, kind, model, targetText }) {
  const layout = run.layout
  return new EngineContext(j, key, async (phase, { sandboxOff } = {}) => specFor({
    role: 'actor',
    kind,
    phase,
    key,
    root: layout.projectRoot(T),
    memoryDir: layout.actorMemory(T),
    target: targetText,
    W: layout.W,
    home: run.home,
    pluginRoot: run.pluginRoot,
    config: run.config,
    model,
    isolation: run.isolation,
    logDir: join(run.lineageDir, 'ctx', safeName(key)),
    env: run.env,
    sandboxOff,
  }), { model, role: 'actor', run })
}

function targetVerifier(j, run, { T, model, vk }) {
  const layout = run.layout
  const system = verifierSystem({ location: 'live', sandbox: run.isolation?.mode === 'sandbox', allowUnverified: true })
  const vid = `${safeName(effective(model))}-${sha256Hex(system).slice(0, 8)}`
  const key = `${T}/verifier@${vid}`
  const scratch = layout.verifyScratch(`${T}-v${vk}`)
  const ctx = new EngineContext(j, key, async (_phase, { sandboxOff } = {}) => specFor({
    role: 'verifier',
    kind: 'target',
    phase: null,
    key,
    root: layout.projectRoot(T),
    scratch,
    allowUnverified: true,
    W: layout.W,
    home: run.home,
    pluginRoot: run.pluginRoot,
    config: run.config,
    model,
    isolation: run.isolation,
    logDir: join(run.lineageDir, 'ctx', safeName(key)),
    env: run.env,
    sandboxOff,
  }), { model, role: 'verifier', run })
  return { ctx, key, scratch, vk, lastGen: null, handover: null, reports: [] }
}

/**
 * One target attempt `T` (e.g. 't001'). Options: `{ lineage, store, frozen, run }` (`ctx` is
 * accepted as an alias of `run`). Returns `{ verdict, report, reportSha, diagnosis, root, learnable }`.
 */
export async function targetAttempt(j, T, { lineage, store, frozen = false, run, ctx } = {}) {
  run = run ?? ctx
  lineage = lineage ?? run.lineage
  store = store ?? run.store
  const layout = run.layout
  const exploration = run.config.exploration ?? {}
  const root = layout.projectRoot(T)
  const memoryDir = layout.actorMemory(T)
  const snapshotDir = join(layout.priv, T, 'memory_snapshot')
  const target = lineage.target.text
  const targetText = String(target).split(PROJECT_ROOT_TOKEN).join(root)
  const cycle = Number.parseInt(T.slice(1), 10)
  const kind = frozen ? 'frozen' : 'target'

  // Fresh target root from the immutable fixtures; memory snapshot (frozen: the frozen tree).
  const init = await j.op(`${T}/init`, 'target-init', { T, frozen }, async () => {
    const fixtures = join(layout.priv, 'target-fixtures')
    if (lineage.target?.fixturesCaptured && (await exists(join(fixtures, 'manifest.json')))) {
      await replayTree(fixtures, root)
    } else {
      await removeTree(root)
      await mkdir(root, { recursive: true, mode: 0o700 })
    }
    const snapshotTree = await snapshotCanonical(store, snapshotDir)
    if (frozen) await store.assertFrozenIntact()
    await materializeView(snapshotDir, memoryDir, { readOnly: true })
    return {
      before: await projectManifest(root),
      snapshotTree,
      inventory: await inventoryOf(snapshotDir, run.config.memory?.promptInventory ?? 40),
    }
  })
  await run.event(`${T}/ev:started`, 'TARGET_STARTED', { cycle })

  const policy = transportPolicy(run.config)
  const crossModelVerifier = run.models.escalation != null && effective(run.models.escalation) === effective(run.models.verifier)
  let actorModel = run.models.actor ?? null
  let verifierModel = run.models.verifier ?? null
  let swapped = false
  let resumes = 0
  let gen = 0
  let vkNext = 1
  const worklog = []
  const reports = []
  let verifier = targetVerifier(j, run, { T, model: verifierModel, vk: vkNext++ })
  await verifier.ctx.open()

  const actorConverse = async (actor, prefix, first, parse) => {
    try {
      return await journaledConverse(j, prefix, actor, { first, parse, continuation: actorContinuation, stallContinuation: actorStall, policy, who: 'Actor Agent' })
    } catch (error) {
      if (error instanceof TransportInfraError) throw new Stall(error.detail)
      throw error
    }
  }
  const inspect = async (g, leads, forced) => {
    const handover = verifier.handover
    const r = await inspectTarget(j, `${T}/g${g}`, {
      verifierCtx: verifier.ctx,
      attempt: T,
      gen: g,
      root,
      actorMemoryDir: memoryDir,
      snapshotDir,
      before: init.before,
      prevGen: verifier.lastGen,
      leads,
      forced,
      run,
      scratch: verifier.scratch,
      task: target,
      priorReports: handover ?? [],
      handover: handover && handover.length > 0 ? 'other-verifier' : null,
      ownReports: verifier.reports.slice(),
    })
    verifier.handover = null
    verifier.lastGen = g
    verifier.reports.push({ generation: g, text: r.report })
    reports.push({ generation: g, text: r.report })
    worklog.push(`VERIFIER REPORT (generation ${g}):\n${r.report}`)
    await run.event(`${T}/g${g}/ev:verified`, 'TARGET_VERIFIED', { cycle, generation: g, verdict: r.verdict, reportSha: r.reportSha, forced })
    return r
  }

  let terminal = null
  let resumeText = null
  for (let s = 0; ; s++) {
    const actor = targetActorContext(j, run, `${T}/actor@${s}`, { T, kind, model: actorModel, targetText })
    await actor.open()
    const opening = s === 0
      ? targetActorOpening({ target, projectRoot: root, memoryDir, inventory: init.inventory, empty: init.inventory.empty, frozen })
      : resumeText
    let unverifiedRounds = 0
    let repairs = 0
    let leads = ''
    let stall = null
    try {
      const h = await actorConverse(actor, `${T}/s${s}/work`, opening, reply => parseActorHandoff(reply, root))
      worklog.push(`HANDOFF:\n${h.value.body}`)
      for (;;) {
        gen++
        const r = await inspect(gen, leads, false)
        if (r.verdict === 'PASS') {
          terminal = { ...r, actor }
          break
        }
        if (r.verdict === 'FAIL') {
          if (!frozen) {
            terminal = { ...r, actor }
            break
          }
          // Phase 3 (RSIAgent baseline.yaml): FAIL → the same Actor repairs; a semantic stall, never a pause.
          if (++repairs >= (exploration.frozenRepairRounds ?? 8)) throw new Stall(`${repairs} repair rounds without a PASS`)
          const repair = await actorConverse(actor, `${T}/s${s}/repair:${gen}`,
            disagreement({ report: r.report, memoryDir, memoryNonEmpty: !init.inventory.empty }), reply => parseActorHandoff(reply, root))
          worklog.push(`HANDOFF:\n${repair.value.body}`)
          leads = ''
          continue
        }
        // UNVERIFIED (RSIAgent max_consec_done): repeated unconfirmed submissions stall the attempt.
        if (++unverifiedRounds >= (exploration.unverifiedRounds ?? 3)) throw new Stall(`${unverifiedRounds} consecutive UNVERIFIED rounds`)
        const evidence = await actorConverse(actor, `${T}/s${s}/evidence:${gen}`,
          unverified({ report: r.report }) + leadsRequest({ interactive: false }), reply => parseEvidenceHandoff(reply, root))
        worklog.push(`HANDOFF:\n${evidence.value.body}`)
        leads = evidence.value.leads
      }
    } catch (error) {
      if (!(error instanceof Stall)) throw error
      stall = error
    }
    if (terminal) break

    // Stall exit: exactly one forced inspection of the live candidate.
    await run.event(`${T}/ev:stalled:${s}`, 'TARGET_STALLED', { cycle, reason: stall.reason })
    gen++
    const forced = await inspect(gen, '', true)
    if (forced.verdict === 'PASS' || (forced.verdict === 'FAIL' && !frozen)) {
      terminal = { ...forced, actor } // learned by the SAME held Actor
      break
    }
    if (resumes < (exploration.targetResumes ?? 1)) {
      const n = resumes + 1
      const plan = await j.op(`${T}/resume:${n}/plan`, 'resume-plan', { T, n }, async () => ({
        changed: !sameManifest(init.before, await projectManifest(root)),
      }))
      const worklogText = await synthesizeWorklog(j, `${T}/resume:${n}`, { actorCtxLogDir: actor.logDir, digest: worklog, run })
      let review = ''
      if (!plan.changed) {
        const collected = await worklogMessages(j, `${T}/resume:${n}`, { actorCtxLogDir: actor.logDir })
        review = await strategyReview(j, `${T}/resume:${n}/review`, { worklogText, tail: collected.tail, run })
      }
      await j.op(`${T}/resume:${n}/record`, 'worklog-record', { T, n }, async () => {
        await writeFileAtomic(join(layout.priv, T, 'worklog.md'), `${worklogText}\n${review ? `\nSELF-REVIEW:\n${review}\n` : ''}`)
        return null
      })
      resumeText = resumeOpening({ changed: plan.changed, worklog: worklogText, review, target, projectRoot: root, memoryDir })
      const escalate = run.models.escalation != null && effective(run.models.escalation) !== effective(actorModel)
      let verifierSwapped = false
      if (escalate) {
        if (crossModelVerifier && !swapped) {
          // Two different models must still agree: the ORIGINAL Actor model takes the Verifier seat.
          verifierModel = run.models.actor ?? null
          swapped = true
          verifierSwapped = true
          verifier = targetVerifier(j, run, { T, model: verifierModel, vk: vkNext++ })
          await verifier.ctx.open()
          // RSIAgent hands over nothing; exploration.escalationHandoverReports opts in.
          if (exploration.escalationHandoverReports === true) verifier.handover = reports.slice()
        }
        actorModel = run.models.escalation
      }
      resumes++
      await run.event(`${T}/ev:resumed:${resumes}`, 'TARGET_RESUMED', {
        cycle, resume: resumes, mode: plan.changed ? 'handoff' : 'pivot', escalated: escalate, verifierSwapped,
      })
      continue
    }
    return { verdict: forced.verdict, report: forced.report, reportSha: forced.reportSha, diagnosis: '', root, learnable: false }
  }

  let diagnosisText = ''
  if (!frozen) {
    const L = await learnOp(j, `${T}/learn`, terminal.actor, {
      store, episode: `${lineage.id}-${T}`, kind: 'target', outcome: terminal.verdict, report: terminal.report, memoryDir, diagnosis: true, lineage, run,
    })
    diagnosisText = L.diagnosisText ?? ''
    await run.event(`${T}/ev:learned`, 'TARGET_LEARNING_COMPLETED', { cycle, verdict: terminal.verdict, treeAfter: L.record.treeAfter })
  }
  return { verdict: terminal.verdict, report: terminal.report, reportSha: terminal.reportSha, diagnosis: diagnosisText, root, learnable: !frozen }
}

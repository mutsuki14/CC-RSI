// Phase 1 — broad waves (SPEC §12.12; RSIAgent `evolve_parallel_phase1` explore/phase1_wave.py,
// dsh-rsi lineage.ts:395-513 `runBroadExploration`).
//
// One persistent Curriculum context authors waves of independent projects with their fixture
// trees. Every branch of a wave starts from the same pre-wave memory snapshot and runs in parallel
// (bounded by waveConcurrency). The wave is a barrier: when any branch fails, nothing of the wave is
// learned. After the complete wave, the SAME branch Actor contexts distill serially, in the order
// the Curriculum authored them, each against the latest canonical memory. Termination: SATURATED
// or STALLED from the Curriculum, or the complete-project budget (checked between waves only; a wave
// may overshoot it, RSIAgent PRO §5).

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, readJsonSafe, writeFileAtomic, writeJsonAtomic } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { pad3 } from '../core/ids.mjs'
import { safeName } from '../core/paths.mjs'
import { MemoryQuarantineError } from '../memory/errors.mjs'
import { materializeView } from '../memory/view.mjs'
import {
  curriculumRuntimeContract, outcomeText, phase1RecoveryNotice, stallContinuation, waveCharter, waveContinuation, waveOutcomes,
} from '../prompts/roles.mjs'
import { fail, ok } from '../protocol/tokens.mjs'
import { parseWave } from '../protocol/wave.mjs'
import { InterruptedError, isInfraError, TransportInfraError } from '../runtime/errors.mjs'
import { moveAside, removeTree } from '../workspace/copy.mjs'
import { captureTree, shapeGate } from '../workspace/fixtures.mjs'
import { learnOp, snapshotCanonical } from './learn.mjs'
import { practiceActorContext, runProjectWithRetry } from './project.mjs'
import { countInfraPauses, resultRecord } from './records.mjs'
import { EngineContext, specFor } from './roles.mjs'
import { journaledConverse, transportPolicy } from './steps.mjs'

const AUDIT_FILE_LIMIT = 2 ** 20

/** Runs `run(item, index)` over `items` with at most `width` in flight; settles every item (dsh pool). */
export async function pool(items, width, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker))
  return results
}

/**
 * The error a blocked wave rethrows (SPEC §12.12 BARRIER): quarantine > user stop > transport
 * liveness > other infra > anything else, the first of its rank in authored order.
 */
export function preferredError(errors) {
  const rank = error => {
    if (error instanceof MemoryQuarantineError) return 0
    if (error instanceof InterruptedError) return 1
    if (error instanceof TransportInfraError) return 2
    if (isInfraError(error)) return 3
    return 4
  }
  return [...errors].sort((a, b) => rank(a) - rank(b))[0]
}

/** The Curriculum context of a lineage (one per lineage; RSIAgent persistent Curriculum). */
export function curriculumContext(j, run, { onContextLost } = {}) {
  const layout = run.layout
  const memoryDir = run.config.exploration?.curriculumMemoryAccess === 'none' ? null : layout.curriculumMemory
  return new EngineContext(j, 'cur', async (phase, { sandboxOff } = {}) => specFor({
    role: 'curriculum',
    phase: null,
    key: 'cur',
    cwd: layout.curriculum,
    memoryDir,
    W: layout.W,
    home: run.home,
    pluginRoot: run.pluginRoot,
    config: run.config,
    model: run.models.curriculum ?? null,
    isolation: run.isolation,
    logDir: join(run.lineageDir, 'ctx', safeName('cur')),
    env: run.env,
    sandboxOff,
  }), { model: run.models.curriculum ?? null, role: 'curriculum', run, onContextLost })
}

/**
 * Refreshes the Curriculum's read-only memory copy (or removes it for access 'none'), empties an
 * authoring root, and reads the private notes. Runs inside the caller's op.
 */
export async function prepareCurriculum(run, authoringRoot) {
  const layout = run.layout
  await run.store.assertCanonicalIntact()
  if (run.config.exploration?.curriculumMemoryAccess === 'none') await removeTree(layout.curriculumMemory)
  else await snapshotCanonical(run.store, layout.curriculumMemory, { readOnly: true })
  await removeTree(authoringRoot)
  await mkdir(authoringRoot, { recursive: true, mode: 0o700 })
  let notes = ''
  try {
    notes = await readFile(layout.notes, 'utf8')
  } catch {
    notes = ''
  }
  return { notes }
}

/** Every regular file text (≤ 1 MiB) and the relative names of a captured fixture tree, for the audit. */
export async function fixtureTexts(captureDir) {
  const manifest = await readJsonSafe(join(captureDir, 'manifest.json'), { files: {} })
  const texts = []
  const names = Object.keys(manifest.files ?? {})
  for (const rel of names) {
    if ((manifest.files[rel]?.bytes ?? 0) > AUDIT_FILE_LIMIT) continue
    try {
      texts.push(await readFile(join(captureDir, 'tree', rel), 'utf8'))
    } catch {
      // vanished: nothing to audit
    }
  }
  if (names.length > 0) texts.push(names.join('\n'))
  return texts
}

/**
 * Silent audit of Curriculum material (SPEC §12.12 op W/audit; PF §8.6): the handoff text, the
 * private notes (also copied to priv/curriculum/notes.md) and every captured fixture. Returns
 * `{hit, notesSha}`; the caller throws a quarantine on a hit (the reason never reaches a role).
 */
export async function auditCurriculum(run, { surface, episode, text, captures = [] }) {
  const layout = run.layout
  let notes = ''
  try {
    notes = await readFile(layout.notes, 'utf8')
  } catch {
    notes = ''
  }
  if (notes !== '') await writeFileAtomic(join(layout.priv, 'curriculum', 'notes.md'), notes)
  const texts = [String(text ?? ''), notes]
  for (const dir of captures) texts.push(...(await fixtureTexts(dir)))
  const hit = await run.store.auditTexts(texts, { surface, lineage: run.lineage.id, episode })
  return { hit, notesSha: sha256Hex(notes) }
}

/**
 * Phase 1 (SPEC §12.12). Returns `{ termination, rationale }` after the `final` op wrote result.json.
 */
export async function runBroad(run) {
  const { j, lineage, layout, store } = run
  const exploration = run.config.exploration ?? {}
  const init = await j.op('init', 'init', { phase: 'broad' }, async () => {
    await store.assertCanonicalIntact()
    return { memoryTree: await store.treeHash() }
  })
  await run.event('init/ev:started', 'LINEAGE_STARTED', { phase: 'broad', memoryTree: init.memoryTree, isolation: lineage.isolation })

  const direction = lineage.targetConditioned ? lineage.target?.text : lineage.direction?.text
  const memoryDir = exploration.curriculumMemoryAccess === 'none' ? null : layout.curriculumMemory
  const authoringRoot = layout.authoring
  // A Curriculum transcript lost at a completed wave boundary restarts with the full charter plus
  // RSIAgent's completed-boundary notice (practice_loop.py:1355-1364); anywhere else it pauses.
  let boundaryMessage = null
  const cur = curriculumContext(j, run, { onContextLost: message => (message === boundaryMessage ? `${message}${phase1RecoveryNotice()}` : null) })
  await cur.open()
  const policy = transportPolicy(run.config)
  // Branch records live under priv/<W>/projects/<id> (dsh-rsi lineage.ts:397): no Curriculum-chosen
  // id can collide with the wave's memory_snapshot, decision.json or leftover archive.
  const privOf = (W, id) => join(layout.priv, W, 'projects', id)
  const fixturesOf = (W, id) => join(privOf(W, id), 'fixtures')
  const projects = []
  let priorWave = ''
  let wavesCompleted = 0

  const finish = async (termination, rationale) => {
    await run.event('ev:terminated', 'PHASE1_TERMINATED', { termination })
    const result = await j.op('final', 'final', { termination }, async () => {
      const record = resultRecord(lineage, {
        termination,
        rationale,
        waves: wavesCompleted,
        projects,
        finalTree: await store.treeHash(),
        initialTree: init.memoryTree,
        costUsd: run.costUsd(),
        infraPauses: await countInfraPauses(run.lineageDir),
        learningAfterSealed: (await store.sealed())?.learningAfterSealed === true,
      })
      await run.complete(record)
      return { termination }
    })
    return { termination: result.termination, rationale }
  }

  for (let n = 1; ; n++) {
    const W = `w${pad3(n)}`
    run.setCounters({ wave: n })
    const budget = exploration.broadProjectBudget ?? 12
    if (projects.length >= budget) return finish('budget_exhausted', 'complete-project budget reached at a wave boundary')
    if ((exploration.maxCostUsd ?? 0) > 0 && run.costUsd() >= exploration.maxCostUsd) return finish('budget_exhausted', 'cost ceiling reached at a wave boundary')
    const prep = await j.op(`${W}/prep`, 'prep', { wave: n }, () => prepareCurriculum(run, authoringRoot))
    const charter = waveCharter({ direction, targetConditioned: lineage.targetConditioned === true, priorWave, authoringRoot, memoryDir, notes: prep.notes })
      + curriculumRuntimeContract({ cwd: layout.curriculum, authoringRoot, notesFile: layout.notes })
    boundaryMessage = charter
    // The parse validates the wave against the authoring tree AND captures every declared fixture
    // tree in the same op, so a recorded valid wave always has its immutable captures (J2-5).
    const d = await journaledConverse(j, `${W}/cur`, cur, {
      first: charter,
      parse: async reply => {
        const parsed = parseWave(String(reply?.text ?? ''), { ceiling: exploration.waveCeiling ?? 16 })
        if (!parsed.ok) return parsed
        const wave = parsed.value
        if (wave.decision !== 'WAVE') return ok({ ...wave, text: reply.text })
        const ids = new Set(wave.projects.map(p => p.id))
        for (const project of wave.projects) {
          const problem = await shapeGate(join(authoringRoot, project.id))
          if (problem) return fail(`the fixture tree for project "${project.id}" is not replayable: ${problem}`)
        }
        let entries = []
        try {
          entries = await readdir(authoringRoot)
        } catch {
          entries = []
        }
        const extra = entries.filter(name => !ids.has(name)).sort()
        if (extra.length > 0) return fail(`${authoringRoot} holds entries that are not projects of this wave (${extra.join(', ')}); remove them or declare them`)
        for (const project of wave.projects) {
          try {
            await captureTree(join(authoringRoot, project.id), fixturesOf(W, project.id))
          } catch (error) {
            if (typeof error?.code !== 'string' || !error.code.startsWith('capture_')) throw error
            return fail(`the fixture tree for project "${project.id}" could not be captured: ${error.message}`)
          }
        }
        return ok({ ...wave, text: reply.text })
      },
      continuation: detail => waveContinuation({ detail, authoringRoot }),
      stallContinuation: () => stallContinuation({ role: 'CURRICULUM' }),
      policy,
      who: 'Curriculum Agent',
    })
    boundaryMessage = null
    const wave = d.value
    const captures = wave.projects.map(p => fixturesOf(W, p.id))
    const audit = await j.op(`${W}/audit`, 'audit', { wave: n }, () => auditCurriculum(run, { surface: 'wave', episode: W, text: wave.text, captures }))
    if (audit.hit) throw new MemoryQuarantineError({ lineage: lineage.id, surface: 'wave' })
    if (wave.decision !== 'WAVE') {
      await j.op(`${W}/leftover`, 'leftover', { wave: n }, async () => {
        const moved = await moveAside(authoringRoot, join(layout.priv, W), 'leftover_')
        return { moved }
      })
      return finish(wave.decision === 'SATURATED' ? 'saturated' : 'stalled', wave.rationale)
    }
    const ids = wave.projects.map(p => p.id)
    await run.event(`${W}/ev:authored`, 'WAVE_AUTHORED', { wave: n, ids, rationaleSha: sha256Hex(wave.rationale) })
    const snapshot = join(layout.priv, W, 'memory_snapshot')
    await j.op(`${W}/capture`, 'capture', { wave: n, ids }, async () => {
      const snapshotTree = await snapshotCanonical(store, snapshot)
      for (const [i, project] of wave.projects.entries()) {
        if (!(await exists(join(captures[i], 'manifest.json')))) await captureTree(join(authoringRoot, project.id), captures[i])
      }
      await removeTree(authoringRoot)
      await mkdir(authoringRoot, { recursive: true, mode: 0o700 })
      // Every branch's directories exist before any branch spawns, so each role's hidden roots
      // (computed at spawn time) already cover its siblings (SPEC §4.3, §16 item 11).
      for (const project of wave.projects) {
        await mkdir(layout.projectRoot(`${W}-${project.id}`), { recursive: true, mode: 0o700 })
        await mkdir(join(layout.actorPrivate, `${W}-${project.id}`), { recursive: true, mode: 0o700 })
      }
      await writeJsonAtomic(join(layout.priv, W, 'decision.json'), { wave: n, decision: wave.decision, rationale: wave.rationale, projects: wave.projects })
      return { snapshotTree }
    })
    await run.event(`${W}/ev:captured`, 'WAVE_FIXTURES_CAPTURED', { wave: n, ids })

    // Parallel branches from the same snapshot; the barrier settles every branch.
    const settled = await pool(wave.projects, exploration.waveConcurrency ?? 2, (project, i) => runProjectWithRetry(j, `${W}/b:${project.id}`, {
      phase: 1,
      ep: `${W}-${project.id}`,
      episode: `${lineage.id}-${W}-${project.id}`,
      instruction: project.instruction,
      fixturesCapture: captures[i],
      memorySource: snapshot,
      privBase: privOf(W, project.id),
      run,
    }))
    const failed = settled.map((r, i) => ({ r, id: ids[i] })).filter(x => x.r.status === 'rejected')
    if (failed.length > 0) {
      const list = failed.map(x => ({ pid: x.id, cls: x.r.reason?.cls ?? (x.r.reason instanceof MemoryQuarantineError ? 'quarantined' : 'error') }))
      await run.event(`${W}/ev:blocked:${sha256Hex(JSON.stringify(list)).slice(0, 12)}`, 'WAVE_BLOCKED', { wave: n, failed: list })
      throw preferredError(failed.map(x => x.r.reason))
    }

    // Serial consolidation in authored order, each on the LATEST canonical memory.
    const outcomes = []
    for (const [i, project] of wave.projects.entries()) {
      const b = settled[i].value
      const actor = practiceActorContext(j, run, b.actorKey, b.ep)
      const L = await learnOp(j, `${W}/learn:${project.id}`, actor, {
        store, episode: b.episode, kind: 'practice', outcome: b.verdict, report: b.report, memoryDir: b.memoryDir, diagnosis: false, lineage, run,
      })
      outcomes.push(outcomeText({
        label: `PROJECT ${n}.${i + 1} (${project.id})`,
        instruction: project.instruction,
        verdict: b.verdict,
        reports: [b.report],
        memoryChanges: { ...L.record, unchanged: L.unchanged },
      }))
      projects.push({
        id: project.id, wave: n, episode: b.episode, instructionSha256: sha256Hex(project.instruction), verdict: b.verdict, reportSha: b.reportSha, commit: L.record,
      })
      run.setCounters({ projectsDone: projects.length })
    }
    wavesCompleted = n
    await run.event(`${W}/ev:completed`, 'WAVE_COMPLETED', { wave: n, projects: ids.length, memoryTree: await currentTree(store) })
    priorWave = waveOutcomes({ wave: n, rationale: wave.rationale, outcomes })
  }
}

async function currentTree(store) {
  try {
    return await store.treeHash()
  } catch {
    return null
  }
}

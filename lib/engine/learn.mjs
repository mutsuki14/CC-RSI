// Learning in lineages (SPEC §12.8; RSIAgent `_promote_learning` / `_commit_branch_memory`,
// dsh-rsi src/engine/steps.ts:199-262 `learn`).
//
// The SAME Actor context that did the work distills into a draft opened from the CURRENT
// canonical memory (RSIAgent's re-push), reconciles the whole corpus, optionally writes its
// diagnosis for the Curriculum, and only then does the harness promote the draft atomically.
// Over-limit drafts go back to the same Actor to condense; a conflicting draft is rebased (the
// previous draft is kept beside the current memory) and the Actor re-applies its changes. Commit
// outcomes `limit` and `conflict` are recorded results, never throws (SPEC §12.1 rule 2).
// Infrastructure anywhere keeps the draft, so resume continues it; nothing is committed twice.

import { rename } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { exists } from '../core/atomic.mjs'
import { sortUtf8 } from '../core/digest.mjs'
import { MemoryConflictError, MemoryDraftMissingError, MemoryLimitError } from '../memory/errors.mjs'
import { formatInventory } from '../memory/inventory.mjs'
import { listTree, scanTree } from '../memory/tree.mjs'
import { materializeView } from '../memory/view.mjs'
import { conflict, diagnosis, distillation, limitCondense, reconciliation, transportContinuation } from '../prompts/roles.mjs'
import { fail, ok } from '../protocol/tokens.mjs'
import { InfraError } from '../runtime/errors.mjs'
import { freePhase, journaledConverse, transportPolicy } from './steps.mjs'

/** Commit attempts per learning phase before InfraError('commit_ceiling') (SPEC §12.8 step 6). */
export const COMMIT_ATTEMPTS = 4

/**
 * Copies canonical memory into `dest` (a writable or read-only snapshot) and returns its tree hash.
 * The copy must equal the journal's expected tree; a concurrent install (another process) is
 * retried, and a persistent mismatch is tamper (assertCanonicalIntact throws MemoryTamperError).
 */
export async function snapshotCanonical(store, dest, { readOnly = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await store.assertCanonicalIntact()
    const expected = await store.expectedTreeHash()
    const { treeSha256 } = await materializeView(store.memoryDir, dest, { readOnly })
    if (treeSha256 === expected) return treeSha256
  }
  await store.assertCanonicalIntact()
  throw new InfraError('memory_snapshot', `canonical memory kept changing while it was copied to ${dest}`)
}

/** `{ lines, omitted, empty }` inventory of a memory tree for an Actor opening (RSIAgent memory_preamble). */
export async function inventoryOf(dir, limit = 40) {
  let entries = []
  try {
    entries = await listTree(dir)
  } catch {
    entries = []
  }
  const files = entries.map(entry => ({ path: entry.rel, bytes: entry.bytes }))
  const { lines, omitted } = formatInventory(files, limit)
  return { lines, omitted, total: files.length, empty: files.length === 0 }
}

/**
 * Keeps an Actor's draft directory whose store record is gone as `<dir>.prev` (memory-crash-4/-5,
 * defence in depth for states older versions wrote): a canonical copy beside an existing `.prev`
 * leaves that `.prev` (the Actor's work) in place; otherwise an older `.prev` is moved aside under
 * a timestamped name, never deleted. "A canonical copy" is a tree equal to any canonical tree the
 * store journal ever recorded, not only the current one: a copy opened before a concurrent commit is
 * still a copy (r2-engine-3). Returns the `.prev` path.
 */
async function keepDraftAsPrev(store, memoryDir) {
  const prevDir = `${memoryDir}.prev`
  if (await exists(prevDir)) {
    let pristine = false
    try {
      const tree = (await scanTree(memoryDir)).treeSha256
      if (tree === (await store.treeHash())) pristine = true
      else pristine = (await store.journal()).some(record => record.treeAfter === tree || record.treeBefore === tree)
    } catch {
      pristine = false
    }
    if (pristine) return prevDir
    await rename(prevDir, `${prevDir}-${Date.now()}`)
  }
  await rename(memoryDir, prevDir)
  return prevDir
}

/**
 * The rebase after a refused commit (`${L}/rebase:k`), idempotent at every step so a crash anywhere
 * in it resumes correctly (r2-engine-3): a draft whose record exists is rebased by the store (which
 * keeps an existing `.prev` beside a still-pristine draft and finishes an interrupted rebase); a
 * draft whose record is gone has its directory kept as `.prev` and the current memory opened in its
 * place. Returns `{ prevDir }`; throws MemoryDraftMissingError when no Actor work is left anywhere.
 */
export async function rebaseOrRepair(store, episode, memoryDir, owner) {
  const prevDir = `${memoryDir}.prev`
  const meta = (await store.drafts()).find(d => d.episode === episode)
  if (meta && (meta.rebasing || meta.dirExists)) return { prevDir: (await store.rebaseDraft(episode)).prevDir }
  if (!meta && (await exists(memoryDir))) await keepDraftAsPrev(store, memoryDir)
  if (!(await exists(prevDir))) throw new MemoryDraftMissingError({ episode })
  await store.openDraft(episode, { dir: memoryDir, fresh: false, owner })
  return { prevDir }
}

/**
 * The same-Actor learning phase (SPEC §12.8). Returns `{ record, unchanged, diagnosisText }`.
 * `L` is the op prefix, `actorCtx` the EngineContext that did the work.
 */
export async function learnOp(j, L, actorCtx, { store, episode, kind, outcome, report, memoryDir, diagnosis: wantDiagnosis = false, lineage, run } = {}) {
  const limits = store.limits
  const owner = () => ({ kind: 'engine', pid: process.pid, host: hostname(), lineage: lineage.id })
  // 1. Draft of the CURRENT canonical memory in the Actor's memory path (RSIAgent re-push).
  await j.op(`${L}/open`, 'learn-open', { episode, memoryDir }, async () => {
    await store.assertCanonicalIntact()
    const draft = await store.openDraft(episode, {
      dir: memoryDir,
      fresh: true,
      owner: owner(),
    })
    return { baseHash: draft.baseHash }
  })
  actorCtx.setPhase('learn')
  // 2-3. Distill, then reconcile the whole corpus (free phases: any reply ends them).
  await freePhase(j, `${L}/distill`, actorCtx, distillation({ outcome, report, memoryDir, limits, owner: 'engine' }))
  await freePhase(j, `${L}/reconcile`, actorCtx, reconciliation({ memoryDir, owner: 'engine' }))
  // 4. Phase 2: the diagnosis goes to the Curriculum only (RSIAgent learning_diagnosis.md).
  let diagnosisText = null
  if (wantDiagnosis) {
    const d = await journaledConverse(j, `${L}/diagnosis`, actorCtx, {
      first: diagnosis({ outcome, report }),
      parse: reply => {
        const text = String(reply?.text ?? '').trim()
        return text === '' ? fail('the diagnosis was empty') : ok(text)
      },
      continuation: detail => transportContinuation({ role: 'ACTOR', detail }),
      policy: transportPolicy(run.config),
      who: 'Actor Agent diagnosis',
    })
    diagnosisText = d.value
  }
  // 5. Promote; limit → condense, conflict → rebase + re-apply, by the same Actor.
  let ceiling = COMMIT_ATTEMPTS
  for (let k = 1; ; k++) {
    if (k > ceiling) {
      const key = `${L}/commits@${ceiling}`
      if (j.hasOverride(key)) {
        ceiling += COMMIT_ATTEMPTS
      } else {
        throw new InfraError('commit_ceiling', `the learning phase of ${episode} could not be promoted after ${ceiling} attempts; the draft is kept`, { pausedAt: key })
      }
    }
    const result = await j.op(`${L}/commit:${k}`, 'commit', { episode, kind, outcome }, async () => {
      let names = []
      try {
        names = Object.keys((await scanTree(memoryDir)).files)
      } catch {
        names = []
      }
      try {
        const record = await store.commit(episode, { kind, outcome, lineage: lineage.id })
        if (names.length === 0 && Number.isInteger(record.seq)) {
          // The draft is already gone (an install finished before a crash): use the history snapshot.
          try {
            names = Object.keys((await scanTree(join(store.root, 'history', String(record.seq).padStart(4, '0')))).files)
          } catch {
            names = []
          }
        }
        const changed = new Set([...(record.created ?? []), ...(record.modified ?? [])])
        return { ok: true, record, unchanged: sortUtf8(names.filter(name => !changed.has(name))) }
      } catch (error) {
        if (error instanceof MemoryLimitError) return { ok: false, reason: 'limit', detail: error.detail }
        if (error instanceof MemoryConflictError) return { ok: false, reason: 'conflict' }
        // The draft's record is gone (a meta lost by an older version, or removed by hand): never
        // re-run the open op (it would wipe the Actor's work). The commit op stays free of side
        // effects (a crash inside a repair here would re-run this commit on the repaired state and
        // promote an untouched copy, r2-engine-3): the rebase op repairs, and the conflict path asks
        // the same Actor to re-apply its changes.
        if (error instanceof MemoryDraftMissingError && ((await exists(memoryDir)) || (await exists(`${memoryDir}.prev`)))) return { ok: false, reason: 'draft_missing' }
        throw error
      }
    })
    if (result.ok) {
      const r = result.record
      await run.event(`${L}/ev:committed`, 'MEMORY_COMMITTED', {
        episode, kind, outcome, treeBefore: r.treeBefore, treeAfter: r.treeAfter, created: r.created, modified: r.modified, deleted: r.deleted,
      })
      actorCtx.setPhase('work')
      return { record: r, unchanged: result.unchanged ?? [], diagnosisText }
    }
    if (result.reason === 'limit') {
      await freePhase(j, `${L}/condense:${k}`, actorCtx, limitCondense({ detail: result.detail, memoryDir, owner: 'engine', limits }))
      continue
    }
    const rebased = await j.op(`${L}/rebase:${k}`, 'rebase', { episode }, () => rebaseOrRepair(store, episode, memoryDir, owner()))
    await run.event(`${L}/ev:rebased:${k}`, 'MEMORY_CONFLICT_REBASED', { episode, k })
    await freePhase(j, `${L}/conflict:${k}`, actorCtx, conflict({ prevDir: rebased.prevDir, draftDir: memoryDir, owner: 'engine' }))
  }
}

// Protected inspections (SPEC §12.7; dsh-rsi lineage.ts:264-313 `protectedInspection`, RSIAgent
// fresh-VM replay for practice and rollback-protected live inspection for targets).
//
// The Actor's memory directory is removed before every inspection and re-materialized afterwards
// (J1-4), so the Verifier can never read Actor memory. Practice candidates are inspected as a
// fresh replay of the immutable capture at the Actor's own project root (the Actor's tree waits
// aside meanwhile), so `<PROJECT_ROOT>` names one path for both roles as in RSIAgent; target
// candidates are inspected live under a full checkpoint that is restored whenever the inspection
// changed the tree. The verdict is parsed by the harness from the Verifier's final message only.

import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readlink, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { exists, readJson, readJsonSafe, writeJsonAtomic } from '../core/atomic.mjs'
import { pad3 } from '../core/ids.mjs'
import { materializeView } from '../memory/view.mjs'
import { verifierCharter, verifierContinuation, verifierPracticeContext } from '../prompts/roles.mjs'
import { parseVerdict } from '../protocol/tokens.mjs'
import { PROJECT_ROOT_TOKEN } from '../protocol/wave.mjs'
import { InfraError } from '../runtime/errors.mjs'
import { roleTmpDir } from '../runtime/private.mjs'
import { copyTree, removeTree, sortPaths } from '../workspace/copy.mjs'
import { contentDelta, describeDelta, manifestDelta, projectManifest, treeFingerprint } from '../workspace/fingerprint.mjs'
import { captureTree, removeView, replayTree, stageReadOnlyView, verifyTree } from '../workspace/fixtures.mjs'
import { journaledConverse, transportPolicy } from './steps.mjs'

const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__'])
const HASH_LIMIT = 8 * 2 ** 20
const MANIFEST_LIMIT = 5000

function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * A content manifest `{files: {rel: {size, sha256} | {size, mtimeMs} | {link}}, truncated}` of a
 * candidate tree (byte order; `.git`, `node_modules`, `.venv`, `__pycache__` skipped like
 * projectManifest), for CHANGED SINCE YOUR LAST INSPECTION (PN §3.2) and rollback path lists.
 */
export async function contentManifest(root) {
  const files = []
  let truncated = false
  const visit = async (dir, rel) => {
    let names
    try {
      names = sortPaths(await readdir(dir))
    } catch {
      return
    }
    for (const name of names) {
      if (truncated) return
      const childRel = rel === '' ? name : `${rel}/${name}`
      const full = join(dir, name)
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (!SKIP.has(name)) await visit(full, childRel)
        continue
      }
      if (files.length >= MANIFEST_LIMIT) {
        truncated = true
        return
      }
      if (info.isSymbolicLink()) {
        let link = ''
        try { link = await readlink(full) } catch { link = '' }
        files.push([childRel, { link }])
      } else if (info.isFile()) {
        if (info.size <= HASH_LIMIT) {
          try {
            files.push([childRel, { size: info.size, sha256: await hashFile(full) }])
            continue
          } catch {
            // unreadable: fall back to size and time
          }
        }
        files.push([childRel, { size: info.size, mtimeMs: Math.trunc(info.mtimeMs * 1000) / 1000 }])
      }
    }
  }
  await visit(root, '')
  return { files: Object.fromEntries(files), truncated }
}

function changedPaths(delta, cap = 200) {
  return sortPaths([...delta.created, ...delta.modified, ...delta.deleted]).slice(0, cap)
}

/**
 * SPEC §10.9: when an established Verifier transcript is gone, a fresh context is seeded with the
 * Verifier's own prior reports. Only the charter (the first message of an inspection) can be
 * re-rendered; a lost context mid-inspection pauses as context_lost.
 */
function seedOnContextLoss(verifierCtx, first, charterArgs, ownReports) {
  if (typeof verifierCtx?.setContextLost !== 'function') return
  verifierCtx.setContextLost(message => {
    if (message !== first) return null
    const reports = [...(charterArgs.priorReports ?? []), ...(ownReports ?? [])]
    return verifierCharter({ ...charterArgs, priorReports: reports, handover: charterArgs.handover ?? (reports.length > 0 ? 'self' : null) })
  })
}

/** Fresh scratch for a Verifier context (with tmp/ = TMPDIR). */
async function freshScratch(scratch, { wipe }) {
  if (wipe) await removeTree(scratch)
  await mkdir(roleTmpDir(scratch), { recursive: true, mode: 0o700 })
}

async function inspectConverse(j, K, verifierCtx, first, allowUnverified, run) {
  return journaledConverse(j, `${K}/v`, verifierCtx, {
    first,
    parse: reply => parseVerdict(String(reply?.text ?? ''), { allowUnverified }),
    continuation: detail => verifierContinuation({ detail, allowUnverified }),
    stallContinuation: () => verifierContinuation({ detail: 'the harness resumed after a pause', allowUnverified }),
    policy: transportPolicy(run.config),
    who: 'Verifier Agent',
  })
}

const TRASH = '.trash-'

/** Removes the `<path>.trash-*` siblings an interrupted cross-filesystem move left behind. */
async function sweepTrash(path) {
  const dir = dirname(path)
  const prefix = `${basename(path)}${TRASH}`
  for (const name of await readdir(dir).catch(() => [])) {
    if (name.startsWith(prefix)) await removeTree(join(dir, name))
  }
}

/**
 * Renames `src` to `dest` (a missing parent of `dest` is created). Across filesystems the tree is
 * copied to `<dest>.tmp` and renamed into place; then `src` is renamed (atomically, on its own
 * filesystem) to a `<src>.trash-<n>` sibling and only that is removed (r2-engine-7). A repeated call
 * after a crash therefore finds either a complete `src` (nothing moved yet) or no `src` (the move is
 * done), never a half-deleted `src` beside a complete `dest`.
 */
async function moveTree(src, dest) {
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
  try {
    await rename(src, dest)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  const tmp = `${dest}.tmp`
  await removeTree(tmp)
  await copyTree(src, tmp, { verbatimSymlinks: true, preserveMode: true })
  await rename(tmp, dest)
  const trash = `${src}${TRASH}${process.pid}-${Date.now()}`
  await rename(src, trash)
  await removeTree(trash)
}

/**
 * Moves the Actor's own project tree `root` aside to `aside` before its capture is replayed at the
 * same absolute path (prompts-2: `<PROJECT_ROOT>` means one path for both roles, as in RSIAgent,
 * where every branch is replayed at the one guest project path). Idempotent: an existing `aside`
 * means an interrupted earlier call already moved the tree (whatever is at `root` then is a partial
 * replay). A missing `root` is reconstructed from `candidateCapture`, the Actor's own submission.
 */
async function setActorRootAside(root, aside, candidateCapture) {
  await sweepTrash(root)
  if (await exists(aside)) return
  if (await exists(root)) {
    await moveTree(root, aside)
    return
  }
  const tmp = `${aside}.tmp`
  await replayTree(candidateCapture, tmp)
  await rename(tmp, aside)
}

/**
 * Puts the Actor's own tree back at `root` after a practice inspection (the replay and every
 * Verifier effect on it are discarded). Idempotent: without `aside` the tree is already back.
 * Also used when an attempt is abandoned while its tree was aside (project.mjs).
 */
export async function restoreActorRoot(root, aside) {
  await sweepTrash(aside)
  if (!(await exists(aside))) return false
  await removeTree(root)
  await moveTree(aside, root)
  return true
}

/**
 * Practice inspection by replay (SPEC §12.7; Phase-1 branch and Phase-2 practice). The immutable
 * capture is replayed at the Actor's own project root (`<W>/projects/<ep>`) while the Actor's tree
 * waits at `actorAside` (default `<candidateCapture>-actor-root`, under the lineage's private
 * records); op `${K}/restore` puts it back. Returns `{ verdict, report, reportSha }`.
 */
export async function inspectPractice(j, K, {
  verifierCtx, ep, gen, candidateCapture, fixturesCapture, phase, instruction, leads = '', allowUnverified, run, episode, vk = 1, ownReports = [],
  actorAside,
} = {}) {
  const layout = run.layout
  const candidate = layout.projectRoot(ep)
  const aside = actorAside ?? `${candidateCapture}-actor-root`
  const original = phase === 2 ? layout.verifyOriginal(ep) : null
  const scratch = layout.verifyScratch(`${ep}-v${vk}`)
  // 1. Actor memory gone (J1-4); the Actor's tree aside and a fresh replay of the immutable capture
  // at the same path; fresh scratch; original view.
  const pre = await j.op(`${K}/pre`, 'inspect-pre', { ep, gen, phase }, async () => {
    await removeTree(layout.actorMemory(ep))
    await setActorRootAside(candidate, aside, candidateCapture)
    await replayTree(candidateCapture, candidate)
    await freshScratch(scratch, { wipe: true })
    if (original) await stageReadOnlyView(fixturesCapture, original)
    const fixturesManifest = await readJson(join(fixturesCapture, 'manifest.json'), {})
    const candidateManifest = await readJson(join(candidateCapture, 'manifest.json'), {})
    return {
      fp: await treeFingerprint(candidate),
      delta: describeDelta(manifestDelta(fixturesManifest, candidateManifest), { header: 'between the supplied project fixtures and the submitted candidate' }),
    }
  })
  // 2-3. The charter carries only harness material: task, mechanical facts, LEAD blocks.
  const task = String(instruction).split(PROJECT_ROOT_TOKEN).join(candidate)
  const mechanical = `${verifierPracticeContext({ phase, evidenceRound: gen > 1 })}\n\n${pre.delta}`
  const charterArgs = {
    generation: gen,
    task,
    candidateRoot: candidate,
    scratchDir: scratch,
    mechanical,
    leads: leads || '',
    ...(original ? { originalFixturesDir: original } : {}),
    allowUnverified,
  }
  const first = verifierCharter(charterArgs)
  seedOnContextLoss(verifierCtx, first, charterArgs, ownReports)
  const outcome = await inspectConverse(j, K, verifierCtx, first, allowUnverified, run)
  const { verdict, report } = outcome.value
  // 4. Effects on the replay never reach the capture or the Actor's tree; the original fixtures must be intact.
  const post = await j.op(`${K}/post`, 'inspect-post', { ep, gen }, async ({ recovering }) => {
    const changed = (await treeFingerprint(candidate)) !== pre.fp
    if (changed && run.lineage.isolation?.mode === 'sandbox' && !run.sandboxDegraded) {
      throw new InfraError('effect_isolation_failed', `the sandboxed Verifier of ${ep} changed its read-only candidate copy (generation ${gen})`)
    }
    if (original) {
      const present = await exists(original)
      if (present && !(await verifyTree(fixturesCapture, original))) {
        throw new InfraError('original_fixtures_changed', `the read-only original fixtures of ${ep} changed during verification (generation ${gen})`)
      }
      if (!present && !recovering) throw new InfraError('original_fixtures_changed', `the read-only original fixtures of ${ep} disappeared during verification (generation ${gen})`)
      await removeView(original)
    }
    const reportSha = await run.store.putReport(report)
    return { verdict, reportSha, effectsObserved: changed }
  })
  // 5. The Actor's own tree returns to its root; the replay (and any effect on it) is discarded.
  await j.op(`${K}/restore`, 'inspect-restore', { ep, gen }, async () => {
    await restoreActorRoot(candidate, aside)
    return null
  })
  if (post.effectsObserved) await run.event(`${K}/ev:effects`, 'VERIFIER_EFFECTS_OBSERVED', { episode, generation: gen })
  return { verdict, report, reportSha: post.reportSha }
}

/**
 * Captures a candidate tree privately into `dest` = `{tree/, manifest.json}` (SPEC §12.13 finish) and
 * returns `{ dir, digest }` with the treeFingerprint of the copy (what a sealed evaluation checks).
 * A tree the capture refuses (links leaving the tree, special files) is copied verbatim instead.
 */
export async function captureCandidate(root, dest) {
  try {
    await captureTree(root, dest, { allowInternalSymlinks: true })
  } catch (error) {
    if (error?.code !== 'capture_unsafe') throw error
    await removeTree(dest)
    await copyTree(root, join(dest, 'tree'), { verbatimSymlinks: true, preserveMode: true })
    await writeJsonAtomic(join(dest, 'manifest.json'), { unsafe: error.message })
  }
  return { dir: dest, digest: await treeFingerprint(join(dest, 'tree')) }
}

/**
 * Live target inspection under a full checkpoint (SPEC §12.7; Phase-2 target attempts and
 * Phase 3). The checkpoint is `priv/<T>/checkpoints/g<NNN>` (written via a tmp dir and renamed, so
 * a recovering `pre` re-uses only a complete one); `post` restores whenever the fingerprint changed,
 * re-materializes the Actor memory view and removes the checkpoint. With `captureVerified` (a
 * directory), a PASS or FAIL captures the checkpoint, which is exactly the tree the Verifier judged,
 * into it first (r2-engine-4). Returns `{ verdict, report, reportSha, manifest, verified }`
 * (`manifest` = the path of this generation's content manifest; `verified` = `{ dir, digest,
 * rootFp }` of the capture, or null).
 */
export async function inspectTarget(j, K, {
  verifierCtx, attempt, gen, root, actorMemoryDir, snapshotDir, before, prevGen = null, leads = '', forced = false, run,
  scratch, task, priorReports = [], handover = null, ownReports = [], captureVerified = null,
} = {}) {
  const priv = join(run.layout.priv, attempt)
  const checkpoint = join(priv, 'checkpoints', `g${pad3(gen)}`)
  const manifestPath = join(priv, 'manifests', `g${pad3(gen)}.json`)
  const pre = await j.op(`${K}/pre`, 'inspect-pre', { attempt, gen, forced }, async () => {
    await removeTree(actorMemoryDir)
    if (!(await exists(checkpoint))) {
      const tmp = `${checkpoint}.tmp`
      await removeTree(tmp)
      await mkdir(join(priv, 'checkpoints'), { recursive: true, mode: 0o700 })
      await copyTree(root, tmp, { verbatimSymlinks: true, preserveMode: true })
      await rename(tmp, checkpoint)
    }
    const fp = await treeFingerprint(root)
    const delta = describeDelta(manifestDelta(before, await projectManifest(root)), { header: 'since this target attempt began' })
    const manifest = await contentManifest(root)
    let changed = ''
    if (prevGen !== null) {
      const prev = await readJsonSafe(join(priv, 'manifests', `g${pad3(prevGen)}.json`), null)
      if (prev) changed = describeDelta(contentDelta(prev, manifest), { header: 'since your last inspection' })
    }
    await writeJsonAtomic(manifestPath, manifest)
    await freshScratch(scratch, { wipe: false })
    return { fp, delta, changed }
  })
  const charterArgs = {
    generation: gen,
    task: String(task).split(PROJECT_ROOT_TOKEN).join(root),
    candidateRoot: root,
    scratchDir: scratch,
    mechanical: pre.delta,
    changedSinceLast: pre.changed,
    leads: leads || '',
    priorReports,
    handover,
    allowUnverified: true,
  }
  const first = verifierCharter(charterArgs)
  seedOnContextLoss(verifierCtx, first, charterArgs, ownReports)
  const outcome = await inspectConverse(j, K, verifierCtx, first, true, run)
  const { verdict, report } = outcome.value
  const post = await j.op(`${K}/post`, 'inspect-post', { attempt, gen }, async () => {
    let rolledBack = false
    let paths = []
    let verified = null
    const capture = typeof captureVerified === 'string' && (verdict === 'PASS' || verdict === 'FAIL')
    if (await exists(checkpoint)) {
      if (capture) verified = { ...(await captureCandidate(checkpoint, captureVerified)), rootFp: pre.fp }
      if ((await treeFingerprint(root)) !== pre.fp) {
        paths = changedPaths(contentDelta(await contentManifest(checkpoint), await contentManifest(root)))
        await removeTree(root)
        await copyTree(checkpoint, root, { verbatimSymlinks: true, preserveMode: true })
        rolledBack = true
      }
    } else if (capture && (await exists(join(captureVerified, 'manifest.json')))) {
      // Re-run after the checkpoint was removed: the capture taken from it is complete.
      verified = { dir: captureVerified, digest: await treeFingerprint(join(captureVerified, 'tree')), rootFp: pre.fp }
    }
    await materializeView(snapshotDir, actorMemoryDir, { readOnly: true })
    await removeTree(checkpoint)
    const reportSha = await run.store.putReport(report)
    return { verdict, reportSha, rolledBack, paths, ...(verified ? { verified } : {}) }
  })
  if (post.rolledBack) {
    await run.event(`${K}/ev:rolled-back`, 'VERIFIER_EFFECTS_ROLLED_BACK', { episode: attempt, generation: gen, paths: post.paths })
  }
  return { verdict, report, reportSha: post.reportSha, manifest: manifestPath, verified: post.verified ?? null }
}

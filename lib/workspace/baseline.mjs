// S0 baseline: the candidate's file state when a task opened, for FILE-CHANGE EVIDENCE since the task
// began (SPEC §9.6; PF §4.4). RSIAgent `_snapshot`/`_surface_delta` (core/loop.py:408-445) take the
// baseline before the Actor exists; interactively the UserPromptSubmit hook spawns this module
// detached, so the evidence states how long after the task opened the baseline was captured.
//
// CLI: node lib/workspace/baseline.mjs <root> <outFile> <openedAtIso>
//      writes the baseline JSON atomically (0600) with `capturedAfterMs`.

import { realpathSync } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { homedir, setPriority } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeJsonAtomic } from '../core/atomic.mjs'
import { sha256File, sha256Hex } from '../core/digest.mjs'
import { comparePaths, isExcluded, listTree, mapPool, normalizeExcludes, nsToMsUs, sortPaths } from './copy.mjs'
import { describeDelta } from './fingerprint.mjs'
import { lsFiles } from './git.mjs'

const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__'])
const CONCURRENCY = 8
const DEFAULT_HASH_LIMIT = 2 * 2 ** 20

/** Whether `root` is the user's home directory or `/`, which are never walked (portability-11). */
function unwalkable(root) {
  if (root === resolve('/')) return true
  let home = resolve(homedir())
  try {
    home = realpathSync(home)
  } catch {
    // keep the lexical home
  }
  let real = root
  try {
    real = realpathSync(root)
  } catch {
    // keep the lexical root
  }
  return root === home || real === home
}

/**
 * Candidate paths by `method` ('git' when usable and non-empty, else 'walk'):
 * `{ method, paths, truncated, refused }`. The walk visits paths in byte order and stops after
 * `limit` files (`truncated`: `paths` is then the byte-order prefix of the full listing), and never
 * walks the user's home directory or `/` (`refused`, no paths).
 */
async function listCandidate(root, preferred, { limit = Infinity } = {}) {
  if (preferred !== 'walk') {
    const git = await lsFiles(root)
    if (git !== undefined && (git.files.length > 0 || preferred === 'git')) {
      return { method: 'git', paths: git.files.filter(rel => !rel.endsWith('/')), truncated: false, refused: false }
    }
  }
  if (unwalkable(root)) return { method: 'walk', paths: [], truncated: false, refused: true }
  const walk = await listTree(root, { skipNames: WALK_SKIP, limit })
  return { method: 'walk', paths: sortPaths([...walk.files, ...walk.links]), truncated: walk.truncated === true, refused: false }
}

/** `[size, mtimeMs, sha256|null]` for a regular file or link, or null for anything else / missing. */
async function describePath(full, hashLimitBytes) {
  let info
  try {
    info = await lstat(full, { bigint: true })
  } catch {
    return null
  }
  const size = Number(info.size)
  const mtimeMs = nsToMsUs(info.mtimeNs)
  if (info.isSymbolicLink()) {
    try {
      return [size, mtimeMs, sha256Hex(`symlink\0${await readlink(full)}`)]
    } catch {
      return null
    }
  }
  if (!info.isFile()) return null
  let digest = null
  if (size <= hashLimitBytes) {
    try {
      digest = await sha256File(full)
    } catch {
      digest = null
    }
  }
  return [size, mtimeMs, digest]
}

/**
 * Records `{rel: [size, mtimeMs, sha256|null]}` for the candidate files under `root` (safe-git
 * listing of tracked plus untracked-but-not-ignored files, else the dsh walk), hashing files up to
 * `hashLimitBytes`. At most `maxFiles` paths (the first in byte order; `truncated` says more existed);
 * the walk stops there instead of listing the whole tree. A walk of the user's home directory or `/`
 * is refused: the baseline is then incomplete (no evidence).
 * Returns `{ v:1, root, method, takenAt, complete, truncated, maxFiles, hashLimitBytes, files }`.
 */
export async function takeBaseline(root, { maxFiles = 20000, hashLimitBytes = DEFAULT_HASH_LIMIT } = {}) {
  const abs = resolve(root)
  const takenAt = new Date().toISOString()
  const limit = Math.max(0, maxFiles)
  const { method, paths, truncated, refused } = await listCandidate(abs, undefined, { limit })
  if (refused) return { v: 1, root: abs, method, takenAt, complete: false, truncated: false, maxFiles, hashLimitBytes, files: {} }
  const kept = paths.slice(0, limit)
  const described = await mapPool(kept, CONCURRENCY, rel => describePath(join(abs, rel), hashLimitBytes))
  const files = Object.fromEntries(kept.map((rel, i) => [rel, described[i]]).filter(([, value]) => value !== null))
  return { v: 1, root: abs, method, takenAt, complete: true, truncated: truncated || paths.length > kept.length, maxFiles, hashLimitBytes, files }
}

/**
 * FILE-CHANGE EVIDENCE since the task began: the baseline compared with the current state of `root`
 * (same listing method). Unchanged size and mtime means unchanged; otherwise hashes decide when both
 * sides have one. Paths after the last recorded one of a truncated baseline are not compared. An
 * incomplete or missing baseline, or a git baseline when git no longer works here, yields ''.
 */
export async function baselineDelta(baseline, root, { exclude = [] } = {}) {
  if (!baseline || baseline.complete !== true || !baseline.files || typeof baseline.files !== 'object') return ''
  const abs = resolve(root)
  const excludes = normalizeExcludes(abs, exclude)
  const hashLimit = Number.isFinite(baseline.hashLimitBytes) ? baseline.hashLimitBytes : DEFAULT_HASH_LIMIT
  const before = new Map(Object.entries(baseline.files).filter(([rel]) => !isExcluded(rel, excludes)))
  const recorded = sortPaths(Object.keys(baseline.files))
  const cutoff = baseline.truncated === true && recorded.length > 0 ? recorded.at(-1) : null
  // The walk is bounded too (with room for files created since); paths after its end are not compared.
  const maxFiles = Number.isInteger(baseline.maxFiles) && baseline.maxFiles >= 0 ? baseline.maxFiles : 20000
  const listing = await listCandidate(abs, baseline.method === 'walk' ? 'walk' : 'git', { limit: 2 * maxFiles + 1 })
  // A git baseline cannot be compared with a walk listing (it would report every ignored file as created).
  if (baseline.method !== 'walk' && listing.method !== 'git') return ''
  if (listing.refused) return ''
  const { paths } = listing
  const end = listing.truncated && paths.length > 0 ? paths.at(-1) : null
  const within = rel => (cutoff === null || comparePaths(rel, cutoff) <= 0) && (end === null || comparePaths(rel, end) <= 0)
  const now = paths.filter(rel => within(rel) && !isExcluded(rel, excludes))
  const nowSet = new Set(now)
  const created = []
  const modified = []
  const deleted = []
  await mapPool(now, CONCURRENCY, async rel => {
    const old = before.get(rel)
    const full = join(abs, rel)
    if (old === undefined) {
      if ((await describePath(full, 0)) !== null) created.push(rel)
      return
    }
    let info
    try {
      info = await lstat(full, { bigint: true })
    } catch {
      deleted.push(rel)
      return
    }
    const [size, mtimeMs, digest] = Array.isArray(old) ? old : []
    if (Number(info.size) !== size) {
      modified.push(rel)
      return
    }
    if (nsToMsUs(info.mtimeNs) === mtimeMs) return
    const current = await describePath(full, hashLimit)
    if (current === null) deleted.push(rel)
    else if (typeof digest !== 'string' || typeof current[2] !== 'string' || current[2] !== digest) modified.push(rel)
  })
  for (const rel of before.keys()) if (within(rel) && !nowSet.has(rel)) deleted.push(rel)
  const header = Number.isFinite(baseline.capturedAfterMs)
    ? `since this task began (baseline captured ${Math.max(0, Math.round(baseline.capturedAfterMs))} ms after the task opened)`
    : 'since this task began'
  return describeDelta(
    { created: sortPaths(created), modified: sortPaths(modified), deleted: sortPaths(deleted), truncated: cutoff !== null },
    { header },
  )
}

/** CLI entry (spawned detached by the UserPromptSubmit hook). Exit 0 written, 1 failed, 2 usage. */
export async function main(argv = process.argv.slice(2)) {
  const [root, outFile, openedAtIso] = argv
  if (!root || !outFile) {
    process.stderr.write('usage: node lib/workspace/baseline.mjs <root> <outFile> <openedAtIso>\n')
    return 2
  }
  try {
    setPriority(10) // background work: never compete with the session
  } catch {
    // Not permitted here: run at normal priority.
  }
  try {
    const openedMs = Date.parse(openedAtIso ?? '')
    const baseline = await takeBaseline(resolve(root))
    baseline.openedAt = Number.isFinite(openedMs) ? new Date(openedMs).toISOString() : null
    baseline.capturedAfterMs = Number.isFinite(openedMs) ? Math.max(0, Date.now() - openedMs) : null
    await writeJsonAtomic(resolve(outFile), baseline, { mode: 0o600 })
    return 0
  } catch (error) {
    process.stderr.write(`cc-rsi baseline: ${error?.stack ?? error}\n`)
    return 1
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().then(code => {
    process.exitCode = code
  })
}

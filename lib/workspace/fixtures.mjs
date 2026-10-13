// Fixture and candidate capture, replay and read-only views (SPEC §9.5).
// Port of dsh-rsi `engine/fixtures.ts` (shapeGate :24-54, captureTree :79-88, verifyTree :90-95,
// replayTree :97-102, stageReadOnlyView/removeView :116-127) and RSIAgent's owned-project shape gate
// (explore/target_learning.py:126-143), fixture capture/replay with an exact-set manifest
// (explore/provisioning.py:60-166) and the `chmod -R a-w` original-fixture view (target_learning.py:83-95).

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from '../core/atomic.mjs'
import { CcRsiError } from '../core/errors.mjs'
import { comparePaths, copyTree, makeReadOnly, makeWritable, removeTree, sortPaths } from './copy.mjs'

const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ELOOP'])

/** Whether `inner` is `outer` or lies under it (lexically, after resolve). */
function within(inner, outer) {
  const a = resolve(inner)
  const b = resolve(outer)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** Refuses argument mix-ups that would make a removal destroy the source of the operation. */
function assertDisjoint(code, keep, replace) {
  if (within(keep, replace) || within(replace, keep)) {
    throw new CcRsiError(code, `${resolve(replace)} and ${resolve(keep)} overlap`, { keep: resolve(keep), replace: resolve(replace) })
  }
}

/** Whether a link at `rel` with `target` resolves (lexically) inside its tree. */
function internalLink(rel, target) {
  if (typeof target !== 'string' || target === '' || isAbsolute(target) || target.includes('\0')) return false
  const resolved = posix.normalize(posix.join(posix.dirname(rel), target))
  return resolved !== '..' && !resolved.startsWith('../') && !posix.isAbsolute(resolved)
}

/**
 * RSIAgent's shape gate (target_learning.py:126-143; dsh fixtures.ts:24-54): an existing, non-link
 * directory with at least one regular file and no links or special files anywhere. With
 * `allowInternalSymlinks`, relative links that stay inside the tree are accepted (Phase-1 captures
 * keep venv-style links; RSIAgent provisioning.py). Returns null when the tree is valid, else a detail.
 */
export async function shapeGate(root, { allowInternalSymlinks = false } = {}) {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (ABSENT.has(error?.code)) return `${root} does not exist`
    if (UNREADABLE.has(error?.code)) return `${root} cannot be read`
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return `${root} is not a plain directory`
  let regular = 0
  const visit = async (dir, rel) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (UNREADABLE.has(error?.code)) return `${rel || root} cannot be read`
      if (ABSENT.has(error?.code)) return `${rel || root} disappeared while it was inspected`
      throw error
    }
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    for (const name of sortPaths(byName.keys())) {
      const entry = byName.get(name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      const full = join(dir, name)
      if (entry.isSymbolicLink()) {
        if (!allowInternalSymlinks) return `${childRel} is a symbolic link`
        let target
        try {
          target = await readlink(full)
        } catch {
          return `${childRel} is a symbolic link that cannot be read`
        }
        if (!internalLink(childRel, target)) return `${childRel} is a symbolic link that leaves the tree`
      } else if (entry.isDirectory()) {
        const nested = await visit(full, childRel)
        if (nested) return nested
      } else if (entry.isFile()) {
        regular++
      } else {
        return `${childRel} is not a regular file or directory`
      }
    }
    return null
  }
  const problem = await visit(root, '')
  if (problem) return problem
  return regular === 0 ? `${root} contains no regular file` : null
}

function sha256Of(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * Exact listing of a tree: `{ files: {rel: {bytes, sha256}}, dirs: [rel], links: {rel: target},
 * special: [rel] }` in byte order, or null when `root` is missing or not a plain directory.
 */
async function scanTree(root) {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (ABSENT.has(error?.code)) return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return null
  const files = []
  const dirs = []
  const links = []
  const special = []
  const visit = async (dir, rel) => {
    for (const name of sortPaths(await readdir(dir))) {
      const full = join(dir, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      const child = await lstat(full)
      if (child.isSymbolicLink()) links.push([childRel, await readlink(full)])
      else if (child.isDirectory()) {
        dirs.push(childRel)
        await visit(full, childRel)
      } else if (child.isFile()) files.push([childRel, { bytes: child.size, sha256: await sha256Of(full) }])
      else special.push(childRel)
    }
  }
  await visit(root, '')
  // Object.fromEntries defines own properties, so even a file named "__proto__" is an ordinary key.
  const toObject = pairs => Object.fromEntries(pairs.sort((x, y) => comparePaths(x[0], y[0])))
  return { files: toObject(files), dirs: sortPaths(dirs), links: toObject(links), special: sortPaths(special) }
}

/**
 * Captures `root` into `dest` byte for byte (RSIAgent fixture tar + sha256 manifest; dsh
 * fixtures.ts:79-88): removes `dest`, copies `root` to `dest/tree` (modes and times kept, every file
 * and directory fsync'd), and writes `dest/manifest.json` = `{files: {rel: {bytes, sha256}}, dirs,
 * links}`. Symbolic links are refused unless `allowInternalSymlinks`, and then copied verbatim only
 * when they stay inside the tree; special files are refused. Throws CcRsiError('capture_source_missing'
 * | 'capture_unsafe') and leaves no partial capture behind. Returns the manifest.
 */
export async function captureTree(root, dest, { allowInternalSymlinks = false } = {}) {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (ABSENT.has(error?.code)) throw new CcRsiError('capture_source_missing', `${root} does not exist`, { root })
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new CcRsiError('capture_unsafe', `${root} is not a plain directory`, { root })
  assertDisjoint('capture_overlap', root, dest)
  await removeTree(dest)
  await ensureDir(dest)
  try {
    const report = await copyTree(root, join(dest, 'tree'), { verbatimSymlinks: true, preserveMode: true, fsync: true })
    if (report.skipped.length > 0) {
      const first = report.skipped[0]
      const why = first.kind === 'vanished' ? 'disappeared while it was captured' : 'is not a regular file, directory or symbolic link'
      throw new CcRsiError('capture_unsafe', `${first.path} ${why}`, { root, skipped: report.skipped })
    }
    const scan = await scanTree(join(dest, 'tree'))
    for (const [rel, target] of Object.entries(scan.links)) {
      if (!allowInternalSymlinks) throw new CcRsiError('capture_unsafe', `${rel} is a symbolic link`, { root, path: rel })
      if (!internalLink(rel, target)) throw new CcRsiError('capture_unsafe', `${rel} is a symbolic link that leaves the tree`, { root, path: rel })
    }
    const manifest = { files: scan.files, dirs: scan.dirs, links: scan.links }
    await writeJsonAtomic(join(dest, 'manifest.json'), manifest)
    return manifest
  } catch (error) {
    await removeTree(dest).catch(() => undefined)
    throw error
  }
}

async function readCapture(captureDir) {
  let manifest
  try {
    manifest = await readJson(join(captureDir, 'manifest.json'), null)
  } catch (error) {
    throw new CcRsiError('capture_missing', `the capture in ${captureDir} is unreadable: ${error.message}`, { captureDir })
  }
  if (!manifest || !manifest.files || typeof manifest.files !== 'object' || !Array.isArray(manifest.dirs)) {
    throw new CcRsiError('capture_missing', `no capture in ${captureDir}`, { captureDir })
  }
  return manifest
}

function sameRecord(expected, actual) {
  const a = Object.keys(expected ?? {})
  const b = Object.keys(actual ?? {})
  if (a.length !== b.length) return false
  return a.every(key => Object.prototype.hasOwnProperty.call(actual, key) && JSON.stringify(expected[key]) === JSON.stringify(actual[key]))
}

/**
 * Whether `root` holds exactly the captured file set, contents, directories and links (dsh
 * fixtures.ts:90-95; RSIAgent exact-set check). Modes are not compared (a read-only view differs
 * only in write bits). A missing or linked `root`, or any special file, is a mismatch.
 */
export async function verifyTree(captureDir, root) {
  const manifest = await readCapture(captureDir)
  let scan
  try {
    scan = await scanTree(root)
  } catch (error) {
    if (ABSENT.has(error?.code) || UNREADABLE.has(error?.code)) return false
    throw error
  }
  if (scan === null || scan.special.length > 0) return false
  const dirs = sortPaths(manifest.dirs)
  if (dirs.length !== scan.dirs.length || dirs.some((dir, i) => dir !== scan.dirs[i])) return false
  const files = Object.fromEntries(Object.entries(manifest.files).map(([rel, item]) => [rel, { bytes: item?.bytes, sha256: item?.sha256 }]))
  return sameRecord(files, scan.files) && sameRecord(manifest.links ?? {}, scan.links)
}

/**
 * Replays a capture byte for byte at `root`, replacing whatever was there (dsh fixtures.ts:97-102).
 * Throws CcRsiError('replay_mismatch') when the result does not verify, CcRsiError('capture_missing')
 * when there is no capture.
 */
export async function replayTree(captureDir, root) {
  assertDisjoint('replay_overlap', captureDir, root)
  await readCapture(captureDir)
  await removeTree(root)
  await mkdir(dirname(resolve(root)), { recursive: true, mode: 0o700 })
  await copyTree(join(captureDir, 'tree'), root, { verbatimSymlinks: true, preserveMode: true })
  if (!(await verifyTree(captureDir, root))) {
    throw new CcRsiError('replay_mismatch', `replayed tree at ${root} does not match its capture`, { captureDir, root })
  }
}

/**
 * A read-only comparison view of a capture (RSIAgent `cp -a` + `chmod -R a-w`,
 * target_learning.py:83-95; dsh fixtures.ts:116-121). Any previous view at `viewDir` is removed first.
 */
export async function stageReadOnlyView(captureDir, viewDir) {
  try {
    await lstat(join(captureDir, 'tree'))
  } catch (error) {
    if (ABSENT.has(error?.code)) throw new CcRsiError('capture_missing', `no capture in ${captureDir}`, { captureDir })
    throw error
  }
  assertDisjoint('view_overlap', captureDir, viewDir)
  await removeView(viewDir)
  await mkdir(dirname(resolve(viewDir)), { recursive: true, mode: 0o700 })
  await copyTree(join(captureDir, 'tree'), viewDir, { verbatimSymlinks: true, preserveMode: true })
  await makeReadOnly(viewDir)
}

/** Removes a read-only view (write bits restored first); a missing view is a no-op (dsh fixtures.ts:123-127). */
export async function removeView(viewDir) {
  try {
    await lstat(viewDir)
  } catch (error) {
    if (ABSENT.has(error?.code)) return
    throw error
  }
  await makeWritable(viewDir)
  await removeTree(viewDir)
}

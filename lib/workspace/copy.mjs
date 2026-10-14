// Tree copy, removal, move-aside and write-bit helpers (SPEC §9.1).
//
// `fs.cp` is experimental on Node 18 (SPEC §0), so copies are an lstat-based recursive walk:
// symbolic links are reproduced verbatim (never followed), modes and timestamps are kept, and
// special files (FIFOs, sockets, devices) are skipped and reported. Ports dsh-rsi
// `engine/fixtures.ts:104-139` (setWritable, moveAside) and replaces its `cp` calls
// (`fixtures.ts:83,100,119`, `workspace.ts:232-235`).
//
// The bottom of this file holds small helpers shared by the other lib/workspace modules
// (path ordering, listing, stat/timestamp handling). They are package-internal.

import { constants } from 'node:fs'
import {
  chmod, copyFile, lstat, lutimes, mkdir, open, readdir, readlink, realpath, rename, rm, symlink, unlink, utimes,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CcRsiError } from '../core/errors.mjs'
import { pad3 } from '../core/ids.mjs'

const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
const COPY_FLAGS = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE

/**
 * Copies `src` to `dest` without following symbolic links.
 *
 * - `dest` must not exist, or be an empty directory (replacing an existing tree is the caller's job).
 * - `filter(rel, stats)` is asked for every entry below the root (rel is POSIX-relative); false skips
 *   the entry and, for a directory, its whole subtree.
 * - `verbatimSymlinks` (default true) recreates each link with its exact target text; false skips
 *   links (reported as `{path, kind:'symlink'}`); a link is never followed either way.
 * - `preserveMode` (default true) copies the permission bits; false keeps them but adds owner
 *   read/write (and search for directories), which is how a writable copy of a read-only view is made.
 * - `preserveTimestamps` (default true) copies atime/mtime at microsecond precision.
 * - `fsync` (default false) fsyncs every copied file and directory before returning.
 *
 * Special files are skipped and reported (`kind:'special'`); entries that vanish while the copy runs
 * are reported as `kind:'vanished'`. Returns `{ files, dirs, links, bytes, skipped: [{path, kind}] }`.
 */
export async function copyTree(src, dest, {
  filter = () => true, verbatimSymlinks = true, preserveMode = true, preserveTimestamps = true, fsync = false,
} = {}) {
  const from = resolve(src)
  const to = resolve(dest)
  let info
  try {
    info = await lstat(from, { bigint: true })
  } catch (error) {
    if (ABSENT.has(error?.code)) throw new CcRsiError('copy_source_missing', `cannot copy ${from}: it does not exist`, { src: from })
    throw error
  }
  await assertNotInside(from, to, info)
  const reuseEmptyDir = await destinationState(to, info)
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  const opts = { filter, verbatimSymlinks, preserveMode, preserveTimestamps, fsync }
  const report = { files: 0, dirs: 0, links: 0, bytes: 0, skipped: [] }
  await copyEntry(from, to, '', info, opts, report, reuseEmptyDir)
  if (fsync) await fsyncPath(dirname(to))
  return report
}

/** Refuses a copy of a directory into itself (it would never terminate). */
async function assertNotInside(from, to, info) {
  if (!isDir(info)) return
  const physical = async path => {
    // The destination does not exist yet: resolve its deepest existing ancestor.
    let probe = path
    const tail = []
    for (;;) {
      try {
        return join(await realpath(probe), ...tail.reverse())
      } catch (error) {
        if (!ABSENT.has(error?.code) || dirname(probe) === probe) return path
        tail.push(basename(probe))
        probe = dirname(probe)
      }
    }
  }
  const a = await physical(from)
  const b = await physical(to)
  if (b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)) {
    throw new CcRsiError('copy_into_self', `cannot copy ${from} into itself (${to})`, { src: from, dest: to })
  }
}

/** True when `to` is an existing empty directory the copy may fill; throws when `to` is taken. */
async function destinationState(to, srcInfo) {
  let existing
  try {
    existing = await lstat(to)
  } catch (error) {
    if (ABSENT.has(error?.code)) return false
    throw error
  }
  if (isDir(srcInfo) && existing.isDirectory() && (await readdir(to)).length === 0) return true
  throw new CcRsiError('copy_dest_exists', `cannot copy to ${to}: it already exists`, { dest: to })
}

async function copyEntry(from, to, rel, info, opts, report, reuseEmptyDir = false) {
  if (info.isSymbolicLink()) {
    if (!opts.verbatimSymlinks) {
      report.skipped.push({ path: rel || '.', kind: 'symlink' })
      return
    }
    await symlink(await readlink(from), to)
    if (opts.preserveTimestamps) await setTimesNs(to, info.atimeNs, info.mtimeNs, { link: true }).catch(() => undefined)
    report.links++
    return
  }
  if (info.isDirectory()) {
    if (!reuseEmptyDir) await mkdir(to, { mode: 0o700 })
    else await chmod(to, 0o700)
    for (const name of sortPaths(await readdir(from))) {
      const childFrom = join(from, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      let childInfo
      try {
        childInfo = await lstat(childFrom, { bigint: true })
      } catch (error) {
        if (!ABSENT.has(error?.code)) throw error
        report.skipped.push({ path: childRel, kind: 'vanished' })
        continue
      }
      if (!opts.filter(childRel, childInfo)) continue
      await copyEntry(childFrom, join(to, name), childRel, childInfo, opts, report)
    }
    // Modes and times last: a read-only source directory must not block writing its children,
    // and adding children changes a directory's mtime.
    await chmod(to, targetMode(info, opts.preserveMode, true))
    if (opts.preserveTimestamps) await setTimesNs(to, info.atimeNs, info.mtimeNs)
    if (opts.fsync) await fsyncPath(to)
    report.dirs++
    return
  }
  if (info.isFile()) {
    try {
      await copyFile(from, to, COPY_FLAGS)
    } catch (error) {
      if (!ABSENT.has(error?.code) || !(await vanished(from))) throw error
      report.skipped.push({ path: rel || '.', kind: 'vanished' })
      return
    }
    await chmod(to, targetMode(info, opts.preserveMode, false))
    if (opts.preserveTimestamps) await setTimesNs(to, info.atimeNs, info.mtimeNs)
    if (opts.fsync) await fsyncPath(to)
    report.files++
    report.bytes += Number(info.size)
    return
  }
  report.skipped.push({ path: rel || '.', kind: 'special' })
}

async function vanished(path) {
  try {
    await lstat(path)
    return false
  } catch (error) {
    return ABSENT.has(error?.code)
  }
}

function targetMode(info, preserve, directory) {
  const mode = Number(info.mode) & 0o7777
  if (preserve) return mode
  return mode | (directory ? 0o700 : 0o600)
}

/**
 * `rm -rf path`, never following symbolic links. When removal is refused because a directory
 * lacks write or search permission (read-only views), the tree's directories get owner rwx and
 * the removal is retried. The parent's mode is never changed. Refuses `/`, `''` and the home dir.
 */
export async function removeTree(path) {
  if (typeof path !== 'string' || path === '') throw new CcRsiError('unsafe_remove', 'refusing to remove an empty path')
  const abs = resolve(path)
  if (abs === resolve('/') || abs === resolve(homedir())) {
    throw new CcRsiError('unsafe_remove', `refusing to remove ${abs}`, { path: abs })
  }
  try {
    await rm(abs, { recursive: true, force: true, maxRetries: 2 })
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error
    await unlockTree(abs)
    await rm(abs, { recursive: true, force: true, maxRetries: 2 })
  }
}

async function unlockTree(path) {
  let info
  try {
    info = await lstat(path)
  } catch {
    return
  }
  if (!info.isDirectory()) return
  await chmod(path, (info.mode & 0o7777) | 0o700).catch(() => undefined)
  let names = []
  try {
    names = await readdir(path)
  } catch {
    return
  }
  for (const name of names) await unlockTree(join(path, name))
}

/**
 * Moves `dir` (a directory or any other entry) to `<intoDir>/<prefix>NNN`, the next free number,
 * and returns that path; a missing `dir` returns null (dsh `fixtures.ts:130-139`; RSIAgent keeps
 * infra attempts for recovery). The slot is reserved atomically before the rename, so concurrent
 * callers never share a number. Across filesystems the entry is copied, then the source removed.
 */
export async function moveAside(dir, intoDir, prefix = 'attempt_') {
  let info
  try {
    info = await lstat(dir)
  } catch (error) {
    if (ABSENT.has(error?.code)) return null
    throw error
  }
  await mkdir(intoDir, { recursive: true, mode: 0o700 })
  let next = 1
  for (const name of await readdir(intoDir)) {
    if (!name.startsWith(prefix)) continue
    const n = Number(name.slice(prefix.length))
    if (Number.isInteger(n) && n >= next) next = n + 1
  }
  for (let attempt = 0; attempt < 10000; attempt++, next++) {
    const target = join(intoDir, `${prefix}${pad3(next)}`)
    try {
      if (info.isDirectory()) await mkdir(target, { mode: 0o700 })
      else await (await open(target, 'wx', 0o600)).close()
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
    try {
      await rename(dir, target)
      return target
    } catch (error) {
      if (error?.code !== 'EXDEV') {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    }
    // Different filesystem: copy into the reserved slot, then remove the source.
    if (!info.isDirectory()) await unlink(target)
    await copyTree(dir, target)
    await removeTree(dir)
    return target
  }
  throw new CcRsiError('move_aside_failed', `no free slot under ${intoDir}`, { dir, intoDir })
}

/**
 * Clears every write bit below and including `dir`, directories after their children
 * (RSIAgent `chmod -R a-w`, target_learning.py:91; dsh `fixtures.ts:104-121`). Symbolic links are
 * left alone. A missing `dir` is a no-op.
 */
export async function makeReadOnly(dir) {
  await setWritable(dir, false)
}

/** Restores the owner write bit below and including `dir`, directories before their children. */
export async function makeWritable(dir) {
  await setWritable(dir, true)
}

async function setWritable(path, writable) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (ABSENT.has(error?.code)) return
    throw error
  }
  if (info.isSymbolicLink()) return
  const mode = info.mode & 0o7777
  if (info.isDirectory()) {
    if (writable) await chmod(path, mode | 0o200)
    for (const name of await readdir(path)) await setWritable(join(path, name), writable)
    if (!writable) await chmod(path, mode & ~0o222)
    return
  }
  if (info.isFile()) await chmod(path, writable ? mode | 0o200 : mode & ~0o222)
}

// ---------------------------------------------------------------------------------------------
// Package-internal helpers shared by lib/workspace modules.

/** Byte-wise (UTF-8) order: deterministic across platforms and locales. */
export function comparePaths(a, b) {
  if (a === b) return 0
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** A sorted copy of `paths` in UTF-8 byte order. */
export function sortPaths(paths) {
  return [...paths].sort(comparePaths)
}

/** Whether `error` means "not there" (ENOENT, or a path component that is not a directory). */
export function isAbsent(error) {
  return ABSENT.has(error?.code)
}

/** Whether `info` (number or bigint stats) is a directory. */
function isDir(info) {
  return info.isDirectory()
}

/**
 * Normalises harness `exclude` paths to POSIX paths relative to `root` without a trailing slash.
 * Absolute paths under `root` are converted; anything outside `root`, empty or escaping is dropped.
 */
export function normalizeExcludes(root, exclude = []) {
  const out = []
  for (const raw of exclude ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    let rel = raw
    if (isAbsolute(raw)) {
      rel = relative(resolve(root), resolve(raw))
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    }
    rel = rel.split(sep).join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (rel === '' || rel === '.' || rel.split('/').includes('..')) continue
    out.push(rel)
  }
  return [...new Set(out)]
}

/** Whether `rel` equals or lies under one of `prefixes` (POSIX relative paths). */
export function isExcluded(rel, prefixes) {
  for (const p of prefixes) if (rel === p || rel.startsWith(`${p}/`)) return true
  return false
}

/**
 * Whether `rel` is covered by a listing in git's `ls-files --directory` style: an entry ending in
 * '/' covers everything under it ('./' covers everything), any other entry covers exactly itself.
 */
export function coveredBy(rel, entries) {
  for (const entry of entries) {
    if (entry === './' || entry === '.') return true
    if (entry.endsWith('/') ? rel.startsWith(entry) || `${rel}/` === entry : rel === entry) return true
  }
  return false
}

/**
 * Lists `root` without following symbolic links. Directories named in `skipNames` (at any depth),
 * excluded paths and directories covered by `skipCovered` (ls-files style) are not entered.
 * Unreadable directories are reported in `blocked` as `rel/` (`./` for the root itself).
 * With `limit` (portability-11) the walk visits paths in UTF-8 byte order and stops before the
 * regular file that would exceed `limit` files: the result is then exactly the byte-order prefix of
 * the full listing up to its last file, and `truncated` is true.
 * Returns sorted `{ files, links, dirs, special, blocked, truncated }` (POSIX relative paths).
 */
export async function listTree(root, { skipNames = new Set(), exclude = [], skipCovered = [], limit = Infinity } = {}) {
  const out = { files: [], links: [], dirs: [], special: [], blocked: [] }
  const bounded = Number.isFinite(limit)
  let truncated = false
  // Depth-first over siblings sorted by `name/` for directories and `name` otherwise visits full
  // paths in byte order ('a.txt' < 'a/x' because '.' < '/').
  const key = entry => (entry.isDirectory() ? `${entry.name}/` : entry.name)
  const visit = async (dir, rel) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (ABSENT.has(error?.code)) return
      if (['EACCES', 'EPERM', 'ELOOP'].includes(error?.code)) {
        out.blocked.push(rel === '' ? './' : `${rel}/`)
        return
      }
      throw error
    }
    if (bounded) entries.sort((a, b) => comparePaths(key(a), key(b)))
    for (const entry of entries) {
      if (truncated) return
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (isExcluded(childRel, exclude)) continue
      if (entry.isDirectory()) {
        if (skipNames.has(entry.name) || coveredBy(`${childRel}/`, skipCovered)) continue
        out.dirs.push(childRel)
        await visit(join(dir, entry.name), childRel)
      } else if (entry.isFile()) {
        if (out.files.length >= limit) {
          truncated = true
          return
        }
        out.files.push(childRel)
      } else if (entry.isSymbolicLink()) out.links.push(childRel)
      else out.special.push(childRel)
    }
  }
  await visit(resolve(root), '')
  for (const name of Object.keys(out)) out[name] = sortPaths(out[name])
  out.truncated = truncated
  return out
}

/** Integer microseconds of a bigint nanosecond timestamp (the precision timestamps survive a restore). */
export function nsToUs(ns) {
  return typeof ns === 'bigint' ? ns / 1000n : BigInt(ns) / 1000n
}

/** Milliseconds (float) of a bigint nanosecond timestamp, truncated to whole microseconds. */
export function nsToMsUs(ns) {
  return Number(nsToUs(ns)) / 1000
}

/**
 * Seconds value for utimes that lands exactly on the microsecond of `ns`: libuv converts the double
 * to a timespec and truncates to microseconds, so the value is centred inside that microsecond.
 */
function secondsFor(ns) {
  const value = typeof ns === 'bigint' ? ns : BigInt(ns)
  if (value < 0n) return Number(value) / 1e9
  const sec = value / 1_000_000_000n
  const us = (value % 1_000_000_000n) / 1000n
  return Number(sec) + (Number(us) + 0.5) / 1e6
}

/** Sets atime/mtime from nanosecond values (bigint or decimal string), at microsecond precision. */
export async function setTimesNs(path, atimeNs, mtimeNs, { link = false } = {}) {
  const a = secondsFor(atimeNs)
  const m = secondsFor(mtimeNs)
  if (link) await lutimes(path, a, m)
  else await utimes(path, a, m)
}

/** fsyncs a file or directory; platforms that cannot fsync a directory are ignored. */
export async function fsyncPath(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF', 'EACCES', 'ENOENT'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Runs `fn` over `items` with at most `limit` in flight; results keep the input order. After the
 * first failure no new item starts, every running call is awaited, then the first error is thrown
 * (so no work continues in the background once the caller has seen the error).
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  let failure = null
  const worker = async () => {
    while (failure === null && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        if (failure === null) failure = { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (failure !== null) throw failure.error
  return results
}

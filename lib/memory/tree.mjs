// Memory tree scanning, pulling and writing (SPEC §6.4 step 5, §6.7).
//
// Rules (RSIAgent practice_loop.py:304-317 `_read_memory_tree`, commit.py pull validation as
// summarized in analysis/memory-learning.md §5.2, dsh store.ts:120-134 `walk`):
// - regular files only; a symlink or special file anywhere → UnsafeMemoryPathError
//   (RSIAgent raises "durable memory contains a symlink");
// - every relative name must pass safeRelativePath and be valid UTF-8 without lone surrogates
//   (Python cannot encode such a name, memory-learning.md §6.4);
// - `__pycache__/`, `*.pyc` and `*.pyo` are dropped (the RSIAgent guest pull excludes them);
// - empty directories are not part of a tree;
// - keys are POSIX relative paths sorted by UTF-8 bytes.

import { constants as FS } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fsyncDir, rmrf } from '../core/atomic.mjs'
import { compareUtf8, sha256Hex, sortUtf8 } from '../core/digest.mjs'
import { pidAlive } from '../core/proc.mjs'
import { UnsafeMemoryPathError } from './errors.mjs'
import { EMPTY_TREE_SHA256, isWellFormedUnicode, treeSha256 } from './hash.mjs'
import { safeRelativePath } from './safe-path.mjs'

/** Python-artifact filter applied to every tree (RSIAgent pull excludes these). */
export const DEFAULT_DROP = rel => /(^|\/)__pycache__(\/|$)/.test(rel) || /\.py[co]$/.test(rel)

const utf8 = new TextDecoder('utf-8', { fatal: true })

function decodeName(raw, parentRel) {
  if (typeof raw === 'string') return raw
  try {
    return utf8.decode(raw)
  } catch {
    throw new UnsafeMemoryPathError({ path: `${parentRel ? `${parentRel}/` : ''}${raw.toString('latin1')}`, reason: 'name is not valid UTF-8' })
  }
}

function checkName(rel) {
  if (!isWellFormedUnicode(rel)) throw new UnsafeMemoryPathError({ path: rel, reason: 'name is not valid UTF-8' })
  safeRelativePath(rel)
}

async function lstatOrNull(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * Lists the regular files of a tree without reading them: `[{ rel, full, bytes, mode }]`
 * sorted by UTF-8 bytes. A missing root lists nothing; a root that is a symlink or not a
 * directory is refused. Entries that vanish while listing are skipped.
 */
export async function listTree(root, { drop = DEFAULT_DROP } = {}) {
  const info = await lstatOrNull(root)
  if (info === null) return []
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UnsafeMemoryPathError({ path: root, reason: 'memory root is not a real directory' })
  }
  const out = []
  const visit = async (dir, prefix) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'buffer' })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
      throw error
    }
    for (const entry of entries) {
      const name = decodeName(entry.name, prefix)
      const rel = prefix ? `${prefix}/${name}` : name
      checkName(rel)
      const full = join(dir, name)
      const stat = await lstatOrNull(full)
      if (stat === null) continue
      if (stat.isSymbolicLink()) throw new UnsafeMemoryPathError({ path: rel, reason: 'memory tree contains a symlink' })
      if (stat.isDirectory()) {
        if (drop(rel)) continue
        await visit(full, rel)
        continue
      }
      if (!stat.isFile()) throw new UnsafeMemoryPathError({ path: rel, reason: 'memory tree contains a special file' })
      if (drop(rel)) continue
      out.push({ rel, full, bytes: stat.size, mode: stat.mode & 0o777 })
    }
  }
  await visit(root, '')
  return out.sort((a, b) => compareUtf8(a.rel, b.rel))
}

/**
 * Reads one listed file without following a symlink swapped in after listing
 * (O_NOFOLLOW; O_NONBLOCK so a FIFO swapped in cannot block). Returns null if it vanished.
 */
async function readRegular(entry) {
  let handle
  try {
    handle = await open(entry.full, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (error?.code === 'ELOOP') throw new UnsafeMemoryPathError({ path: entry.rel, reason: 'memory tree contains a symlink' })
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new UnsafeMemoryPathError({ path: entry.rel, reason: 'memory tree contains a special file' })
    return await handle.readFile()
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Hashes a tree: `{ files: {rel: {bytes, sha256, mode}}, treeSha256 }` with keys in UTF-8
 * order. A missing root gives `{ files: {}, treeSha256: EMPTY_TREE_SHA256 }`. Rejects like
 * pullTree.
 */
export async function scanTree(root, { drop = DEFAULT_DROP } = {}) {
  const files = {}
  const hashes = {}
  for (const entry of await listTree(root, { drop })) {
    const data = await readRegular(entry)
    if (data === null) continue
    const sha256 = sha256Hex(data)
    files[entry.rel] = { bytes: data.length, sha256, mode: entry.mode }
    hashes[entry.rel] = sha256
  }
  return { files, treeSha256: Object.keys(hashes).length === 0 ? EMPTY_TREE_SHA256 : treeSha256(hashes) }
}

/** Reads a tree's contents: `{rel: Buffer}` in UTF-8 key order (same rules as scanTree). */
export async function pullTree(root, { drop = DEFAULT_DROP } = {}) {
  const out = {}
  for (const [rel, { data }] of Object.entries(await loadTree(root, { drop }))) out[rel] = data
  return out
}

/** Reads a tree's contents with modes: `{rel: {data: Buffer, mode}}` in UTF-8 key order. */
export async function loadTree(root, { drop = DEFAULT_DROP } = {}) {
  const out = {}
  for (const entry of await listTree(root, { drop })) {
    const data = await readRegular(entry)
    if (data !== null) out[entry.rel] = { data, mode: entry.mode }
  }
  return out
}

/** Manifest `{rel: {bytes, sha256}}` of pulled contents (RSIAgent practice_loop.py:385-390 `_manifest`). */
export function manifestOf(contents) {
  const manifest = {}
  for (const rel of sortUtf8(Object.keys(contents))) manifest[rel] = { bytes: contents[rel].length, sha256: sha256Hex(contents[rel]) }
  return manifest
}

/**
 * `{created, modified, deleted, unchanged}` between two manifests (`{rel: {sha256}}`), each
 * sorted by UTF-8 bytes (port of dsh store.ts:80-91 with the UTF-8 ordering fix).
 */
export function diffManifests(before = {}, after = {}) {
  const created = []
  const modified = []
  const unchanged = []
  for (const [rel, entry] of Object.entries(after)) {
    const prior = before[rel]
    if (prior === undefined) created.push(rel)
    else if (prior.sha256 !== entry.sha256) modified.push(rel)
    else unchanged.push(rel)
  }
  const deleted = Object.keys(before).filter(rel => after[rel] === undefined)
  return { created: sortUtf8(created), modified: sortUtf8(modified), deleted: sortUtf8(deleted), unchanged: sortUtf8(unchanged) }
}

/** fsyncs every file, then every directory deepest-first, then the root (RSIAgent practice_loop.py:320-336 `_fsync_tree`). */
export async function fsyncTree(root) {
  const dirs = []
  const visit = async dir => {
    dirs.push(dir)
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) {
        const handle = await open(full, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    }
  }
  await visit(root)
  for (const dir of dirs.reverse()) await fsyncDir(dir)
}

/**
 * Writes `contents` (`{rel: Buffer|string}`) into a NEW directory `dest` (which must not
 * exist) in sorted order. `fileMode(rel)` and `dirMode` set permissions; with `fsync` the whole
 * tree is made durable (RSIAgent practice_loop.py:339-367 stage step).
 */
export async function writeTree(dest, contents, { fileMode = () => 0o600, dirMode = 0o700, fsync = false } = {}) {
  await mkdir(dest, { mode: dirMode })
  const made = new Set([''])
  for (const rel of sortUtf8(Object.keys(contents))) {
    checkName(rel)
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const sub = parts.slice(0, i).join('/')
      if (made.has(sub)) continue
      await mkdir(join(dest, sub), { mode: dirMode }).catch(error => { if (error?.code !== 'EEXIST') throw error })
      made.add(sub)
    }
    const mode = fileMode(rel)
    const handle = await open(join(dest, rel), 'wx', mode)
    try {
      await handle.writeFile(contents[rel])
      if (fsync) await handle.sync()
    } finally {
      await handle.close()
    }
    // open() applies the umask; set the exact mode.
    await chmod(join(dest, rel), mode)
  }
  if (fsync) await fsyncTree(dest)
}

/** A sibling of a replaceDir whose writer left no pid (an earlier format) is stale after this. */
const SIBLING_STALE_MS = 10 * 60 * 1000
/** `<dest>.staging-<pid>-<nonce>` / `<dest>.old-<pid>-<nonce>` (the pid is absent in the earlier format). */
const SIBLING_RE = /^(?:staging|old)-(?:(\d+)-)?[0-9a-f]{12}$/

/**
 * Removes the staging and old siblings of `dest` that a replaceDir killed mid-way left behind:
 * those whose writer's pid is gone, or, without a pid, that are older than SIBLING_STALE_MS. A
 * sibling of a live writer (another refresh in flight, including this process's) is kept.
 * Symbolic links are unlinked, never followed.
 */
async function removeStaleSiblings(dest) {
  const parent = dirname(dest)
  const prefix = `${basename(dest)}.`
  let names
  try {
    names = await readdir(parent)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const match = SIBLING_RE.exec(name.slice(prefix.length))
    if (!match) continue
    const full = join(parent, name)
    const info = await lstatOrNull(full).catch(() => null)
    if (info === null) continue
    const pid = match[1] === undefined ? null : Number(match[1])
    const stale = pid === null ? Date.now() - info.mtimeMs > SIBLING_STALE_MS : pid !== process.pid && !pidAlive(pid)
    if (!stale) continue
    if (info.isDirectory()) await rmrf(full).catch(() => undefined)
    else await unlink(full).catch(() => undefined)
  }
}

/**
 * Replaces directory `dest` with a tree built by `build(stagingDir)`: the new tree is built in
 * a sibling staging dir, then swapped in by renames, so `dest` is never seen half-written.
 * An existing `dest` symlink is unlinked, never followed. Staging and old siblings left by an
 * earlier replaceDir that was killed are removed first.
 */
export async function replaceDir(dest, build) {
  const nonce = randomBytes(6).toString('hex')
  const staging = `${dest}.staging-${process.pid}-${nonce}`
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
  await removeStaleSiblings(dest)
  const old = `${dest}.old-${process.pid}-${nonce}`
  await rmrf(staging)
  try {
    await build(staging)
  } catch (error) {
    await rmrf(staging).catch(() => undefined)
    throw error
  }
  const prior = await lstatOrNull(dest)
  if (prior !== null) await rename(dest, old)
  try {
    await rename(staging, dest)
  } catch (error) {
    if (prior !== null) await rename(old, dest).catch(() => undefined)
    await rmrf(staging).catch(() => undefined)
    throw error
  }
  if (prior !== null) await rmrf(old)
}

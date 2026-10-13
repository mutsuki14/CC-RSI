// Atomic file primitives (SPEC §0 "Files", §5.3).
//
// Every non-append write goes to a temporary file in the same directory, is fsync'd,
// renamed over the destination, and the directory is fsync'd (RSIAgent
// practice_loop.py:280-295 `_write_json_atomic`, dsh store.ts:523-524).

import { randomBytes } from 'node:crypto'
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CcRsiError } from './errors.mjs'

/** Creates `dir` (and parents) with `mode` for the directories it creates. Returns `dir`. */
export async function ensureDir(dir, mode = 0o700) {
  await mkdir(dir, { recursive: true, mode })
  return dir
}

function tmpNameFor(path) {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

/** fsyncs a directory so a rename or create inside it is durable. Unsupported platforms are ignored. */
export async function fsyncDir(dir) {
  let handle
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch (error) {
    // EISDIR/EINVAL/EPERM/EBADF: the platform cannot fsync a directory; ENOENT: nothing to make durable.
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF', 'ENOENT', 'EACCES'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function fsyncDirSync(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF', 'ENOENT', 'EACCES'].includes(error?.code)) throw error
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * Writes `data` (string or Buffer) to `path` atomically: tmp file in the same directory
 * (created with `mode`), fsync, rename, fsync the directory. Missing parent directories are
 * created with mode 0700. A failed write never leaves a partial destination or a tmp file.
 */
export async function writeFileAtomic(path, data, { mode = 0o600 } = {}) {
  const tmp = tmpNameFor(path)
  let handle
  try {
    try {
      handle = await open(tmp, 'wx', mode)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await ensureDir(dirname(path))
      handle = await open(tmp, 'wx', mode)
    }
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmp, path)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  await fsyncDir(dirname(path))
}

/** `writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n')`. */
export async function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

/** Synchronous `writeJsonAtomic` for hooks on the hot path. */
export function writeJsonAtomicSync(path, value, { mode = 0o600 } = {}) {
  const tmp = tmpNameFor(path)
  let fd
  try {
    try {
      fd = openSync(tmp, 'wx', mode)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      fd = openSync(tmp, 'wx', mode)
    }
    const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    let offset = 0
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  fsyncDirSync(dirname(path))
}

/**
 * Parses the JSON file at `path`. ENOENT (or ENOTDIR) → `fallback`; malformed content →
 * CcRsiError('json_malformed'); any other fs error is rethrown.
 */
export async function readJson(path, fallback) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return fallback
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CcRsiError('json_malformed', `malformed JSON in ${path}: ${error.message}`, { path })
  }
}

/** Like `readJson`, but any error (missing, unreadable, malformed) yields `fallback`. */
export async function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Synchronous `readJsonSafe`. */
export function readJsonSafeSync(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Makes every directory under `path` writable (never following symlinks), so a read-only view can be removed. */
async function makeTreeWritable(path) {
  let info
  try {
    info = await lstat(path)
  } catch {
    return
  }
  if (!info.isDirectory()) return
  await chmod(path, 0o700).catch(() => undefined)
  let names = []
  try {
    names = await readdir(path)
  } catch {
    return
  }
  for (const name of names) await makeTreeWritable(join(path, name))
}

/**
 * Removes `path` recursively; a missing path is not an error. Read-only directories
 * (the 0555 memory views) are made writable first when removal is refused. Symlinks are
 * removed, never followed.
 */
export async function rmrf(path) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') throw error
    // Only the tree being removed is made writable; the parent's mode is never changed.
    await makeTreeWritable(path)
    await rm(path, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** Whether `path` exists (lstat: a dangling symlink exists). */
export async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

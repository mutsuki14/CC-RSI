// fsync'd JSONL journals that tolerate a torn tail (SPEC §0 "Files", §5.3).
//
// Port of dsh store.ts:300-326 (`#journalize`: newline-safe append after a torn final line)
// and store.ts:717-730 (`journal`: a torn final line is not a record).

import {
  closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeSync,
} from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const NEWLINE = 0x0a

/**
 * Appends `JSON.stringify(value)` as one line. When the file's last byte is not a newline
 * (a torn tail from an interrupted append), a newline is written first so the new record
 * stays parseable. One write call per record; fsync'd unless `fsync: false`. The file is
 * created with mode 0600 (parent directories 0700).
 */
export async function appendJsonl(path, value, { fsync = true } = {}) {
  const line = `${JSON.stringify(value)}\n`
  let handle
  try {
    try {
      handle = await open(path, 'a+', 0o600)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      handle = await open(path, 'a+', 0o600)
    }
    const { size } = await handle.stat()
    let prefix = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      if (last[0] !== NEWLINE) prefix = '\n'
    }
    const buffer = Buffer.from(prefix + line, 'utf8')
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
      offset += bytesWritten
    }
    if (fsync) await handle.sync()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn line from an interrupted append is not a record.
    }
  }
  return out
}

/** Parsed records of a JSONL file. ENOENT → []; unparseable (torn) lines are skipped. */
export async function readJsonl(path) {
  try {
    return parseLines(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
}

/** Synchronous `appendJsonl` (always fsync'd) for hooks on the hot path. */
export function appendJsonlSync(path, value) {
  const line = `${JSON.stringify(value)}\n`
  let fd
  try {
    try {
      fd = openSync(path, 'a+', 0o600)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      fd = openSync(path, 'a+', 0o600)
    }
    const { size } = fstatSync(fd)
    let prefix = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      if (last[0] !== NEWLINE) prefix = '\n'
    }
    const buffer = Buffer.from(prefix + line, 'utf8')
    let offset = 0
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Synchronous `readJsonl`. */
export function readJsonlSync(path) {
  try {
    return parseLines(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
}

// Tree fingerprints, project manifests and mechanical change descriptions (SPEC §9.4).
// Port of dsh-rsi `engine/workspace.ts` (projectManifest :10-37, treeFingerprint :45-73,
// describeDelta :76-90) and RSIAgent `_snapshot`/`_surface_delta` (core/loop.py:408-445): facts
// about candidate changes, never a grade.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { comparePaths, nsToMsUs, sortPaths } from './copy.mjs'

/** Directories a project manifest never enters (dsh workspace.ts:7). */
const MANIFEST_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__'])
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ELOOP'])

function hashStream(hash, path) {
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolvePromise)
  })
}

/**
 * Digest of everything under `root` — every file, link and directory with its mode, including
 * `.git`, dependency trees and caches — so an effect anywhere in the candidate is detected. No ignore
 * list and no cap: this is the integrity check, not the Verifier's summary (dsh workspace.ts:39-73).
 * Records, in byte order: `D rel mode`, `F rel mode size <content>`, `L rel target`, `O rel mode`
 * (other) and `U rel` (unreadable). The root's own type and mode are included; a missing root has
 * its own digest.
 */
export async function treeFingerprint(root) {
  const hash = createHash('sha256')
  const abs = resolve(root)
  const record = (...fields) => hash.update(`${fields.join('\0')}\0`)
  const entry = async (full, rel) => {
    let info
    try {
      info = await lstat(full)
    } catch (error) {
      if (ABSENT.has(error?.code)) return false
      if (UNREADABLE.has(error?.code)) {
        record('U', rel)
        return true
      }
      throw error
    }
    const mode = info.mode & 0o7777
    if (info.isSymbolicLink()) {
      record('L', rel, await readlink(full))
    } else if (info.isDirectory()) {
      record('D', rel, mode)
      let names
      try {
        names = await readdir(full)
      } catch (error) {
        if (!UNREADABLE.has(error?.code) && !ABSENT.has(error?.code)) throw error
        record('U', rel)
        return true
      }
      for (const name of sortPaths(names)) await entry(join(full, name), rel === '' ? name : `${rel}/${name}`)
    } else if (info.isFile()) {
      record('F', rel, mode, info.size)
      try {
        await hashStream(hash, full)
      } catch (error) {
        if (!UNREADABLE.has(error?.code) && !ABSENT.has(error?.code)) throw error
        record('U', rel)
      }
      hash.update('\0')
    } else {
      record('O', rel, mode)
    }
    return true
  }
  if (!(await entry(abs, ''))) record('M')
  return hash.digest('hex')
}

/**
 * Size-and-time manifest of a project tree for mechanical context and resume decisions (dsh
 * workspace.ts:10-37, cheaper: no content hashing). Skips `.git`, `node_modules`, `.venv` and
 * `__pycache__`; walks in byte order and stops after `limit` files (`truncated:true`), so the kept
 * set is deterministic. Symbolic links are listed with their target (`link`). mtimeMs is truncated
 * to whole microseconds (the precision copies and restores reproduce).
 * Returns `{ files: {rel: {size, mtimeMs, link?}}, truncated }`.
 */
export async function projectManifest(root, { limit = 5000 } = {}) {
  const pairs = []
  let count = 0
  let truncated = false
  const visit = async (dir, rel) => {
    let names
    try {
      names = await readdir(dir)
    } catch (error) {
      if (ABSENT.has(error?.code) || UNREADABLE.has(error?.code)) return
      throw error
    }
    for (const name of sortPaths(names)) {
      if (truncated) return
      const childRel = rel === '' ? name : `${rel}/${name}`
      const full = join(dir, name)
      let info
      try {
        info = await lstat(full, { bigint: true })
      } catch (error) {
        if (ABSENT.has(error?.code) || UNREADABLE.has(error?.code)) continue
        throw error
      }
      if (info.isDirectory()) {
        if (!MANIFEST_SKIP.has(name)) await visit(full, childRel)
        continue
      }
      if (!info.isFile() && !info.isSymbolicLink()) continue
      if (count >= limit) {
        truncated = true
        return
      }
      count++
      const item = { size: Number(info.size), mtimeMs: nsToMsUs(info.mtimeNs) }
      if (info.isSymbolicLink()) {
        try {
          item.link = await readlink(full)
        } catch {
          item.link = ''
        }
      }
      pairs.push([childRel, item])
    }
  }
  await visit(resolve(root), '')
  // Object.fromEntries defines own properties, so a file named "__proto__" is an ordinary key.
  return { files: Object.fromEntries(pairs), truncated }
}

/** A `{rel: entry}` map from either a manifest wrapper (`{files, …}`) or a bare map. */
function filesOf(manifest) {
  if (!manifest || typeof manifest !== 'object') return { files: {}, truncated: false }
  const inner = manifest.files
  const wrapper = inner && typeof inner === 'object' && !Array.isArray(inner)
    && Object.values(inner).every(value => value !== null && typeof value === 'object')
  if (wrapper) return { files: inner, truncated: manifest.truncated === true }
  return { files: manifest, truncated: false }
}

const sizeOf = entry => (Number.isFinite(entry?.size) ? entry.size : Number.isFinite(entry?.bytes) ? entry.bytes : undefined)

/** Whether two manifest entries describe the same content (content hash, else size and time). */
function sameEntry(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return sameEntry(fromTuple(a), fromTuple(b))
  if (a.link !== undefined || b.link !== undefined) return a.link === b.link
  const sa = sizeOf(a)
  const sb = sizeOf(b)
  if (sa !== undefined && sb !== undefined && sa !== sb) return false
  if (a.mode !== undefined && b.mode !== undefined && a.mode !== b.mode) return false
  if (typeof a.sha256 === 'string' && typeof b.sha256 === 'string') return a.sha256 === b.sha256
  if (Number.isFinite(a.mtimeMs) && Number.isFinite(b.mtimeMs)) return a.mtimeMs === b.mtimeMs
  return true
}

/** Baseline tuples `[size, mtimeMs, sha256|null]` as entries. */
function fromTuple(value) {
  if (!Array.isArray(value)) return value ?? {}
  return { size: value[0], mtimeMs: value[1], sha256: value[2] ?? undefined }
}

/**
 * Created/modified/deleted paths between two manifests (byte order). Accepts `projectManifest`
 * results, capture manifests (`{files: {rel: {bytes, sha256}}, dirs}`), checkpoint manifests or bare
 * `{rel: entry}` maps; entries compare by sha256 when both sides have one, else by size and mtime.
 * When either side was truncated, only paths up to the last path both listings covered are compared
 * and the result carries `truncated: true`.
 */
export function manifestDelta(before, after) {
  const a = filesOf(before)
  const b = filesOf(after)
  const keysA = Object.keys(a.files)
  const keysB = Object.keys(b.files)
  let cutoff = null
  for (const side of [[a, keysA], [b, keysB]]) {
    if (!side[0].truncated || side[1].length === 0) continue
    const last = sortPaths(side[1]).at(-1)
    if (cutoff === null || comparePaths(last, cutoff) < 0) cutoff = last
  }
  const within = rel => cutoff === null || comparePaths(rel, cutoff) <= 0
  const has = (map, key) => Object.prototype.hasOwnProperty.call(map, key)
  const created = []
  const modified = []
  const deleted = []
  for (const rel of keysB) {
    if (!within(rel)) continue
    if (!has(a.files, rel)) created.push(rel)
    else if (!sameEntry(a.files[rel], b.files[rel])) modified.push(rel)
  }
  for (const rel of keysA) if (within(rel) && !has(b.files, rel)) deleted.push(rel)
  const delta = { created: sortPaths(created), modified: sortPaths(modified), deleted: sortPaths(deleted) }
  if (a.truncated || b.truncated) delta.truncated = true
  return delta
}

/**
 * Created/modified/deleted between two content manifests (`{rel: {size, sha256}}`, e.g. checkpoint
 * manifests of consecutive inspections: CHANGED SINCE YOUR LAST INSPECTION). A missing previous
 * manifest counts as empty. Entries without a hash compare by size, mode and time.
 */
export function contentDelta(prevManifest, curManifest) {
  return manifestDelta(prevManifest ?? {}, curManifest ?? {})
}

/**
 * Mechanical text for a delta (RSIAgent `_surface_delta`, dsh `describeDelta`):
 * "FILE-CHANGE EVIDENCE <header>:" then `CREATED (n):`, `MODIFIED (n):`, `DELETED (n):` sections with
 * one path per line (empty sections omitted), at most `maxLines` paths in total with "… N more"
 * markers; or "No file changes detected <header>." when nothing changed.
 */
export function describeDelta(delta, { maxLines = 200, header = '' } = {}) {
  const suffix = header ? ` ${header}` : ''
  const sections = [['CREATED', delta?.created ?? []], ['MODIFIED', delta?.modified ?? []], ['DELETED', delta?.deleted ?? []]]
  const total = sections.reduce((sum, [, list]) => sum + list.length, 0)
  const note = delta?.truncated ? '\n(The file listing was truncated; paths beyond it were not compared.)' : ''
  if (total === 0) return `No file changes detected${suffix}.${note}`
  const lines = [`FILE-CHANGE EVIDENCE${suffix}:`]
  let budget = Math.max(0, Math.floor(maxLines))
  for (const [title, list] of sections) {
    if (list.length === 0) continue
    lines.push(`${title} (${list.length}):`)
    const shown = list.slice(0, budget)
    budget -= shown.length
    for (const path of shown) lines.push(`  ${path}`)
    if (shown.length < list.length) lines.push(`  … ${list.length - shown.length} more`)
  }
  return lines.join('\n') + note
}

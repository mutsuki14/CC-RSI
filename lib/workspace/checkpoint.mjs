// Interactive candidate checkpoint with displaced-copy restore (SPEC §9.3).
//
// Port of dsh-rsi `host/checkpoint.ts` (WorkspaceCheckpoint, :49-251) with the cc-rsi changes:
// - the checkpoint is persisted (`<dir>/entries.json` + `<dir>/files/<rel>`), so a recovery process
//   can restore it after the job died (SPEC §11.5 "Recovery");
// - restore never deletes: the current version of a restored path and every file the inspection
//   created are MOVED to `displacedDir/<rel>` (PR §4.5 step 7);
// - restored files get back their mode and their mtime (to the microsecond), so `statusDigest` of a
//   restored workspace equals the digest taken before the inspection (verdict currency, §11.3);
// - symbolic links are checkpointed and restored as links; restore never writes through a symbolic
//   link (a parent replaced by a link is moved aside and recreated as a directory);
// - restore compares again afterwards and retries once; a path whose restore succeeded but that was
//   changed again by something outside the inspection is reported as `unstable`;
// - restore never replaces what appears meanwhile (memory-crash-6): a file is hard-linked into place
//   and a link created in place (both fail with EEXIST instead of replacing), the newcomer is moved
//   aside and the install retried; a displacement across filesystems removes its source only when
//   the source did not change after the copy;
// - outside git the walk refuses the user's home directory and `/`, and stops (checkpoint_failed)
//   past `walkMaxFiles` files instead of listing an unbounded tree on every submit (portability-11).
//   It fails closed: a checkpoint that covered only part of the tree would miss side effects.
//
// RSIAgent counterpart: the Verifier's effects never reach the candidate (QEMU rollback,
// `core/verifier.py`; practice_loop.py:760 `_verify_candidate`).

import { constants, realpathSync } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, readdir, readlink, realpath, rename, symlink, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readJson, writeJsonAtomic } from '../core/atomic.mjs'
import { sha256File, sha256Hex } from '../core/digest.mjs'
import { CcRsiError } from '../core/errors.mjs'
import {
  copyTree, coveredBy, isExcluded, listTree, mapPool, normalizeExcludes, nsToMsUs, nsToUs, removeTree,
  setTimesNs, sortPaths,
} from './copy.mjs'
import { DERIVED_DIR_NAMES, lsFiles } from './git.mjs'

/**
 * Directories the walk method never enters (dsh checkpoint.ts:7). The git listing leaves out the
 * UNTRACKED files below the same derived-cache directories (r3-interactive-1), so both listings agree:
 * a Verifier's ordinary bytecode or dependency-cache writes are neither restored nor reported.
 */
const WALK_SKIP = new Set(['.git', ...DERIVED_DIR_NAMES])
/** Filesystem clocks are coarser than Date.now(): only a birth well before the take counts (dsh :25). */
const BIRTH_MARGIN_MS = 2000
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ELOOP'])
const COPY_FLAGS = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
const CONCURRENCY = 8
const RESTORE_SUFFIX = '.cc-rsi-restore'
/** Default bound of the walk outside git (it also stays at least 10 times `maxFiles`). */
const WALK_MAX_FILES = 200000
/** Installs of one path retried while something outside the inspection keeps creating it. */
const INSTALL_ATTEMPTS = 5
/** link(2) is not supported by this filesystem (FAT, some network and FUSE filesystems). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'])

/** Why `absRoot` must not be walked as a candidate (the user's home or `/`), or null. */
function unwalkableRoot(absRoot) {
  if (absRoot === resolve('/')) return 'the filesystem root'
  let home = resolve(homedir())
  try {
    home = realpathSync(home)
  } catch {
    // keep the lexical home
  }
  return absRoot === home ? 'your home directory' : null
}

/** Shape, size, time and identity of every entry of a tree (the source of a cross-filesystem displacement). */
async function treeSignature(path) {
  const rows = []
  const visit = async (full, rel) => {
    const info = await lstat(full, { bigint: true })
    rows.push([rel, String(info.mode), String(info.size), String(info.mtimeNs), String(info.ino)].join('\0'))
    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await visit(join(full, name), rel === '' ? name : `${rel}/${name}`)
    }
  }
  await visit(path, '')
  return rows.join('\n')
}

function errorText(error) {
  return error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error)
}

/** A POSIX relative path that stays inside its root. */
function safeRel(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel) || rel.includes('\\')) return false
  return rel.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Caches whether each directory (relative to the root) is a real directory, not a link. */
class AncestorCache {
  constructor(root) {
    this.root = root
    this.dirs = new Map([['', 'ok']])
  }

  /** 'ok' | 'missing' (absent, or not a real directory) | 'unreadable'. */
  async check(dirRel) {
    if (dirRel === '' || dirRel === '.') return 'ok'
    const cached = this.dirs.get(dirRel)
    if (cached !== undefined) return cached
    const parent = dirRel.includes('/') ? dirRel.slice(0, dirRel.lastIndexOf('/')) : ''
    let state = await this.check(parent)
    if (state === 'ok') {
      try {
        const info = await lstat(join(this.root, dirRel))
        state = info.isDirectory() ? 'ok' : 'missing'
      } catch (error) {
        state = ABSENT.has(error?.code) ? 'missing' : 'unreadable'
      }
    }
    this.dirs.set(dirRel, state)
    return state
  }
}

const parentOf = rel => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

/**
 * lstat of `<root>/<rel>` that never looks through a linked parent: null when absent (or when a parent
 * is not a real directory), 'unreadable' when it cannot be examined, else bigint stats.
 */
async function lstatUnder(root, rel, ancestors) {
  const state = await ancestors.check(parentOf(rel))
  if (state === 'missing') return null
  if (state === 'unreadable') return 'unreadable'
  try {
    return await lstat(join(root, rel), { bigint: true })
  } catch (error) {
    if (ABSENT.has(error?.code)) return null
    if (UNREADABLE.has(error?.code)) return 'unreadable'
    throw error
  }
}

function entryFromStats(info) {
  return {
    type: info.isSymbolicLink() ? 'link' : 'file',
    size: Number(info.size),
    mtimeMs: nsToMsUs(info.mtimeNs),
    mtimeNs: String(info.mtimeNs),
    atimeNs: String(info.atimeNs),
    mode: Number(info.mode) & 0o7777,
    sha256: null,
    copy: false,
  }
}

const linkDigest = target => sha256Hex(`symlink\0${target}`)

export class Checkpoint {
  #dir
  #state
  #entries
  #disposed = false
  #extraExclude = []

  /** Use `Checkpoint.take` or `Checkpoint.load`. */
  constructor(dir, state) {
    this.#dir = resolve(dir)
    this.#state = state
    this.#entries = new Map(Object.entries(state.entries))
  }

  /**
   * Checkpoints the candidate files under `root` (realpath'd) into `dir` (which must not hold a checkpoint yet).
   * Listing: git (tracked plus untracked-but-not-ignored, via `lsFiles`, without untracked files below
   * `node_modules`, `.venv` and `__pycache__`) or, when git is unusable or lists nothing, a walk
   * skipping `.git`, `node_modules`, `.venv` and `__pycache__` (dsh :216-245).
   * Every listed regular file and symbolic link is lstat'd; above `maxFiles` files or `maxBytes` bytes
   * the checkpoint is detect-only (size, mtime and mode; nothing is read or copied). Otherwise each
   * file is copied to `files/<rel>` and hashed from the copy. `entries.json` is written last.
   * The walk refuses the user's home directory and `/`, and a tree of more than `walkMaxFiles`
   * files (default max(200000, 10 × maxFiles)): CcRsiError 'checkpoint_failed'.
   */
  static async take(root, { dir, exclude = [], maxBytes = 268435456, maxFiles = 20000, walkMaxFiles } = {}) {
    if (typeof dir !== 'string' || dir === '') throw new CcRsiError('checkpoint_dir_required', 'Checkpoint.take needs a dir')
    const takenAtMs = Date.now()
    const absDir = resolve(dir)
    let absRoot
    let rootInfo
    try {
      // A symlinked project directory is checkpointed at its real location (restore then refuses a
      // root that has been replaced by a link).
      absRoot = await realpath(resolve(root))
      rootInfo = await lstat(absRoot)
    } catch (error) {
      absRoot = resolve(root)
      throw new CcRsiError('checkpoint_failed', `the candidate root ${absRoot} cannot be read: ${errorText(error)}`, { root: absRoot })
    }
    if (!rootInfo.isDirectory()) throw new CcRsiError('checkpoint_failed', `the candidate root ${absRoot} is not a directory`, { root: absRoot })
    try {
      await lstat(join(absDir, 'entries.json'))
      throw new CcRsiError('checkpoint_exists', `${absDir} already holds a checkpoint; restore or dispose of it first`, { dir: absDir })
    } catch (error) {
      if (error instanceof CcRsiError) throw error
      if (!ABSENT.has(error?.code)) throw error
    }
    // Leftovers of a take that crashed before entries.json are ours to clear.
    await removeTree(absDir)
    await mkdir(join(absDir, 'files'), { recursive: true, mode: 0o700 })

    // The checkpoint itself is never part of the candidate, even if a caller stores it inside the root.
    const excludes = [...new Set([
      ...normalizeExcludes(absRoot, exclude), ...normalizeExcludes(resolve(root), exclude), ...normalizeExcludes(absRoot, [absDir]),
    ])]
    let method = 'walk'
    let listed
    let ignoredDirs = []
    let opaqueDirs = []
    let blocked
    const git = await lsFiles(absRoot, { exclude: excludes, skipUntrackedIn: DERIVED_DIR_NAMES })
    if (git !== undefined && git.files.length > 0) {
      method = 'git'
      listed = git.files.filter(rel => !rel.endsWith('/'))
      opaqueDirs = git.files.filter(rel => rel.endsWith('/'))
      ignoredDirs = git.ignoredDirs
      // Directories nobody could read hold files that pre-date the inspection; git skips them silently.
      blocked = (await listTree(absRoot, { skipNames: WALK_SKIP, exclude: excludes, skipCovered: ignoredDirs })).blocked
    } else {
      // Never walk a whole home directory or filesystem (cost, and macOS privacy prompts; portability-11).
      const unwalkable = unwalkableRoot(absRoot)
      if (unwalkable !== null) {
        throw new CcRsiError('checkpoint_failed',
          `the candidate root ${absRoot} is ${unwalkable} and not a git project; open Claude Code in a project directory`, { root: absRoot })
      }
      const cap = Number.isInteger(walkMaxFiles) && walkMaxFiles >= 0 ? walkMaxFiles : Math.max(WALK_MAX_FILES, 10 * maxFiles)
      const walk = await listTree(absRoot, { skipNames: WALK_SKIP, exclude: excludes, limit: cap })
      if (walk.truncated) {
        throw new CcRsiError('checkpoint_failed',
          `the candidate root ${absRoot} holds more than ${cap} files outside git (not counting .git, node_modules, .venv and __pycache__); `
          + 'open Claude Code in a project directory, or make the project a git repository', { root: absRoot, cap })
      }
      if (walk.blocked.includes('./')) throw new CcRsiError('checkpoint_failed', `the candidate root ${absRoot} cannot be listed`, { root: absRoot })
      listed = sortPaths([...walk.files, ...walk.links])
      blocked = walk.blocked
    }

    const ancestors = new AncestorCache(absRoot)
    const entries = new Map()
    const unreadable = []
    for (const rel of listed) {
      if (!safeRel(rel) || isExcluded(rel, excludes)) continue
      const info = await lstatUnder(absRoot, rel, ancestors)
      if (info === null) continue // a tracked file deleted from the work tree has nothing to checkpoint
      if (info === 'unreadable') {
        unreadable.push(rel)
        continue
      }
      if (!info.isFile() && !info.isSymbolicLink()) continue
      entries.set(rel, entryFromStats(info))
    }
    let fileCount = 0
    let bytes = 0
    for (const entry of entries.values()) {
      if (entry.type !== 'file') continue
      fileCount++
      bytes += entry.size
    }
    const detectOnly = fileCount > maxFiles || bytes > maxBytes

    await mapPool([...entries.keys()], CONCURRENCY, async rel => {
      const entry = entries.get(rel)
      const full = join(absRoot, rel)
      if (entry.type === 'link') {
        try {
          entry.link = await readlink(full)
          entry.sha256 = linkDigest(entry.link)
        } catch (error) {
          if (ABSENT.has(error?.code)) entries.delete(rel)
          else unreadable.push(rel)
        }
        return
      }
      if (detectOnly) return
      const copy = join(absDir, 'files', rel)
      try {
        await mkdir(dirname(copy), { recursive: true, mode: 0o700 })
        // A writer racing the take: retry until the source is stable across the copy; after three
        // tries the last copy stands (its own size and hash are recorded; the race is not an error).
        for (let attempt = 0; ; attempt++) {
          await copyFile(full, copy, COPY_FLAGS)
          const after = await lstat(full, { bigint: true })
          if (!after.isFile()) {
            // Replaced by a link or directory while copying: never keep content read through it.
            await removeTree(copy)
            entries.delete(rel)
            return
          }
          const stable = String(after.mtimeNs) === entry.mtimeNs && Number(after.size) === entry.size
          Object.assign(entry, entryFromStats(after))
          if (stable || attempt >= 2) break
          await removeTree(copy)
        }
        await chmod(copy, 0o600)
        entry.sha256 = await sha256File(copy)
        entry.size = Number((await lstat(copy)).size)
        entry.copy = true
      } catch (error) {
        if (ABSENT.has(error?.code)) {
          entries.delete(rel)
          await removeTree(copy).catch(() => undefined)
          return
        }
        if (!UNREADABLE.has(error?.code)) throw error
        // A file the harness cannot read is still tracked by size, time and mode; it cannot be restored.
        unreadable.push(rel)
        await removeTree(copy).catch(() => undefined)
      }
    })

    const entryObject = Object.fromEntries(sortPaths([...entries.keys()]).map(rel => [rel, entries.get(rel)]))
    const state = {
      v: 1,
      root: absRoot,
      method,
      detectOnly,
      takenAt: new Date(takenAtMs).toISOString(),
      takenAtMs,
      exclude: excludes,
      limits: { maxBytes, maxFiles },
      totals: { files: fileCount, bytes },
      entries: entryObject,
      blocked: sortPaths([...new Set([...blocked, ...unreadable])]),
      ignoredDirs,
      opaqueDirs,
    }
    await writeJsonAtomic(join(absDir, 'entries.json'), state)
    return new Checkpoint(absDir, state)
  }

  /** Re-opens a persisted checkpoint (e.g. in a recovery process). Throws CcRsiError('checkpoint_missing'|'checkpoint_corrupt'). */
  static async load(dir) {
    const absDir = resolve(dir)
    let state
    try {
      state = await readJson(join(absDir, 'entries.json'), null)
    } catch (error) {
      throw new CcRsiError('checkpoint_corrupt', `${absDir}/entries.json is unreadable: ${errorText(error)}`, { dir: absDir })
    }
    if (state === null) throw new CcRsiError('checkpoint_missing', `no checkpoint in ${absDir}`, { dir: absDir })
    const corrupt = why => new CcRsiError('checkpoint_corrupt', `${absDir}/entries.json is invalid: ${why}`, { dir: absDir })
    if (!state || state.v !== 1) throw corrupt('unknown version')
    if (typeof state.root !== 'string' || !isAbsolute(state.root)) throw corrupt('root')
    if (state.method !== 'git' && state.method !== 'walk') throw corrupt('method')
    if (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) throw corrupt('entries')
    for (const [rel, entry] of Object.entries(state.entries)) {
      if (!safeRel(rel)) throw corrupt(`unsafe path ${JSON.stringify(rel)}`)
      if (!entry || (entry.type !== 'file' && entry.type !== 'link') || !Number.isInteger(entry.mode) || !Number.isFinite(entry.size)) {
        throw corrupt(`entry ${JSON.stringify(rel)}`)
      }
      if (entry.type === 'link' && typeof entry.link !== 'string') throw corrupt(`link ${JSON.stringify(rel)}`)
    }
    for (const key of ['blocked', 'ignoredDirs', 'opaqueDirs', 'exclude']) {
      if (state[key] === undefined) state[key] = []
      if (!Array.isArray(state[key]) || state[key].some(item => typeof item !== 'string')) throw corrupt(key)
    }
    if (!Number.isFinite(state.takenAtMs)) state.takenAtMs = Date.parse(state.takenAt)
    if (!Number.isFinite(state.takenAtMs)) throw corrupt('takenAt')
    return new Checkpoint(absDir, state)
  }

  /** Removes a checkpoint directory without loading it (e.g. a take that never wrote entries.json). */
  static async discard(dir) {
    await removeTree(resolve(dir))
  }

  /**
   * Whether `<root>/<rel>` holds what a manifest entry describes (`manifest()`: `{size, mode,
   * sha256}`; `null` = the path did not exist at the take). Used after the checkpoint is gone, e.g. to
   * tell whether restored paths still hold the candidate (r3-interactive-7). Never looks through a
   * linked parent. Returns true, false, or null when it cannot tell (no hash recorded, unreadable).
   */
  static async entryMatches(root, rel, expected) {
    if (!safeRel(rel)) return null
    let info
    try {
      info = await lstatUnder(resolve(root), rel, new AncestorCache(resolve(root)))
    } catch {
      return null
    }
    if (info === 'unreadable') return null
    if (info === null) return expected === null
    if (expected === null || typeof expected !== 'object') return false
    if (info.isSymbolicLink()) {
      if (typeof expected.sha256 !== 'string') return null
      try {
        return linkDigest(await readlink(join(resolve(root), rel))) === expected.sha256
      } catch {
        return null
      }
    }
    if (!info.isFile() || Number(info.size) !== expected.size || (Number.isInteger(expected.mode) && (Number(info.mode) & 0o7777) !== expected.mode)) return false
    if (typeof expected.sha256 !== 'string') return null
    try {
      return (await sha256File(join(resolve(root), rel))) === expected.sha256
    } catch {
      return null
    }
  }

  get root() { return this.#state.root }
  get dir() { return this.#dir }
  get detectOnly() { return this.#state.detectOnly === true }
  get method() { return this.#state.method }
  get takenAt() { return this.#state.takenAt }

  /** sha256 over the sorted `[rel, size, mode, sha256 | mtimeMs]` of the entries (the candidate digest). */
  fingerprint() {
    const rows = sortPaths([...this.#entries.keys()]).map(rel => {
      const e = this.#entries.get(rel)
      return [rel, e.size, e.mode, e.sha256 ?? e.mtimeMs]
    })
    return sha256Hex(JSON.stringify(rows))
  }

  /** `{rel: {size, mode, sha256, mtimeMs}}` in byte order (sha256 null for detect-only or unreadable files). */
  manifest() {
    return Object.fromEntries(sortPaths([...this.#entries.keys()]).map(rel => {
      const e = this.#entries.get(rel)
      return [rel, { size: e.size, mode: e.mode, sha256: e.sha256 ?? null, mtimeMs: e.mtimeMs }]
    }))
  }

  #assertOpen() {
    if (this.#disposed) throw new CcRsiError('checkpoint_disposed', `the checkpoint in ${this.#dir} was disposed`)
  }

  #excludes() {
    return [...this.#state.exclude, ...this.#extraExclude]
  }

  /** Lists the paths the take-time method sees now; falls back to the walk when git no longer works. */
  async #listNow() {
    const root = this.root
    if (this.method === 'git') {
      const git = await lsFiles(root, { exclude: this.#excludes(), skipUntrackedIn: DERIVED_DIR_NAMES })
      if (git !== undefined) return { paths: git.files.filter(rel => !rel.endsWith('/')) }
    }
    // The walk also covers a git checkpoint whose repository broke during the inspection; files that
    // git ignored at take time stay protected through `ignoredDirs`.
    const walk = await listTree(root, { skipNames: WALK_SKIP, exclude: this.#excludes() })
    if (walk.blocked.includes('./')) return { paths: null }
    return { paths: [...walk.files, ...walk.links] }
  }

  /** Full comparison: `{ changed, deleted, created, retime, listed }` (sorted). */
  async #diff() {
    const root = this.root
    const ancestors = new AncestorCache(root)
    const changed = []
    const deleted = []
    const retime = []
    const excludes = this.#excludes()
    const rels = sortPaths([...this.#entries.keys()]).filter(rel => !isExcluded(rel, excludes))
    await mapPool(rels, CONCURRENCY, async rel => {
      const e = this.#entries.get(rel)
      const info = await lstatUnder(root, rel, ancestors)
      if (info === null) return deleted.push(rel)
      if (info === 'unreadable') return changed.push(rel)
      if (e.type === 'link') {
        if (!info.isSymbolicLink()) return changed.push(rel)
        let target
        try {
          target = await readlink(join(root, rel))
        } catch (error) {
          if (ABSENT.has(error?.code)) return deleted.push(rel)
          return changed.push(rel)
        }
        if (target !== e.link) return changed.push(rel)
        if (nsToUs(info.mtimeNs) !== nsToUs(e.mtimeNs)) retime.push(rel)
        return undefined
      }
      if (!info.isFile() || (Number(info.mode) & 0o7777) !== e.mode || Number(info.size) !== e.size) return changed.push(rel)
      if (e.sha256 === null) {
        // Detect-only or unreadable at take time: size, time and mode are all there is (dsh :143-146).
        if (String(info.mtimeNs) !== e.mtimeNs) changed.push(rel)
        return undefined
      }
      let digest
      try {
        digest = await sha256File(join(root, rel))
      } catch (error) {
        if (ABSENT.has(error?.code)) return deleted.push(rel)
        return changed.push(rel)
      }
      if (digest !== e.sha256) return changed.push(rel)
      if (nsToUs(info.mtimeNs) !== nsToUs(e.mtimeNs)) retime.push(rel)
      return undefined
    })
    const created = []
    const listing = await this.#listNow()
    if (listing.paths !== null) {
      for (const rel of listing.paths) {
        if (this.#entries.has(rel) || !safeRel(rel) || isExcluded(rel, excludes)) continue
        // A listed path counts as created only when a regular file or a link is there now (dsh :167-172).
        const info = await lstatUnder(root, rel, ancestors)
        if (info === null || info === 'unreadable') continue
        if (info.isFile() || info.isSymbolicLink()) created.push(rel)
      }
    }
    return {
      changed: sortPaths(changed), deleted: sortPaths(deleted), created: sortPaths(created), retime: sortPaths(retime),
      listed: listing.paths !== null,
    }
  }

  /**
   * Paths that differ from the checkpoint: `changed` (entry exists but differs in type, mode, size,
   * content or link target; detect-only entries also by mtime), `deleted` (entry missing) and
   * `created` (listed now by the take-time method, not an entry, a regular file or link now).
   */
  async compare() {
    this.#assertOpen()
    const { changed, created, deleted } = await this.#diff()
    return { changed, created, deleted }
  }

  /** Whether a created `rel` may have existed before the inspection although it was not checkpointed (dsh :117-125). */
  async #preexisting(rel) {
    const s = this.#state
    if (coveredBy(rel, s.blocked) || coveredBy(rel, s.ignoredDirs) || coveredBy(rel, s.opaqueDirs)) return true
    let info
    try {
      info = await lstat(join(this.root, rel))
    } catch {
      return false
    }
    // Where the filesystem records birth times, a file born before the checkpoint is never the inspection's.
    return info.birthtimeMs > 0 && info.birthtimeMs < s.takenAtMs - BIRTH_MARGIN_MS
  }

  /**
   * Restores the candidate (never deleting anything):
   * 1. every created path that did not pre-exist is MOVED to `displacedDir/<rel>`;
   * 2. every changed or deleted entry with a copy: the current version (if any) is moved to
   *    `displacedDir/<rel>`, a parent that is no longer a real directory is moved aside too, then the
   *    copy is staged as `<file>.cc-rsi-restore`, given its mode and times, and renamed into place;
   * 3. entries whose content matches but whose mtime moved get their times back (`retimed`);
   * 4. empty directories the inspection created (born after the take) are moved aside as well;
   * 5. the tree is compared again; whatever still differs is restored once more. A path whose restore
   *    succeeded but that differs again afterwards was changed by something outside the inspection
   *    and is reported in `unstable` (not a failure).
   * Individual failures go to `failed`; pre-existing created paths are left in place (`kept`).
   * A path something outside the inspection created while it was being put back is moved aside too
   * and reported in `unstable` (memory-crash-6).
   * A detect-only checkpoint restores nothing and reports every difference in `skipped`.
   * Returns `{ restored, displaced, failed: [{path, error}], skipped, retimed, kept, unstable }`
   * (relative paths; a displaced empty directory ends with '/').
   */
  async restore({ displacedDir } = {}) {
    this.#assertOpen()
    if (typeof displacedDir !== 'string' || displacedDir === '') {
      throw new CcRsiError('displaced_dir_required', 'Checkpoint.restore needs a displacedDir')
    }
    const out = {
      restored: new Set(), displaced: new Set(), failed: new Map(), skipped: [], retimed: new Set(), kept: new Set(), unstable: [],
    }
    const finish = () => ({
      restored: sortPaths([...out.restored]),
      displaced: sortPaths([...out.displaced]),
      failed: sortPaths([...out.failed.keys()]).map(path => ({ path, error: out.failed.get(path) })),
      skipped: out.skipped,
      retimed: sortPaths([...out.retimed]),
      kept: sortPaths([...out.kept]),
      unstable: sortPaths(out.unstable),
    })
    const root = this.root
    let rootInfo
    try {
      rootInfo = await lstat(root)
    } catch (error) {
      out.failed.set('.', `the candidate root cannot be read: ${errorText(error)}`)
      return finish()
    }
    if (!rootInfo.isDirectory()) {
      out.failed.set('.', 'the candidate root is no longer a directory')
      return finish()
    }
    if (this.detectOnly) {
      const diff = await this.#diff()
      out.skipped = sortPaths([...new Set([...diff.changed, ...diff.deleted, ...diff.created])])
      return finish()
    }
    const ctx = { displacedDir: resolve(displacedDir), out, createdDirs: new Set(), contested: new Set() }
    // Displaced copies are never candidates themselves, even if a caller keeps them inside the root.
    this.#extraExclude = normalizeExcludes(root, [ctx.displacedDir])
    let diff = await this.#diff()
    // A second round catches what the first one uncovered (e.g. a parent moved aside late).
    for (let round = 0; round < 2; round++) {
      if (this.#remaining(diff, out).length === 0 && diff.retime.length === 0) break
      await this.#restoreRound(diff, ctx)
      diff = await this.#diff()
    }
    const remaining = new Set(this.#remaining(diff, out))
    for (const rel of [...out.failed.keys()]) if (!remaining.has(rel)) out.failed.delete(rel)
    // What still differs although its restore succeeded was changed again by someone else
    // (a process outside the inspection), and so was a path created while it was put back:
    // reported, not a restore failure.
    out.unstable = [...new Set([...remaining, ...ctx.contested])].filter(rel => !out.failed.has(rel))
    if (!diff.listed) out.failed.set('.', 'the candidate root could not be listed after the inspection; created files were not displaced')
    return finish()
  }

  /** Paths that still differ and are not explained (kept pre-existing paths, uncopyable entries already failed). */
  #remaining(diff, out) {
    const pending = [...diff.changed, ...diff.deleted]
    for (const rel of diff.created) if (!out.kept.has(rel)) pending.push(rel)
    return sortPaths([...new Set(pending)])
  }

  async #restoreRound(diff, ctx) {
    const { out } = ctx
    const root = this.root
    for (const rel of diff.created) {
      if (out.kept.has(rel)) continue
      if (await this.#preexisting(rel)) {
        out.kept.add(rel)
        continue
      }
      try {
        await this.#displace(rel, ctx)
        out.displaced.add(rel)
        out.failed.delete(rel)
        for (let dir = parentOf(rel); dir !== ''; dir = parentOf(dir)) ctx.createdDirs.add(dir)
      } catch (error) {
        out.failed.set(rel, `could not move the created file aside: ${errorText(error)}`)
      }
    }
    for (const rel of sortPaths([...diff.changed, ...diff.deleted])) {
      const e = this.#entries.get(rel)
      if (e.type === 'file' && !e.copy) {
        out.failed.set(rel, 'no checkpoint copy (the file was unreadable when the checkpoint was taken)')
        continue
      }
      try {
        await this.#ensureParents(rel, ctx)
        const full = join(root, rel)
        if (await lexists(full)) {
          await this.#displace(rel, ctx)
          out.displaced.add(rel)
        }
        await this.#putBack(rel, e, ctx)
        out.restored.add(rel)
        out.failed.delete(rel)
      } catch (error) {
        out.failed.set(rel, `could not restore: ${errorText(error)}`)
      }
    }
    for (const rel of diff.retime) {
      const e = this.#entries.get(rel)
      try {
        await setTimesNs(join(root, rel), e.atimeNs, e.mtimeNs, { link: e.type === 'link' })
        out.retimed.add(rel)
      } catch {
        // Only verdict currency suffers (statusDigest moves); content and mode are already right.
      }
    }
    await this.#displaceEmptyCreatedDirs(ctx)
  }

  /** Moves directories the inspection created and left empty (born after the take) to the displaced dir. */
  async #displaceEmptyCreatedDirs(ctx) {
    const dirs = sortPaths([...ctx.createdDirs]).reverse() // deepest first
    for (const rel of dirs) {
      if (coveredBy(`${rel}/`, this.#state.ignoredDirs) || coveredBy(`${rel}/`, this.#state.blocked)) continue
      try {
        const info = await lstat(join(this.root, rel))
        if (!info.isDirectory() || !(info.birthtimeMs > this.#state.takenAtMs)) continue
        if ((await readdir(join(this.root, rel))).length !== 0) continue
        await this.#displace(rel, ctx)
        ctx.out.displaced.add(`${rel}/`)
      } catch {
        // Best effort: an empty directory left behind is harmless.
      }
    }
    ctx.createdDirs.clear()
  }

  /** Makes every parent of `rel` a real directory; a file or link in the way is moved aside first. */
  async #ensureParents(rel, ctx) {
    const parts = rel.split('/')
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix === '' ? parts[i] : `${prefix}/${parts[i]}`
      const full = join(this.root, prefix)
      let info
      try {
        info = await lstat(full)
      } catch (error) {
        if (!ABSENT.has(error?.code)) throw error
        await mkdir(full)
        continue
      }
      if (info.isDirectory()) continue
      await this.#displace(prefix, ctx)
      ctx.out.displaced.add(prefix)
      await mkdir(full)
    }
  }

  /** A free `<displacedDir>/<rel>` (or numbered alternative), its parent created; `startAt` skips earlier slots. */
  async #freeSlot(rel, ctx, startAt = 0) {
    for (let k = startAt; k < 1000; k++) {
      const target = k === 0 ? join(ctx.displacedDir, rel) : join(ctx.displacedDir, `.cc-rsi-${k}`, rel)
      try {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      } catch (error) {
        if (error?.code === 'EEXIST' || error?.code === 'ENOTDIR') continue
        throw error
      }
      if (await lexists(target)) continue
      return { target, k }
    }
    throw new CcRsiError('displace_failed', `no free place for ${rel} under ${ctx.displacedDir}`)
  }

  /** Moves `<root>/<rel>` to `<displacedDir>/<rel>` (a numbered alternative when that is taken). */
  async #displace(rel, ctx) {
    const source = join(this.root, rel)
    for (let k = 0; k < 1000; k++) {
      const slot = await this.#freeSlot(rel, ctx, k)
      k = slot.k
      try {
        await rename(source, slot.target)
        return slot.target
      } catch (error) {
        if (error?.code === 'EXDEV') {
          await this.#displaceAcross(source, slot.target, rel, ctx)
          return slot.target
        }
        if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error?.code)) continue
        throw error
      }
    }
    throw new CcRsiError('displace_failed', `no free place for ${rel} under ${ctx.displacedDir}`)
  }

  /**
   * Displacement onto another filesystem (memory-crash-6): copy, then move the source to a tombstone
   * beside it (one rename on its own filesystem, so writers by name no longer reach it) and remove the
   * tombstone only when it is unchanged since the copy; a source written meanwhile is copied to a
   * further displaced slot first. Nothing written during the move is lost.
   */
  async #displaceAcross(source, target, rel, ctx) {
    const before = await treeSignature(source)
    await copyTree(source, target)
    const tomb = join(dirname(source), `.cc-rsi-tomb-${randomBytes(6).toString('hex')}`)
    await rename(source, tomb)
    let after = null
    try {
      after = await treeSignature(tomb)
    } catch {
      after = null
    }
    if (after !== before) {
      const extra = await this.#freeSlot(rel, ctx, 1)
      await copyTree(tomb, extra.target)
    }
    await removeTree(tomb)
  }

  /**
   * Stages the checkpoint version next to its place, sets mode and times, and installs it without
   * ever replacing what appeared at the place meanwhile (memory-crash-6): a file is hard-linked into
   * place and a link created in place, both failing with EEXIST instead of replacing; a newcomer is
   * moved aside and the install retried. Without hard links (some filesystems) a fresh check right
   * before a rename is the fallback.
   */
  async #putBack(rel, e, ctx) {
    const full = join(this.root, rel)
    const clear = async () => {
      if (await lexists(full)) {
        await this.#displace(rel, ctx)
        ctx.out.displaced.add(rel)
      }
    }
    const contested = (error, attempt) => {
      if (error?.code !== 'EEXIST' || attempt >= INSTALL_ATTEMPTS) return false
      ctx.contested.add(rel)
      return true
    }
    if (e.type === 'link') {
      for (let attempt = 1; ; attempt++) {
        await clear()
        try {
          await symlink(e.link, full)
          break
        } catch (error) {
          if (!contested(error, attempt)) throw error
        }
      }
      await setTimesNs(full, e.atimeNs, e.mtimeNs, { link: true }).catch(() => undefined)
      return
    }
    const staged = await this.#stagingPath(rel, ctx)
    let made = false
    try {
      await copyFile(join(this.#dir, 'files', rel), staged, COPY_FLAGS)
      made = true
      await chmod(staged, e.mode)
      await setTimesNs(staged, e.atimeNs, e.mtimeNs)
      for (let attempt = 1; ; attempt++) {
        await clear()
        try {
          await link(staged, full)
          break
        } catch (error) {
          if (contested(error, attempt)) continue
          if (!NO_HARD_LINKS.has(error?.code)) throw error
          await clear()
          await rename(staged, full)
          made = false
          return
        }
      }
      // The restored file now has two names; drop the staging one.
      await unlink(staged).catch(() => undefined)
      made = false
    } catch (error) {
      if (made) await removeTree(staged).catch(() => undefined)
      throw error
    }
  }

  /** `<file>.cc-rsi-restore`, or a random sibling name when that is a checkpoint entry or too long. */
  async #stagingPath(rel, ctx) {
    const preferred = `${rel}${RESTORE_SUFFIX}`
    const random = () => `${parentOf(rel) === '' ? '' : `${parentOf(rel)}/`}.cc-rsi-restore-${randomBytes(6).toString('hex')}`
    let candidate = this.#entries.has(preferred) ? random() : preferred
    if (Buffer.byteLength(candidate.slice(candidate.lastIndexOf('/') + 1)) > 255) candidate = random()
    const full = join(this.root, candidate)
    if (await lexists(full)) {
      // A leftover of an interrupted restore (or a stray file): moved aside, never deleted.
      await this.#displace(candidate, ctx)
      ctx.out.displaced.add(candidate)
    }
    return full
  }

  /** Removes the checkpoint directory (entries.json and files/). */
  async dispose() {
    this.#disposed = true
    await removeTree(this.#dir)
  }
}

async function lexists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (ABSENT.has(error?.code)) return false
    throw error
  }
}

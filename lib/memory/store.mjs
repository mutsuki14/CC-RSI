// Durable, Actor-owned experience memory (SPEC §6.2-§6.6): a port of dsh-rsi
// src/memory/store.ts (MemoryStore) with the cc-rsi additions: UTF-8 key ordering, external
// draft directories with owner liveness, pullTree rules, tamper detection
// (expectedTreeHash / assertCanonicalIntact / acceptExternal / restoreHistory), the sealed
// marker, rebaseDraft, the inventory.json cache, and auditTexts.
//
// Layout under `root` (SPEC §6.2):
//   memory/                      canonical tree
//   drafts/<safeEpisode>.json    draft meta (written last, removed first; during a rebase it carries the
//                                rebase intent until the new meta replaces it); default draft dirs drafts/<safeEpisode>/
//   journal.jsonl                CommitRecord per line
//   commit.pending.json          {v:1, record} while an install is in flight
//   history/<NNNN>/              full snapshot after commit NNNN (keepHistory)
//   quarantined/<safeEpisode>    absorbing marker (ISO timestamp only)
//   reports/<sha256>.md          content-addressed Verifier reports
//   frozen.json, sealed.json, inventory.json, audit_rejects.jsonl, .lock
//   .staging-<nonce>/ .backup-<nonce>/   transient
//
// RSIAgent reference: the atomic full-tree install is explore/practice_loop.py:339-382
// (`_atomic_install_memory`: stage in the parent, fsync, rename-swap, keep a backup without a
// destination as recovery state); journal-before-install is replaced by dsh's pending marker
// (store.ts:279-297) so recovery validates canonical memory against the intended record.

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  ensureDir, exists, fsyncDir, readJsonSafe, rmrf, writeFileAtomic, writeJsonAtomic,
} from '../core/atomic.mjs'
import { compactStamp } from '../core/ids.mjs'
import { appendJsonl, readJsonl } from '../core/jsonl.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { isUnderLexical, safeName } from '../core/paths.mjs'
import { pidAlive } from '../core/proc.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { hits, loadSealedCorpus } from './audit.mjs'
import {
  MemoryConflictError, MemoryDraftMissingError, MemoryError, MemoryFrozenError, MemoryFrozenTamperError, MemoryLimitError,
  MemoryQuarantineError, MemorySealedError, MemoryTamperError, UnsafeMemoryPathError,
} from './errors.mjs'
import { EMPTY_TREE_SHA256, treeSha256FromManifest } from './hash.mjs'
import { diffManifests, listTree, loadTree, manifestOf, replaceDir, scanTree, writeTree } from './tree.mjs'

const DEFAULT_LIMITS = Object.freeze({ maxFiles: 400, maxTotalBytes: 4194304, maxFileBytes: 65536 })
const SHA256_HEX = /^[0-9a-f]{64}$/
const TERMINAL_LINEAGE = new Set(['completed', 'abandoned', 'quarantined'])
const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} })

const nonce = () => randomBytes(6).toString('hex')

/** Human limit detail, e.g. "412 files > 400; 'notes/big.md' 70211 bytes > 65536". */
function limitDetail(entries, limits) {
  const parts = []
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  if (entries.length > limits.maxFiles) parts.push(`${entries.length} files > ${limits.maxFiles}`)
  if (total > limits.maxTotalBytes) parts.push(`${total} bytes > ${limits.maxTotalBytes}`)
  const big = entries.filter(entry => entry.bytes > limits.maxFileBytes)
  for (const entry of big.slice(0, 5)) parts.push(`'${entry.rel}' ${entry.bytes} bytes > ${limits.maxFileBytes}`)
  if (big.length > 5) parts.push(`${big.length - 5} more files over ${limits.maxFileBytes} bytes`)
  return parts.join('; ')
}

/** Canonical memory and history files: owner exec bit kept, never group/world access. */
const storedMode = mode => ((mode ?? 0) & 0o100 ? 0o700 : 0o600)

/**
 * Lock-free integrity of the store at `root` (memory-crash-10: the one rule shared by MCP status,
 * the CLI and lineage resume): scans the tree, then reads commit.pending.json, then the journal; the
 * tree is intact when it equals the journal's last treeAfter, or the treeAfter of an install in
 * flight (its pending marker). A mismatch or an invalid scan is read once more after `retryMs`
 * (a commit finishing between the reads). Returns `{ expected, actual, intact, pending }`; never
 * writes and never waits for the store lock.
 */
export async function storeIntegrity(root, { retryMs = 100 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let actual
    try {
      actual = (await scanTree(join(root, 'memory'))).treeSha256
    } catch (error) {
      actual = `invalid (${error?.message ?? error})`
    }
    let pending = null
    try {
      pending = JSON.parse(await readFile(join(root, 'commit.pending.json'), 'utf8'))
    } catch {
      pending = null
    }
    let expected = EMPTY_TREE_SHA256
    for (const record of await readJsonl(join(root, 'journal.jsonl')).catch(() => [])) {
      if (record && SHA256_HEX.test(String(record.treeAfter))) expected = record.treeAfter
    }
    const intact = actual === expected || (typeof pending?.record?.treeAfter === 'string' && pending.record.treeAfter === actual)
    if (intact || attempt >= 1) return { expected, actual, intact, pending: pending !== null }
    await new Promise(resolve => setTimeout(resolve, retryMs))
  }
}

export class MemoryStore {
  #root
  #memoryDir
  #limits
  #keepHistory
  #sealedTextFiles
  #shingleWords
  #log
  #lockOptions
  #sessionsDir
  #lineagesDir
  #chain = Promise.resolve()
  #corpus = undefined
  /** The store lock while a mutation runs (fencing before irreversible steps). */
  #lock = null

  /**
   * Opens (and recovers) the store at `root` (SPEC §6.3, §6.5). Never throws on tamper:
   * callers call `assertCanonicalIntact()`.
   * Additional options (cc-rsi): `sessionsDir` (default `<root>/../sessions`) and `lineagesDir`
   * (default `<root>/../lineages`) are used only for draft-owner liveness.
   */
  static async open(root, options = {}) {
    const store = new MemoryStore(root, options)
    await store.#init()
    return store
  }

  /** Prefer `MemoryStore.open`, which also runs recovery. */
  constructor(root, {
    limits = DEFAULT_LIMITS, keepHistory = true, sealedTextFiles = [], shingleWords = 8, logger, lockOptions,
    sessionsDir, lineagesDir,
  } = {}) {
    this.#root = resolve(root)
    this.#memoryDir = join(this.#root, 'memory')
    this.#limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) }
    this.#keepHistory = keepHistory !== false
    this.#sealedTextFiles = Array.isArray(sealedTextFiles) ? [...sealedTextFiles] : []
    this.#shingleWords = shingleWords
    this.#log = logger ?? NOOP_LOGGER
    this.#lockOptions = lockOptions ?? {}
    this.#sessionsDir = sessionsDir ? resolve(sessionsDir) : join(dirname(this.#root), 'sessions')
    this.#lineagesDir = lineagesDir ? resolve(lineagesDir) : join(dirname(this.#root), 'lineages')
  }

  get root() {
    return this.#root
  }

  get memoryDir() {
    return this.#memoryDir
  }

  get limits() {
    return { ...this.#limits }
  }

  // ---------------------------------------------------------------- paths

  #path(...parts) {
    return join(this.#root, ...parts)
  }

  get #draftsDir() {
    return this.#path('drafts')
  }

  #metaPath(episode) {
    return join(this.#draftsDir, `${safeName(episode)}.json`)
  }

  #defaultDraftDir(episode) {
    return join(this.#draftsDir, safeName(episode))
  }

  #historyDir(n) {
    return this.#path('history', String(n).padStart(4, '0'))
  }

  // ---------------------------------------------------------------- serialization

  /** In-process serialization of mutations (dsh store.ts:401-406). */
  #serial(task) {
    const run = this.#chain.then(task)
    this.#chain = run.catch(() => undefined)
    return run
  }

  /** Cross-process mutation lock (SPEC §5.4; dsh store.ts:336-379). */
  async #locked(task) {
    const lock = new LeaseLock(this.#path('.lock'), { ...this.#lockOptions, owner: { kind: 'memory-store', root: this.#root } })
    await lock.acquire()
    this.#lock = lock
    try {
      return await task()
    } finally {
      this.#lock = null
      await lock.release()
    }
  }

  /** Fencing (memory-crash-1/-9): throws LockTimeoutError('lock_lost') when another process has taken the store lock over. */
  async #assertLockHeld() {
    await this.#lock?.assertHeld()
  }

  #mutation(task) {
    return this.#serial(() => this.#locked(task))
  }

  // ---------------------------------------------------------------- recovery (§6.5)

  async #init() {
    await ensureDir(this.#root)
    await this.#mutation(async () => {
      const entries = await readdir(this.#root)
      // 1. A crash between the install renames leaves a backup and no canonical tree.
      const backups = entries.filter(name => name.startsWith('.backup-'))
      if (!(await exists(this.#memoryDir))) {
        if (backups.length > 0) {
          const dated = []
          for (const name of backups) {
            const info = await lstat(this.#path(name)).catch(() => null)
            if (info?.isDirectory()) dated.push({ name, mtimeMs: info.mtimeMs })
          }
          dated.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1))
          const newest = dated.at(-1)
          if (newest) {
            await rename(this.#path(newest.name), this.#memoryDir)
            this.#log.warn('memory store: restored canonical memory from an interrupted install', { backup: newest.name })
          }
        }
        if (!(await exists(this.#memoryDir))) await mkdir(this.#memoryDir, { recursive: true, mode: 0o700 })
      }
      // 2. Transient leftovers.
      for (const name of entries) {
        if (name.startsWith('.staging-') || name.startsWith('.backup-') || (name.startsWith('.') && name.endsWith('.tmp'))) {
          await rmrf(this.#path(name))
        }
      }
      for (const name of await readdir(this.#path('history')).catch(() => [])) {
        if (name.startsWith('.tmp-')) await rmrf(this.#path('history', name))
      }
      // 3. An install in flight when the previous process stopped.
      await this.#resolvePending()
      // 4. Drafts.
      await this.#sweepDrafts()
      // 5. Inventory cache.
      try {
        const cached = await readJsonSafe(this.#path('inventory.json'), null)
        const scan = await scanTree(this.#memoryDir)
        if (!cached || cached.treeSha256 !== scan.treeSha256) await this.#writeInventory(scan)
      } catch (error) {
        // An invalid canonical tree is reported by assertCanonicalIntact, never by open.
        this.#log.warn('memory store: inventory not rebuilt', { error: error?.message })
      }
    })
  }

  /**
   * Finishes an install whose tree reached canonical before its journal record, or drops one that
   * never installed (dsh store.ts:279-297). A torn marker is removed; an unreadable canonical tree
   * leaves the marker for a later recovery.
   */
  async #resolvePending() {
    const path = this.#path('commit.pending.json')
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    let pending = null
    try {
      pending = JSON.parse(text)
    } catch {
      pending = null
    }
    const record = pending?.v === 1 ? pending.record : null
    if (record && typeof record.episode === 'string' && SHA256_HEX.test(String(record.treeAfter))) {
      let actual
      try {
        actual = await this.treeHash()
      } catch (error) {
        this.#log.warn('memory store: pending commit left unresolved (canonical tree unreadable)', { error: error?.message })
        return
      }
      if (actual === record.treeAfter) {
        await this.#journalize(record)
        const committed = (await this.journal()).find(entry => entry.episode === record.episode)
        await this.#ensureHistory(committed ?? record)
        await this.#writeInventory(await scanTree(this.#memoryDir))
        await this.#discard(record.episode)
        this.#log.warn('memory store: finished an interrupted commit', { episode: record.episode })
      } else {
        this.#log.warn('memory store: dropped a commit that never installed', { episode: record.episode })
      }
    }
    await rm(path, { force: true })
    await fsyncDir(this.#root)
  }

  /** Whether a draft owner may still use its draft (SPEC §6.5 step 4, plus paused lineages). */
  async #ownerLive(owner) {
    if (!owner || typeof owner !== 'object') return true
    if (owner.kind === 'engine') {
      if (typeof owner.host === 'string' && owner.host !== hostname()) return true
      if (!Number.isInteger(owner.pid) || owner.pid === process.pid || pidAlive(owner.pid)) return true
      // The engine exited. A paused (non-terminal) lineage resumes this draft (SPEC §12.8).
      if (typeof owner.lineage === 'string' && owner.lineage !== '') {
        const lineagesDir = typeof owner.lineagesDir === 'string' ? owner.lineagesDir : this.#lineagesDir
        const state = await readJsonSafe(join(lineagesDir, safeName(owner.lineage), 'state.json'), null)
        if (state && typeof state.status === 'string' && !TERMINAL_LINEAGE.has(state.status)) return true
      }
      return false
    }
    if (owner.kind === 'session') {
      if (typeof owner.sessionId !== 'string' || owner.sessionId === '') return true
      const sessionsDir = typeof owner.sessionsDir === 'string' ? owner.sessionsDir : this.#sessionsDir
      // Without a sessions directory liveness is unknown: keep the draft.
      if (!(await exists(sessionsDir))) return true
      return exists(join(sessionsDir, safeName(owner.sessionId)))
    }
    return true
  }

  async #sweepDrafts() {
    const names = await readdir(this.#draftsDir).catch(() => [])
    if (names.length === 0) return
    const committed = new Set((await this.journal()).map(record => record.episode))
    const keep = new Set()
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await rm(join(this.#draftsDir, name), { force: true, recursive: true })
        continue
      }
      if (!name.endsWith('.json')) continue
      const meta = await this.#readMeta(join(this.#draftsDir, name))
      // A live owner keeps its meta (and .prev) even while its directory is momentarily missing,
      // e.g. while the Actor rebuilds it or mid-rebase (memory-crash-4): only a committed episode,
      // a gone owner or a corrupt meta is swept.
      if (meta && !committed.has(meta.episode) && (await this.#ownerLive(meta.owner))) {
        keep.add(name)
        if (isUnderLexical(meta.dir, this.#draftsDir)) {
          keep.add(meta.dir.slice(this.#draftsDir.length + 1).split('/')[0])
          keep.add(`${meta.dir.slice(this.#draftsDir.length + 1).split('/')[0]}.prev`)
        }
        continue
      }
      await rm(join(this.#draftsDir, name), { force: true })
      if (meta) {
        await this.#removeDraftDir(meta.dir)
        await this.#removeDraftDir(`${meta.dir}.prev`)
        this.#log.info('memory store: swept a draft', { episode: meta.episode, dir: meta.dir })
      }
    }
    for (const name of names) {
      if (name.endsWith('.json') || name.endsWith('.tmp') || keep.has(name)) continue
      await rmrf(join(this.#draftsDir, name))
    }
  }

  async #readMeta(path) {
    const meta = await readJsonSafe(path, null)
    if (!meta || meta.v !== 1 || typeof meta.episode !== 'string' || !SHA256_HEX.test(String(meta.baseHash))) return null
    const dir = typeof meta.dir === 'string' && meta.dir !== '' ? resolve(meta.dir) : this.#defaultDraftDir(meta.episode)
    const out = {
      ...meta,
      dir,
      baseManifest: meta.baseManifest && typeof meta.baseManifest === 'object' ? meta.baseManifest : {},
      owner: meta.owner ?? null,
    }
    // A rebase intent (memory-crash-5): the identity of the draft directory being moved to `.prev`.
    if (out.rebase !== undefined && (!out.rebase || typeof out.rebase !== 'object' || typeof out.rebase.dirIno !== 'string')) delete out.rebase
    return out
  }

  /** Whether a draft directory may be deleted: never canonical memory, history, the store itself, home or their ancestors. */
  #removable(dir) {
    const target = resolve(dir)
    if (target === '/' || target === resolve(homedir())) return false
    if (isUnderLexical(this.#root, target)) return false
    if (isUnderLexical(homedir(), target)) return false
    if (isUnderLexical(target, this.#memoryDir) || isUnderLexical(target, this.#path('history'))) return false
    if (isUnderLexical(target, this.#root) && !isUnderLexical(target, this.#draftsDir)) return false
    if (target === this.#draftsDir) return false
    return true
  }

  async #removeDraftDir(dir) {
    if (!dir || !this.#removable(dir)) return
    const info = await lstat(dir).catch(() => null)
    if (info === null) return
    if (info.isSymbolicLink()) await unlink(dir).catch(() => undefined)
    else await rmrf(dir)
  }

  // ---------------------------------------------------------------- reads

  /** tree_sha256 of canonical memory (scanTree). Throws UnsafeMemoryPathError for an invalid tree. */
  async treeHash() {
    return (await scanTree(this.#memoryDir)).treeSha256
  }

  /** Lock-free integrity (storeIntegrity): `{ expected, actual, intact, pending }`. */
  async integrity({ retryMs = 100 } = {}) {
    return storeIntegrity(this.#root, { retryMs })
  }

  /** The last journal record's treeAfter, else EMPTY_TREE_SHA256. */
  async expectedTreeHash() {
    const records = await this.journal()
    for (let i = records.length - 1; i >= 0; i--) {
      if (SHA256_HEX.test(String(records[i].treeAfter))) return records[i].treeAfter
    }
    return EMPTY_TREE_SHA256
  }

  async #compare() {
    const expected = await this.expectedTreeHash()
    let actual
    try {
      actual = await this.treeHash()
    } catch (error) {
      actual = `invalid (${error?.message ?? error})`
    }
    return { expected, actual, ok: expected === actual }
  }

  /**
   * Throws MemoryTamperError{expected, actual} when canonical memory differs from the last
   * journal treeAfter (SPEC §6.6). A mismatch is re-checked under the store lock after resolving
   * an interrupted install, so a commit in flight in another process is never reported as tamper.
   */
  async assertCanonicalIntact() {
    const first = await this.#compare()
    if (first.ok) return
    await this.#mutation(async () => {
      await this.#resolvePending()
      const again = await this.#compare()
      if (!again.ok) throw new MemoryTamperError({ expected: again.expected, actual: again.actual })
    })
  }

  async #assertIntactLocked() {
    const result = await this.#compare()
    if (!result.ok) throw new MemoryTamperError({ expected: result.expected, actual: result.actual })
  }

  async #writeInventory(scan) {
    const files = Object.entries(scan.files).map(([path, entry]) => ({ path, bytes: entry.bytes }))
    const value = {
      v: 1,
      treeSha256: scan.treeSha256,
      files,
      totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
      at: new Date().toISOString(),
    }
    await writeJsonAtomic(this.#path('inventory.json'), value)
    return value
  }

  /**
   * `{treeSha256, files:[{path, bytes}], totalBytes, at}` from the inventory.json cache (cheap,
   * lock-free; hooks use it), or rebuilt from canonical memory under the lock when `refresh` is
   * set or the cache is missing.
   */
  async inventory({ refresh = false } = {}) {
    if (!refresh) {
      const cached = await readJsonSafe(this.#path('inventory.json'), null)
      if (cached && cached.v === 1 && SHA256_HEX.test(String(cached.treeSha256)) && Array.isArray(cached.files)) {
        return { treeSha256: cached.treeSha256, files: cached.files, totalBytes: cached.totalBytes, at: cached.at }
      }
    }
    const value = await this.#mutation(async () => this.#writeInventory(await scanTree(this.#memoryDir)))
    return { treeSha256: value.treeSha256, files: value.files, totalBytes: value.totalBytes, at: value.at }
  }

  /** Every journal record (torn lines skipped; dsh store.ts:717-730). */
  async journal() {
    return (await readJsonl(this.#path('journal.jsonl'))).filter(record => record && typeof record === 'object' && typeof record.episode === 'string')
  }

  /** The commit of an episode, or of the episode whose origin verdict this is (dsh store.ts:610-613). */
  async findCommit(episodeOrOrigin) {
    return (await this.journal()).find(record => record.episode === episodeOrOrigin || (record.origin != null && record.origin === episodeOrOrigin))
  }

  /** Whether the silent audit refused this episode's learning phase (absorbing). */
  async isQuarantined(episode) {
    return exists(this.#path('quarantined', safeName(episode)))
  }

  // ---------------------------------------------------------------- drafts

  #draftOf(meta) {
    return {
      episode: meta.episode,
      dir: meta.dir,
      baseHash: meta.baseHash,
      baseManifest: meta.baseManifest,
      createdAt: meta.createdAt,
      owner: meta.owner,
    }
  }

  /**
   * Every draft meta (cc-rsi addition for `doctor` and `cc-rsi memory drafts`):
   * `[{episode, dir, baseHash, createdAt, owner, dirExists, live, committed, rebasing}]`, sorted by episode
   * (`rebasing`: an interrupted rebase the next rebaseDraft or openDraft finishes).
   * Read-only; prune with `discardDraft`.
   */
  async drafts() {
    const names = (await readdir(this.#draftsDir).catch(() => [])).filter(name => name.endsWith('.json'))
    const committed = new Set((await this.journal()).map(record => record.episode))
    const out = []
    for (const name of names) {
      const meta = await this.#readMeta(join(this.#draftsDir, name))
      if (!meta) continue
      out.push({
        episode: meta.episode,
        dir: meta.dir,
        baseHash: meta.baseHash,
        createdAt: meta.createdAt ?? null,
        owner: meta.owner,
        dirExists: await exists(meta.dir),
        live: await this.#ownerLive(meta.owner),
        committed: committed.has(meta.episode),
        rebasing: Boolean(meta.rebase),
      })
    }
    return out.sort((a, b) => (a.episode < b.episode ? -1 : a.episode > b.episode ? 1 : 0))
  }

  /** The draft for `episode` when its meta is valid, no rebase of it is pending and its directory exists. */
  async getDraft(episode) {
    const meta = await this.#readMeta(this.#metaPath(episode))
    if (!meta || meta.episode !== episode || meta.rebase || !(await exists(meta.dir))) return undefined
    return this.#draftOf(meta)
  }

  async #learningGate(episode) {
    if (await this.frozen()) throw new MemoryFrozenError({ episode })
    const sealed = await this.sealed()
    if (sealed && sealed.learningAfterSealed !== true) throw new MemorySealedError({ episode })
    if (await this.isQuarantined(episode)) throw new MemoryQuarantineError({ episode })
  }

  #checkDraftDir(dir) {
    const target = resolve(dir)
    if (isUnderLexical(this.#root, target)) throw new UnsafeMemoryPathError({ path: target, reason: 'a draft directory must not contain the memory store' })
    if (isUnderLexical(target, this.#root) && (!isUnderLexical(target, this.#draftsDir) || target === this.#draftsDir)) {
      throw new UnsafeMemoryPathError({ path: target, reason: 'a draft directory must not be inside the memory store' })
    }
    if (!this.#removable(target)) throw new UnsafeMemoryPathError({ path: target, reason: 'this directory cannot hold a memory draft' })
    return target
  }

  /**
   * Opens the learning draft of `episode` (SPEC §6.3): a writable copy of canonical memory in
   * `dir` (default `<root>/drafts/<safeEpisode>`). Refuses when frozen, sealed (without
   * learningAfterSealed) or quarantined. `fresh` discards an existing draft first; an existing
   * draft with the same dir is reused (its owner refreshed when one is given), and an interrupted
   * rebase of it is finished first (its previous draft stays in `.prev`).
   * `owner` = `{kind: 'engine'|'session', pid?, host?, sessionId?, lineage?}`.
   */
  openDraft(episode, { dir, fresh = false, owner } = {}) {
    return this.#mutation(() => this.#openDraft(episode, { dir, fresh, owner }))
  }

  #normalizeOwner(owner) {
    if (!owner || typeof owner !== 'object') return null
    const out = { ...owner }
    // SPEC §6.2 owner shape {kind, pid, host, sessionId?, lineage?}; pid/host default to this process.
    if (!Number.isInteger(out.pid)) out.pid = process.pid
    if (typeof out.host !== 'string') out.host = hostname()
    if (out.kind === 'engine') {
      if (typeof out.lineage === 'string' && typeof out.lineagesDir !== 'string') out.lineagesDir = this.#lineagesDir
    } else if (out.kind === 'session') {
      if (typeof out.sessionsDir !== 'string') out.sessionsDir = this.#sessionsDir
    }
    return out
  }

  /**
   * `reuse: false` always copies canonical memory afresh; `keepMeta` (rebase only) leaves the
   * current meta, which carries the rebase intent, in place until the new meta replaces it.
   */
  async #openDraft(episode, { dir, fresh, owner, reuse = true, keepMeta = false }) {
    if (typeof episode !== 'string' || episode === '') throw new MemoryError('memory_episode', 'a memory draft needs a non-empty episode id')
    await this.#learningGate(episode)
    const target = this.#checkDraftDir(dir ? resolve(dir) : this.#defaultDraftDir(episode))
    const normalizedOwner = this.#normalizeOwner(owner)
    if (fresh) await this.#discard(episode)
    const metaPath = this.#metaPath(episode)
    const existing = await this.#readMeta(metaPath)
    if (!keepMeta && existing?.rebase && existing.episode === episode && existing.dir === target) {
      // An interrupted rebase of this draft (memory-crash-5): finish it, never copy over the Actor's draft.
      return (await this.#finishRebase(existing, { owner: normalizedOwner ?? existing.owner })).draft
    }
    if (reuse && existing && existing.episode === episode && !existing.rebase && existing.dir === target && (await exists(target))) {
      if (normalizedOwner && JSON.stringify(normalizedOwner) !== JSON.stringify(existing.owner)) {
        const { dir: _dir, ...rest } = existing
        await writeJsonAtomic(metaPath, { ...rest, dir: target, owner: normalizedOwner })
        existing.owner = normalizedOwner
      }
      return this.#draftOf(existing)
    }
    // A different or incomplete earlier draft is discarded before the copy (metadata first).
    // Its `.prev` is kept: rebaseDraft has just created it for this new draft.
    if (!keepMeta) await rm(metaPath, { force: true })
    if (existing && existing.dir !== target) await this.#removeDraftDir(existing.dir)
    const info = await lstat(target).catch(() => null)
    if (info?.isSymbolicLink()) throw new UnsafeMemoryPathError({ path: target, reason: 'a draft directory must not be a symlink' })
    const tree = await loadTree(this.#memoryDir)
    const contents = {}
    for (const [rel, { data }] of Object.entries(tree)) contents[rel] = data
    // The copy is built in a sibling and swapped in (r3-engine-concurrency-4): a crash leaves no
    // directory or a complete canonical copy at `target`, never a partial one that a lost-draft
    // repair would take for the Actor's work; the next replaceDir of `target` sweeps the sibling.
    await replaceDir(target, staging => writeTree(staging, contents, { fileMode: rel => storedMode(tree[rel].mode), dirMode: 0o700 }))
    const baseManifest = manifestOf(contents)
    const meta = {
      v: 1,
      episode,
      dir: target,
      baseHash: treeSha256FromManifest(baseManifest),
      baseManifest,
      createdAt: new Date().toISOString(),
      owner: normalizedOwner,
    }
    await writeJsonAtomic(metaPath, meta)
    return this.#draftOf(meta)
  }

  /** Discards a draft: metadata first, then its directory (never canonical memory or history). */
  discardDraft(episode) {
    return this.#mutation(() => this.#discard(episode))
  }

  /** Metadata first: a crash mid-delete leaves a directory recovery removes, never a reopenable partial draft (dsh store.ts:628-635). */
  async #discard(episode) {
    const metaPath = this.#metaPath(episode)
    const meta = await this.#readMeta(metaPath)
    await rm(metaPath, { force: true })
    const dirs = new Set([this.#defaultDraftDir(episode)])
    if (meta?.dir) dirs.add(meta.dir)
    for (const dir of dirs) {
      await this.#removeDraftDir(dir)
      await this.#removeDraftDir(`${dir}.prev`)
    }
  }

  /**
   * After a conflict: moves the draft dir to `<dir>.prev` (replacing an older .prev) and opens a
   * fresh draft of the current canonical memory in the same dir with the same owner, so the
   * same Actor can merge its previous draft into it (SPEC §6.3, §12.8).
   *
   * Crash-recoverable at every step (memory-crash-5): the meta first records the intent (the
   * identity of the directory being moved) and keeps it until the new draft's meta replaces it;
   * the next rebaseDraft or openDraft of the episode finishes an interrupted rebase. Idempotent: a
   * draft still equal to its base beside an existing `.prev` (a re-run after a crash, or a second
   * conflict before the Actor changed anything) keeps that `.prev` and is only refreshed.
   */
  rebaseDraft(episode) {
    return this.#mutation(async () => {
      const metaPath = this.#metaPath(episode)
      const meta = await this.#readMeta(metaPath)
      if (!meta || meta.episode !== episode) throw new MemoryDraftMissingError({ episode })
      // Refuse before touching the draft, so a refused rebase never loses it.
      await this.#learningGate(episode)
      if (meta.rebase) return this.#finishRebase(meta)
      if (!(await exists(meta.dir))) throw new MemoryDraftMissingError({ episode })
      const prevDir = `${meta.dir}.prev`
      const keepPrev = (await exists(prevDir)) && (await this.#pristine(meta))
      if (keepPrev && (await this.treeHash()) === meta.baseHash) return { prevDir, draft: this.#draftOf(meta) }
      const info = await lstat(meta.dir, { bigint: true })
      const intent = { ...meta, rebase: { prevDir, dirIno: String(info.ino), keepPrev, at: new Date().toISOString() } }
      await writeJsonAtomic(metaPath, intent)
      return this.#finishRebase(intent)
    })
  }

  /** Whether a draft still holds exactly the tree it was opened from. */
  async #pristine(meta) {
    try {
      return (await scanTree(meta.dir)).treeSha256 === meta.baseHash
    } catch {
      return false
    }
  }

  /**
   * Finishes the rebase recorded in `meta.rebase`: unless `.prev` already is the directory the
   * intent names (or the intent keeps `.prev`), the draft directory replaces the older `.prev`;
   * then a fresh draft is opened in its place and its meta replaces the intent.
   */
  async #finishRebase(meta, { owner } = {}) {
    const intent = meta.rebase
    const prevDir = `${meta.dir}.prev`
    if (intent.keepPrev !== true) {
      const prevInfo = await lstat(prevDir, { bigint: true }).catch(() => null)
      const moved = prevInfo !== null && String(prevInfo.ino) === intent.dirIno
      if (!moved) {
        if (!(await exists(meta.dir))) throw new MemoryDraftMissingError({ episode: meta.episode })
        await this.#removeDraftDir(prevDir)
        await rename(meta.dir, prevDir)
      }
    }
    const draft = await this.#openDraft(meta.episode, { dir: meta.dir, fresh: false, owner: owner ?? meta.owner, reuse: false, keepMeta: true })
    return { prevDir, draft }
  }

  // ---------------------------------------------------------------- commit (§6.4)

  async #corpusFor() {
    if (this.#corpus === undefined) this.#corpus = await loadSealedCorpus(this.#sealedTextFiles, this.#shingleWords)
    return this.#corpus
  }

  async #quarantine(ids) {
    for (const id of ids) {
      if (typeof id === 'string' && id !== '') {
        await writeFileAtomic(this.#path('quarantined', safeName(id)), `${new Date().toISOString()}\n`)
      }
    }
  }

  #nextSeq(records) {
    let max = 0
    records.forEach((record, index) => {
      const seq = Number.isInteger(record.seq) ? record.seq : index + 1
      if (seq > max) max = seq
    })
    return max + 1
  }

  /**
   * Promotes the draft of `episode` as the new canonical tree (SPEC §6.4): validates, journals
   * through a pending marker, installs with stage-and-rename, snapshots history, rewrites the
   * inventory and discards the draft. Idempotent by episode and by origin.
   */
  commit(episode, { kind, outcome = null, origin = null, lineage = null } = {}) {
    return this.#mutation(() => this.#commit(episode, { kind, outcome, origin, lineage }))
  }

  async #commit(episode, { kind, outcome, origin, lineage }) {
    // 1. Refusals. An interrupted install is resolved first so it is never mistaken for tamper.
    if (await this.frozen()) throw new MemoryFrozenError({ episode })
    const sealed = await this.sealed()
    if (sealed && sealed.learningAfterSealed !== true) throw new MemorySealedError({ episode })
    await this.#resolvePending()
    await this.#assertIntactLocked()
    // 3. The same experience is promoted once: by episode, and by the verdict it came from.
    const journal = await this.journal()
    const already = journal.find(record => record.episode === episode
      || (origin != null && (record.origin === origin || record.episode === origin)))
    if (already) {
      await this.#discard(episode)
      return already
    }
    // 4. Draft and quarantine.
    const meta = await this.#readMeta(this.#metaPath(episode))
    if (meta && meta.episode === episode && meta.rebase) {
      // Its rebase was interrupted (memory-crash-5): rebaseDraft finishes it; nothing is promoted.
      throw new MemoryConflictError({ baseHash: meta.baseHash, currentHash: await this.treeHash(), episode })
    }
    if (!meta || meta.episode !== episode || !(await exists(meta.dir))) throw new MemoryDraftMissingError({ episode })
    if ((await this.isQuarantined(episode)) || (origin != null && (await this.isQuarantined(origin)))) {
      throw new MemoryQuarantineError({ episode })
    }
    // 5-6. Pull (rejecting unsafe trees) with limits checked before reading and again after.
    const listed = await listTree(meta.dir)
    const before = limitDetail(listed, this.#limits)
    if (before) throw new MemoryLimitError({ detail: before, episode })
    const tree = await loadTree(meta.dir)
    const contents = {}
    for (const [rel, { data }] of Object.entries(tree)) contents[rel] = data
    const pulled = Object.entries(contents).map(([rel, data]) => ({ rel, bytes: data.length }))
    const after = limitDetail(pulled, this.#limits)
    if (after) throw new MemoryLimitError({ detail: after, episode })
    // 7. Silent audit: quarantine is durable before the draft goes.
    const corpus = await this.#corpusFor()
    if (corpus) {
      const flagged = Object.entries(contents)
        .filter(([, data]) => hits(corpus, data.toString('utf8'), this.#shingleWords))
        .map(([rel]) => rel)
      if (flagged.length > 0) {
        await this.#quarantine([episode, origin])
        for (const file of flagged) {
          await appendJsonl(this.#path('audit_rejects.jsonl'), {
            ts: new Date().toISOString(), episode, lineage: lineage ?? undefined, surface: 'commit', file, kinds: ['shingle'],
          })
        }
        await this.#discard(episode)
        this.#log.warn('memory store: learning phase quarantined', { episode })
        throw new MemoryQuarantineError({ episode })
      }
    }
    // 8. Conflict: the draft's base must still be canonical.
    const canonical = await scanTree(this.#memoryDir)
    if (canonical.treeSha256 !== meta.baseHash) {
      throw new MemoryConflictError({ baseHash: meta.baseHash, currentHash: canonical.treeSha256, episode })
    }
    // 9. Record.
    const manifest = manifestOf(contents)
    const delta = diffManifests(canonical.files, manifest)
    const record = {
      v: 1,
      seq: this.#nextSeq(journal),
      episode,
      origin: origin ?? null,
      kind,
      outcome: outcome ?? null,
      lineage: lineage ?? null,
      ts: new Date().toISOString(),
      files: pulled.length,
      bytes: pulled.reduce((sum, entry) => sum + entry.bytes, 0),
      treeBefore: canonical.treeSha256,
      treeAfter: treeSha256FromManifest(manifest),
      created: delta.created,
      modified: delta.modified,
      deleted: delta.deleted,
    }
    // 10. Install.
    await this.#install(contents, record, rel => storedMode(tree[rel].mode))
    await this.#discard(episode)
    return record
  }

  /**
   * Atomic full-tree install + journal (SPEC §6.4 step 10; RSIAgent practice_loop.py:339-382,
   * dsh store.ts:693-714): staging written and fsync'd, pending marker, rename-swap, journal,
   * history, inventory, then the marker and the backup are removed.
   */
  async #install(contents, record, fileMode) {
    const id = `${compactStamp()}-${nonce()}`
    const staging = this.#path(`.staging-${id}`)
    const backup = this.#path(`.backup-${id}`)
    const pendingPath = this.#path('commit.pending.json')
    try {
      await writeTree(staging, contents, { fileMode, dirMode: 0o700, fsync: true })
      // Never install under a lock another process has taken over (memory-crash-1/-9).
      await this.#assertLockHeld()
    } catch (error) {
      await rmrf(staging).catch(() => undefined)
      throw error
    }
    await writeJsonAtomic(pendingPath, { v: 1, record })
    let moved = false
    try {
      if (await exists(this.#memoryDir)) {
        await rename(this.#memoryDir, backup)
        moved = true
      }
      await rename(staging, this.#memoryDir)
    } catch (error) {
      if (moved && !(await exists(this.#memoryDir))) await rename(backup, this.#memoryDir).catch(() => undefined)
      await rmrf(staging).catch(() => undefined)
      await rm(pendingPath, { force: true })
      throw error
    }
    await fsyncDir(this.#root)
    await this.#journalize(record)
    await this.#ensureHistory(record)
    await this.#writeInventory(await scanTree(this.#memoryDir))
    await rm(pendingPath, { force: true })
    await rmrf(backup)
    await fsyncDir(this.#root)
  }

  /** Appends a record once per episode, newline-safe after a torn tail (dsh store.ts:300-320). */
  async #journalize(record) {
    if ((await this.journal()).some(entry => entry.episode === record.episode)) return false
    await appendJsonl(this.#path('journal.jsonl'), record)
    return true
  }

  /** history/<NNNN> = canonical memory after commit NNNN, written once (keepHistory). */
  async #ensureHistory(record) {
    if (!this.#keepHistory || !Number.isInteger(record?.seq)) return
    const target = this.#historyDir(record.seq)
    if (await exists(target)) return
    const tree = await loadTree(this.#memoryDir)
    const contents = {}
    for (const [rel, { data }] of Object.entries(tree)) contents[rel] = data
    const tmp = this.#path('history', `.tmp-${nonce()}`)
    await mkdir(this.#path('history'), { recursive: true, mode: 0o700 })
    try {
      await writeTree(tmp, contents, { fileMode: rel => storedMode(tree[rel].mode), dirMode: 0o700, fsync: true })
      await rename(tmp, target)
    } catch (error) {
      await rmrf(tmp).catch(() => undefined)
      if (!(await exists(target))) throw error
    }
  }

  // ---------------------------------------------------------------- audit of other surfaces

  /**
   * Audits texts that are not memory files (wave decisions, notes, fixtures; SPEC §12.12).
   * Returns true on a hit and appends `{ts, episode?, lineage?, surface, kinds}` to
   * audit_rejects.jsonl (never the matched content); writes nothing else.
   */
  async auditTexts(texts, { surface, lineage, episode } = {}) {
    const corpus = await this.#corpusFor()
    if (!corpus) return false
    const hit = (texts ?? []).some(text => typeof text === 'string' && hits(corpus, text, this.#shingleWords))
    if (hit) {
      await appendJsonl(this.#path('audit_rejects.jsonl'), {
        ts: new Date().toISOString(), episode: episode ?? undefined, lineage: lineage ?? undefined, surface: surface ?? 'text', kinds: ['shingle'],
      })
    }
    return hit
  }

  // ---------------------------------------------------------------- freeze / seal

  /** The freeze record, or null. */
  async frozen() {
    const record = await readJsonSafe(this.#path('frozen.json'), null)
    if (!record || typeof record !== 'object') return (await exists(this.#path('frozen.json'))) ? { treeHash: null, frozenAt: null, by: null } : null
    return { treeHash: record.treeHash ?? null, frozenAt: record.frozenAt ?? null, by: record.by ?? null }
  }

  /**
   * Freezes the current tree for Phase-3 reuse (drafts can no longer be opened or committed).
   * Canonical memory must be intact (a tampered tree is never blessed by a freeze). Idempotent:
   * an existing freeze is returned unchanged.
   */
  freeze({ by = null } = {}) {
    return this.#mutation(async () => {
      const current = await this.frozen()
      if (current && current.treeHash) return { treeHash: current.treeHash }
      await this.#resolvePending()
      await this.#assertIntactLocked()
      const treeHash = await this.treeHash()
      await writeJsonAtomic(this.#path('frozen.json'), { v: 1, treeHash, frozenAt: new Date().toISOString(), by })
      return { treeHash }
    })
  }

  /**
   * Removes the freeze after checking the frozen tree is intact. While sealed, only
   * `afterSealed` (the human `--after-sealed` path) may unfreeze; it records learningAfterSealed.
   */
  unfreeze({ afterSealed = false } = {}) {
    return this.#mutation(async () => {
      const sealed = await this.sealed()
      if (sealed && sealed.learningAfterSealed !== true && !afterSealed) throw new MemorySealedError({})
      if (await this.frozen()) await this.#assertFrozenIntact()
      if (sealed && afterSealed) await writeJsonAtomic(this.#path('sealed.json'), { ...sealed, v: 1, learningAfterSealed: true })
      await rm(this.#path('frozen.json'), { force: true })
      await fsyncDir(this.#root)
    })
  }

  async #assertFrozenIntact() {
    const record = await this.frozen()
    if (!record) throw new MemoryError('memory_not_frozen', 'memory is not frozen')
    let actual
    try {
      actual = await this.treeHash()
    } catch (error) {
      actual = `invalid (${error?.message ?? error})`
    }
    if (record.treeHash !== actual) throw new MemoryFrozenTamperError({ expected: record.treeHash, actual })
  }

  /** Throws MemoryFrozenTamperError when the frozen tree changed (MemoryError 'memory_not_frozen' when not frozen). */
  async assertFrozenIntact() {
    await this.#assertFrozenIntact()
  }

  /** The sealed marker `{v, runs:[{lineage, runId, at}], learningAfterSealed}`, or null. */
  async sealed() {
    const record = await readJsonSafe(this.#path('sealed.json'), null)
    if (record && typeof record === 'object') {
      return { v: 1, runs: Array.isArray(record.runs) ? record.runs : [], learningAfterSealed: record.learningAfterSealed === true }
    }
    // An unreadable marker still seals (fail closed).
    return (await exists(this.#path('sealed.json'))) ? { v: 1, runs: [], learningAfterSealed: false } : null
  }

  /** Records a sealed evaluation run; learning is closed again until `unfreeze({afterSealed:true})`. */
  markSealed({ lineage, runId } = {}) {
    return this.#mutation(async () => {
      const current = (await this.sealed()) ?? { v: 1, runs: [], learningAfterSealed: false }
      const runs = [...current.runs, { lineage: lineage ?? null, runId: runId ?? null, at: new Date().toISOString() }]
      await writeJsonAtomic(this.#path('sealed.json'), { v: 1, runs, learningAfterSealed: false })
    })
  }

  // ---------------------------------------------------------------- reports

  /** Stores a Verifier report by content; returns its sha256. */
  async putReport(text) {
    const body = String(text)
    const digest = sha256Hex(Buffer.from(body, 'utf8'))
    const path = this.#path('reports', `${digest}.md`)
    if ((await this.getReport(digest)) === undefined) await writeFileAtomic(path, body)
    return digest
  }

  /** The report with this digest, or undefined when missing or altered (re-hashed on read). */
  async getReport(sha) {
    if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) return undefined
    try {
      const data = await readFile(this.#path('reports', `${sha}.md`))
      return sha256Hex(data) === sha ? data.toString('utf8') : undefined
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------- tamper remedies (§6.6)

  async #historyManifestFor(treeHash) {
    if (treeHash === EMPTY_TREE_SHA256) return {}
    const records = await this.journal()
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].treeAfter === treeHash && Number.isInteger(records[i].seq)) {
        try {
          const scan = await scanTree(this.#historyDir(records[i].seq))
          if (scan.treeSha256 === treeHash) return scan.files
        } catch {
          // fall through
        }
      }
    }
    return null
  }

  /**
   * Accepts the current canonical tree after an external change (human-only remedy): journals
   * kind 'external' with treeBefore = expected and treeAfter = actual. Returns null when the
   * tree is already intact. An invalid tree (symlink, unsafe name) is refused. While frozen, only
   * a return to the frozen tree is accepted (memory-crash-8): a mutation of frozen memory is never
   * journaled; `restoreHistory` reinstates the frozen tree.
   */
  acceptExternal({ by = null } = {}) {
    return this.#mutation(async () => {
      await this.#resolvePending()
      const expected = await this.expectedTreeHash()
      const scan = await scanTree(this.#memoryDir)
      if (scan.treeSha256 === expected) return null
      const frozen = await this.frozen()
      if (frozen && scan.treeSha256 !== frozen.treeHash) throw await this.#frozenRefusal('accept-external', scan.treeSha256)
      await this.#assertLockHeld()
      const journal = await this.journal()
      const prior = await this.#historyManifestFor(expected)
      const delta = prior ? diffManifests(prior, scan.files) : { created: [], modified: [], deleted: [] }
      const files = Object.values(scan.files)
      const record = {
        v: 1,
        seq: this.#nextSeq(journal),
        episode: `external-${compactStamp()}-${nonce()}`,
        origin: null,
        kind: 'external',
        outcome: null,
        lineage: null,
        ts: new Date().toISOString(),
        files: files.length,
        bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
        treeBefore: expected,
        treeAfter: scan.treeSha256,
        created: delta.created,
        modified: delta.modified,
        deleted: delta.deleted,
        by,
        ...(prior ? {} : { deltaUnknown: true }),
      }
      await this.#journalize(record)
      await this.#ensureHistory(record)
      await this.#writeInventory(scan)
      return record
    })
  }

  /**
   * Installs history/<NNNN> as canonical memory atomically and journals kind 'restore'
   * (human-only remedy). Refused when sealed without learningAfterSealed, and while frozen unless
   * the snapshot is the frozen tree itself (the way back from a mutation of frozen memory,
   * memory-crash-8).
   */
  restoreHistory(n, { by = null } = {}) {
    return this.#mutation(async () => {
      const frozen = await this.frozen()
      const seq = Number(n)
      const source = Number.isInteger(seq) && seq > 0 ? this.#historyDir(seq) : null
      if (frozen) {
        let snapshot = null
        try {
          snapshot = source && (await exists(source)) ? (await scanTree(source)).treeSha256 : null
        } catch {
          snapshot = null
        }
        if (snapshot === null || snapshot !== frozen.treeHash) throw await this.#frozenRefusal('restore', snapshot, { n })
      } else {
        const sealed = await this.sealed()
        if (sealed && sealed.learningAfterSealed !== true) throw new MemorySealedError({})
      }
      if (!source || !(await exists(source))) throw new MemoryError('memory_history_missing', `no memory history snapshot ${n}`, { n })
      await this.#resolvePending()
      const tree = await loadTree(source)
      const contents = {}
      for (const [rel, { data }] of Object.entries(tree)) contents[rel] = data
      let current = { files: {}, treeSha256: null }
      try {
        current = await scanTree(this.#memoryDir)
      } catch (error) {
        current = { files: {}, treeSha256: `invalid (${error?.message ?? error})` }
      }
      const manifest = manifestOf(contents)
      const delta = diffManifests(current.files, manifest)
      const journal = await this.journal()
      const record = {
        v: 1,
        seq: this.#nextSeq(journal),
        episode: `restore-${String(seq).padStart(4, '0')}-${compactStamp()}-${nonce()}`,
        origin: null,
        kind: 'restore',
        outcome: null,
        lineage: null,
        ts: new Date().toISOString(),
        files: Object.keys(contents).length,
        bytes: Object.values(contents).reduce((sum, data) => sum + data.length, 0),
        treeBefore: current.treeSha256,
        treeAfter: treeSha256FromManifest(manifest),
        created: delta.created,
        modified: delta.modified,
        deleted: delta.deleted,
        restoredFrom: seq,
        by,
      }
      await this.#install(contents, record, rel => storedMode(tree[rel].mode))
      return record
    })
  }

  /** The newest journaled seq whose history snapshot is `treeHash`, or null. */
  async #snapshotSeqOf(treeHash) {
    const records = await this.journal()
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].treeAfter !== treeHash || !Number.isInteger(records[i].seq)) continue
      try {
        if ((await scanTree(this.#historyDir(records[i].seq))).treeSha256 === treeHash) return records[i].seq
      } catch {
        // An unreadable snapshot is no remedy.
      }
    }
    return null
  }

  /** MemoryFrozenError for a tamper remedy refused while frozen, naming the remedy that works. */
  async #frozenRefusal(action, treeHash, details = {}) {
    const frozen = await this.frozen()
    const seq = frozen?.treeHash ? await this.#snapshotSeqOf(frozen.treeHash) : null
    const remedy = seq !== null
      ? `reinstate the frozen tree with "cc-rsi memory restore ${seq}"`
      : 'no history snapshot holds the frozen tree; copy the frozen tree back into canonical memory by hand'
    const what = action === 'restore'
      ? 'only the history snapshot of the frozen tree can be restored while memory is frozen'
      : 'a change to frozen memory cannot be accepted'
    return new MemoryFrozenError({ ...details, action, treeHash, frozenTreeHash: frozen?.treeHash ?? null, frozenSeq: seq },
      `memory is frozen: ${what}; ${remedy}`)
  }

  /** `[{n, treeSha256, at}]` of the history snapshots, ascending. */
  async history() {
    const names = (await readdir(this.#path('history')).catch(() => [])).filter(name => /^\d{4,}$/.test(name))
    const records = await this.journal()
    const out = []
    for (const name of names) {
      const n = Number.parseInt(name, 10)
      let digest = null
      try {
        digest = (await scanTree(this.#path('history', name))).treeSha256
      } catch {
        digest = null
      }
      const record = records.find(entry => entry.seq === n)
      let at = record?.ts ?? null
      if (!at) at = (await lstat(this.#path('history', name)).catch(() => null))?.mtime?.toISOString() ?? null
      out.push({ n, treeSha256: digest, at })
    }
    return out.sort((a, b) => a.n - b.n)
  }

  /** Waits for pending mutations. Locks are held only during an operation, so no heartbeat survives this. */
  async close() {
    await this.#chain
  }
}

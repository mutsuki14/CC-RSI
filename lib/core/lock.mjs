// Cross-process lease lock (SPEC §5.4): a port of the dsh store lock
// (dsh-rsi src/memory/store.ts:175-181 nonce/held set/lease constants, :336-379 `#locked`,
// :381-399 `#staleLock`), generalized into a reusable class.
//
// The lock file is created with O_EXCL ('wx') and holds
// `{pid, host, token: "<processNonce>:<rand>", at, owner}`. The holder refreshes its mtime
// every `heartbeatMs` (a lease), so a lock left by a crash is taken over once the heartbeat
// stops, whatever pid or host the next process has, and at once when its owner on this host
// is known to be gone. Takeover is compare-and-delete: only the exact record judged stale is
// removed, never a lock someone else has just taken.
//
// Compare-and-delete is two syscalls (re-read, unlink), so every removal or in-place rewrite of a
// record runs under a guard file `<path>.takeover` created with O_EXCL (memory-crash-1): without
// it, a contender that re-read the stale record just before another contender replaced it would
// unlink the new holder's record, and both would hold the lock. Creation stays a plain O_EXCL
// open outside the guard: a contender creates only after its own guarded unlink, so a slower
// contender's guarded re-read then sees the new record and leaves it alone. The guard file names its
// holder (pid, host, machine id): a guard left by a dead process of this machine is broken at once,
// any other only after GUARD_STALE_MS, and breakers are serialized by `<guard>.break` and unlink the
// guard only when it is still the file they judged stale (r2-concurrency-4). Every guard wait is
// bounded (acquire by its own waitMs, release/assertHeld/updateOwner by GUARD_WAIT_MS), and a guard
// dated far in the future is stale, so a skewed clock never blocks a lock past its budget
// (r2-concurrency-5).
//
// Fencing (memory-crash-9): the heartbeat checks the token before refreshing the lease; a holder
// whose record was taken over (e.g. it was stopped longer than the lease) is marked `lost`, stops
// heartbeating and calls `onLost`. `assertHeld()` re-checks the token and re-arms the lease under
// the guard; callers run it before irreversible steps.

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { LockTimeoutError } from './errors.mjs'
import { machineId, sameMachine } from './machine.mjs'
import { pidAlive } from './proc.mjs'

/** Identifies this process's lock records, so a restarted process reusing the pid never mistakes an old lock for its own. */
const PROCESS_NONCE = randomBytes(8).toString('hex')
/** Tokens this process holds right now (across every LeaseLock instance). */
const HELD_TOKENS = new Set()
/** A torn or unparseable record older than this is stale (dsh store.ts:396-397). */
const TORN_STALE_MS = 5000
const DEFAULT_LEASE_MS = 30000
/**
 * The guard is held for a few syscalls. A guard of a dead process on this machine is broken at once;
 * one of another (or an unknown) machine once it is this old; one of a live process here only when
 * it is much older (a stopped holder), so a slow holder is never broken (r2-concurrency-4).
 */
const GUARD_STALE_MS = 5000
const GUARD_LIVE_STALE_MS = 60000
/** A guard or break file dated this far in the future was written under another clock: stale (r2-concurrency-5). */
const FUTURE_SKEW_MS = 60000
/** Breakers of a stale guard are serialized by `<guard>.break`; one older than this was left by a dead breaker. */
const BREAK_STALE_MS = 30000
/** How long release/assertHeld/updateOwner wait for the guard before giving up (r2-concurrency-5). */
const GUARD_WAIT_MS = 10000
const GUARD_SUFFIX = '.takeover'
const BREAK_SUFFIX = '.break'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function errnoOf(error) {
  return error && typeof error === 'object' ? error.code : undefined
}

/** ESRCH from `kill(pid, 0)` (or, on Linux, an unreaped zombie) means gone; EPERM means alive but not ours. */
function pidGone(pid) {
  return !pidAlive(pid)
}

function parseRecord(content) {
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Judges a lock record. Returns `{ stale, reason, holder }`.
 * Stale when (SPEC §5.4): the mtime is older than `leaseMs`; the record is torn and older than
 * 5 s; its token carries this process's nonce but is not held; it has our pid and host but
 * lacks our nonce; or it is on this host and its pid is gone (ESRCH, or a zombie on Linux).
 */
function judge(content, mtimeMs, leaseMs, sticky, now = Date.now()) {
  const holder = parseRecord(content)
  if (holder !== null && typeof sticky === 'function') {
    let pinned = false
    try { pinned = sticky(holder) === true } catch { pinned = false }
    if (pinned) return { stale: false, reason: 'sticky lock record (never stale)', holder }
  }
  const age = now - mtimeMs
  if (age > leaseMs) return { stale: true, reason: `lease expired (${Math.round(age / 1000)} s since the last heartbeat)`, holder }
  if (holder === null) {
    return age > TORN_STALE_MS
      ? { stale: true, reason: 'torn lock record', holder }
      : { stale: false, reason: 'lock record is being written', holder }
  }
  const token = typeof holder.token === 'string' ? holder.token : ''
  // The same machine id, or the same hostname (a renamed macOS host is still this machine; portability-7).
  const sameHost = sameMachine(holder)
  if (token.startsWith(`${PROCESS_NONCE}:`)) {
    return HELD_TOKENS.has(token)
      ? { stale: false, reason: 'held by this process', holder }
      : { stale: true, reason: 'left by this process and no longer held', holder }
  }
  if (holder.pid === process.pid && sameHost) return { stale: true, reason: 'left by an earlier process with the same pid', holder }
  if (sameHost && Number.isInteger(holder.pid) && holder.pid > 0 && pidGone(holder.pid)) {
    return { stale: true, reason: `holder pid ${holder.pid} is gone`, holder }
  }
  return { stale: false, reason: sameHost ? `held by live pid ${holder.pid}` : `held by ${holder.host ?? 'an unknown host'} (lease live)`, holder }
}

/**
 * Reads a lock file through one handle, so its content and identity belong to the same file:
 * `{ content, record, mtimeMs, mtimeNs, ino }` (`record` null when torn), or null when absent.
 */
async function readRecord(path) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null
    throw error
  }
  try {
    const info = await handle.stat({ bigint: true })
    const content = await handle.readFile('utf8')
    return { content, record: parseRecord(content), mtimeMs: Number(info.mtimeNs) / 1e6, mtimeNs: info.mtimeNs, ino: info.ino }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The same file in the same state: inode, mtime and content (an inode number alone may be reused). */
function sameRecord(a, b) {
  return a !== null && b !== null && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.content === b.content
}

/** The identity a guard or break file holds: `{ pid, host, machine, nonce }`. */
function guardIdentity() {
  return `${JSON.stringify({ pid: process.pid, host: hostname(), machine: machineId(), nonce: `${PROCESS_NONCE}:${randomBytes(4).toString('hex')}` })}\n`
}

/**
 * Whether a guard (or break) file read as `current` was left behind: its holder is a dead process
 * of this machine, or it is older than `foreignMs` (a holder of another or unknown machine, or a
 * torn file), or older than `liveMs` (a live holder here), or dated in the future beyond any skew.
 */
function guardStale(current, { foreignMs, liveMs, now = Date.now() }) {
  const age = now - current.mtimeMs
  if (age < -FUTURE_SKEW_MS) return true
  const holder = current.record
  if (holder && Number.isInteger(holder.pid) && holder.pid > 0 && sameMachine(holder)) {
    if (holder.pid !== process.pid && pidGone(holder.pid)) return true
    if (holder.pid === process.pid && typeof holder.nonce === 'string' && !holder.nonce.startsWith(`${PROCESS_NONCE}:`)) return true
    return age > liveMs
  }
  return age > foreignMs
}

/**
 * Breaks a guard left by a process that died inside its critical section (memory-crash-1,
 * r2-concurrency-4). Breakers are serialized by an O_EXCL `<guard>.break` file (itself broken only
 * when its breaker is dead here or it is BREAK_STALE_MS old); under it the guard is re-read and
 * unlinked only when it is still the very file judged stale (inode and mtime). A guard is never moved
 * aside, so a live guard is never displaced and no two holders can be inside at once.
 */
async function breakStaleGuard(guard) {
  let seen
  try {
    seen = await readRecord(guard)
  } catch {
    return
  }
  if (seen === null || !guardStale(seen, { foreignMs: GUARD_STALE_MS, liveMs: GUARD_LIVE_STALE_MS })) return
  const breaker = `${guard}${BREAK_SUFFIX}`
  let handle
  try {
    handle = await open(breaker, 'wx', 0o600)
  } catch (error) {
    if (errnoOf(error) !== 'EEXIST') return
    // Another breaker is at work, or died at work: its file goes only when it is stale too.
    const other = await readRecord(breaker).catch(() => null)
    if (other !== null && guardStale(other, { foreignMs: BREAK_STALE_MS, liveMs: BREAK_STALE_MS })) {
      const again = await lstat(breaker, { bigint: true }).catch(() => null)
      if (again !== null && again.ino === other.ino && again.mtimeNs === other.mtimeNs) await unlink(breaker).catch(() => undefined)
    }
    return
  }
  let mine = null
  try {
    await handle.writeFile(guardIdentity(), 'utf8').catch(() => undefined)
    mine = await handle.stat({ bigint: true }).catch(() => null)
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    const current = await readRecord(guard)
    if (current !== null && current.ino === seen.ino && current.mtimeNs === seen.mtimeNs
      && guardStale(current, { foreignMs: GUARD_STALE_MS, liveMs: GUARD_LIVE_STALE_MS })) {
      await unlink(guard).catch(() => undefined)
    }
  } finally {
    // Drop only our own break file.
    const now = await lstat(breaker, { bigint: true }).catch(() => null)
    if (now !== null && (mine === null || (now.ino === mine.ino && now.mtimeNs === mine.mtimeNs))) await unlink(breaker).catch(() => undefined)
  }
}

/**
 * Runs `fn()` while holding the guard `<path>.takeover` (see the header). Returns
 * `{ ran: false }` when the lock's directory does not exist (there is no record to guard),
 * `{ ran: false, timedOut: true }` when the guard stayed held past `deadline` (epoch ms; default
 * GUARD_WAIT_MS from now), else `{ ran: true, value }`. With `create`, a missing directory is
 * created instead. The guard file names its holder, so a dead holder's guard is broken at once.
 */
async function withGuard(path, fn, { pollMs = 5, create = false, deadline = Date.now() + GUARD_WAIT_MS } = {}) {
  const guard = `${path}${GUARD_SUFFIX}`
  const pause = Math.max(1, Math.min(Number(pollMs) || 1, 10))
  let made = false
  for (;;) {
    let handle
    try {
      handle = await open(guard, 'wx', 0o600)
    } catch (error) {
      const code = errnoOf(error)
      if (code === 'ENOENT') {
        if (!create || made) return { ran: false }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        made = true
        continue
      }
      if (code !== 'EEXIST') throw error
      await breakStaleGuard(guard)
      if (Date.now() >= deadline) return { ran: false, timedOut: true }
      await sleep(pause)
      continue
    }
    let mine = null
    try {
      await handle.writeFile(guardIdentity(), 'utf8').catch(() => undefined)
      mine = await handle.stat({ bigint: true })
    } catch {
      mine = null
    } finally {
      await handle.close().catch(() => undefined)
    }
    try {
      return { ran: true, value: await fn() }
    } finally {
      // Release only our own guard (one broken as stale and recreated by someone else stays).
      try {
        const now = await lstat(guard, { bigint: true })
        if (mine === null || (now.ino === mine.ino && now.mtimeNs === mine.mtimeNs)) await unlink(guard)
      } catch {
        // Already gone.
      }
    }
  }
}

export class LeaseLock {
  #path
  #leaseMs
  #heartbeatMs
  #waitMs
  #pollMs
  #owner
  #sticky
  #onLost
  #token = null
  #timer = null
  #lost = false

  /**
   * `sticky` (optional, cc-rsi addition): `(holder) => boolean`; a record for which it returns
   * true is never judged stale (e.g. a workspace lock marked `restoreFailed`, SPEC §11.6).
   * `onLost` (optional): `({ path, reason }) => void`, called once when this holder finds its
   * record taken over (heartbeat or `assertHeld`); abort the work the lock protects.
   */
  constructor(path, { leaseMs = DEFAULT_LEASE_MS, heartbeatMs = 5000, waitMs = 60000, pollMs = 50, owner = {}, sticky, onLost } = {}) {
    this.#path = path
    this.#leaseMs = leaseMs
    this.#heartbeatMs = heartbeatMs
    this.#waitMs = waitMs
    this.#pollMs = pollMs
    this.#owner = owner
    this.#sticky = sticky
    this.#onLost = onLost
  }

  get path() {
    return this.#path
  }

  /** True while this instance holds the lock and has not found it taken over. */
  get held() {
    return this.#token !== null && !this.#lost
  }

  /** True once this holder found its record taken over (until the next acquire). */
  get lost() {
    return this.#lost
  }

  /** The record this instance wrote (while held). */
  get token() {
    return this.#token
  }

  /**
   * Acquires the lock. Returns true; returns false only when `wait` is false and a live holder
   * has it; throws LockTimeoutError when it stays held live for `waitMs`. Re-acquiring a lock
   * this instance already holds returns true.
   */
  async acquire({ wait = true } = {}) {
    if (this.#token !== null) return true
    const deadline = Date.now() + this.#waitMs
    const token = `${PROCESS_NONCE}:${randomBytes(6).toString('hex')}`
    const record = `${JSON.stringify({ pid: process.pid, host: hostname(), machine: machineId(), token, at: new Date().toISOString(), owner: this.#owner })}\n`
    // Registered before the file exists, so a concurrent judge in this process never sees our fresh record as abandoned.
    HELD_TOKENS.add(token)
    try {
      for (;;) {
        if (await this.#tryCreate(record)) break
        const current = await readRecord(this.#path)
        if (current !== null) {
          const verdict = judge(current.content, current.mtimeMs, this.#leaseMs, this.#sticky)
          if (verdict.stale) {
            // Guarded compare-and-delete: only the exact record judged stale is removed. The guard
            // wait is bounded by this acquire's own deadline (r2-concurrency-5).
            const out = await guardedDelete(this.#path, again => sameRecord(again, current), {
              pollMs: this.#pollMs, deadline: wait ? deadline : Date.now() + Math.min(GUARD_WAIT_MS, this.#waitMs),
            })
            if (out.timedOut) {
              if (!wait) {
                HELD_TOKENS.delete(token)
                return false
              }
              throw new LockTimeoutError(`lock ${this.#path} could not be taken over in time (its takeover guard stayed held)`, { path: this.#path, holder: verdict.holder, reason: verdict.reason })
            }
            continue
          }
          if (!wait) {
            HELD_TOKENS.delete(token)
            return false
          }
          if (Date.now() >= deadline) {
            throw new LockTimeoutError(
              `lock ${this.#path} is held by another process (${verdict.reason}); `
              + 'if no cc-rsi process uses it, remove it with "cc-rsi doctor --release-lock"',
              { path: this.#path, holder: verdict.holder, reason: verdict.reason },
            )
          }
        }
        await sleep(this.#pollMs)
      }
    } catch (error) {
      HELD_TOKENS.delete(token)
      throw error
    }
    this.#token = token
    this.#lost = false
    this.#startHeartbeat()
    return true
  }

  async #tryCreate(record) {
    let handle
    try {
      try {
        handle = await open(this.#path, 'wx', 0o600)
      } catch (error) {
        if (errnoOf(error) !== 'ENOENT') throw error
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
        handle = await open(this.#path, 'wx', 0o600)
      }
    } catch (error) {
      if (errnoOf(error) === 'EEXIST') return false
      throw error
    }
    try {
      await handle.writeFile(record, 'utf8')
      await handle.sync().catch(() => undefined)
    } catch (error) {
      // Never leave an empty record behind (it would block others until judged torn).
      await handle.close().catch(() => undefined)
      handle = null
      await unlink(this.#path).catch(() => undefined)
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
    return true
  }

  /** Marks this holder as having lost its record: heartbeat stopped, `onLost` called once. */
  #markLost(reason) {
    if (this.#lost || this.#token === null) return
    this.#lost = true
    this.#stopHeartbeat()
    if (typeof this.#onLost === 'function') {
      try {
        this.#onLost({ path: this.#path, reason })
      } catch {
        // A failing callback never breaks the heartbeat.
      }
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat()
    if (!(this.#heartbeatMs > 0)) return
    const path = this.#path
    const token = this.#token
    let beating = false
    const timer = setInterval(async () => {
      if (beating) return
      beating = true
      try {
        let current
        try {
          current = await readRecord(path)
        } catch {
          return // unreadable right now: the next beat tries again
        }
        if (this.#timer !== timer || this.#token !== token) return // stopped or released meanwhile
        if (current === null || current.record?.token !== token) {
          this.#markLost(current === null ? 'the lock record was removed' : 'the lock record was taken over')
          return
        }
        const now = new Date()
        await utimes(path, now, now).catch(() => undefined)
      } finally {
        beating = false
      }
    }, this.#heartbeatMs)
    this.#timer = timer
    timer.unref?.()
  }

  #stopHeartbeat() {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Stops heartbeats without releasing (the lease then expires after `leaseMs`). */
  stopHeartbeat() {
    this.#stopHeartbeat()
  }

  /** The owner payload this instance writes. */
  get owner() {
    return this.#owner
  }

  /**
   * Fencing before an irreversible step: throws LockTimeoutError('lock_lost') (and marks the
   * holder lost) unless the record still carries this instance's token. The check runs under the
   * guard and refreshes the lease, so a contender that judged the record expired just before now
   * compares a different mtime and leaves it alone.
   */
  async assertHeld() {
    const token = this.#token
    if (token === null || this.#lost) {
      throw new LockTimeoutError('lock_lost', `lock ${this.#path} is not held`, { path: this.#path })
    }
    const out = await withGuard(this.#path, async () => {
      const current = await readRecord(this.#path)
      if (current === null || current.record?.token !== token) return false
      const now = new Date()
      await utimes(this.#path, now, now).catch(() => undefined)
      return true
    }, { pollMs: this.#pollMs })
    // A guard that stayed held is no proof of loss: fail this fence without marking the lock lost.
    if (out.timedOut) throw new LockTimeoutError('lock_guard_timeout', `lock ${this.#path} could not be checked in time`, { path: this.#path })
    if (!(out.ran && out.value)) {
      this.#markLost('the lock record was taken over')
      throw new LockTimeoutError('lock_lost', `lock ${this.#path} was taken over`, { path: this.#path })
    }
  }

  /**
   * Rewrites the held record atomically with `owner` merged with `patch`, keeping pid, host and
   * token (so `release` still recognizes it). Throws when the lock is not held by this instance.
   */
  async updateOwner(patch) {
    const token = this.#token
    if (token === null) throw new LockTimeoutError('lock_not_held', `lock ${this.#path} is not held`, { path: this.#path })
    const current = await readRecord(this.#path)
    const record = current?.record ?? null
    if (record === null || record.token !== token) {
      this.#markLost('the lock record was taken over')
      throw new LockTimeoutError('lock_lost', `lock ${this.#path} was taken over`, { path: this.#path })
    }
    const owner = { ...(record.owner ?? {}), ...patch }
    const out = await guardedReplace(this.#path, now => now?.record?.token === token,
      `${JSON.stringify({ ...record, owner })}\n`, { pollMs: this.#pollMs })
    if (out.timedOut) throw new LockTimeoutError('lock_guard_timeout', `lock ${this.#path} could not be updated in time`, { path: this.#path })
    if (!(out.ran && out.value)) {
      this.#markLost('the lock record was taken over')
      throw new LockTimeoutError('lock_lost', `lock ${this.#path} was taken over`, { path: this.#path })
    }
    this.#owner = owner
  }

  /**
   * Releases the lock: stops the heartbeat and unlinks the file only if it still carries our token.
   * When the guard stays held past its bound, the record is left to expire with its lease.
   */
  async release() {
    this.#stopHeartbeat()
    const token = this.#token
    if (token === null) return
    this.#token = null
    try {
      await guardedDelete(this.#path, current => current.record?.token === token, { pollMs: this.#pollMs })
    } finally {
      HELD_TOKENS.delete(token)
    }
  }

  /**
   * Inspects a lock file without touching it: null when absent, else
   * `{ holder, stale, reason }` (`holder` is null for a torn record).
   */
  static async inspect(path, { leaseMs = DEFAULT_LEASE_MS, sticky } = {}) {
    const current = await readRecord(path)
    if (current === null) return null
    return judge(current.content, current.mtimeMs, leaseMs, sticky)
  }

  /**
   * Guarded compare-and-delete of a lock file (memory-crash-1): under the takeover guard, re-reads
   * the record and unlinks it only when `predicate(current)` is true, where `current` is
   * `{ content, record, mtimeMs, mtimeNs, ino }` (`record` = parsed JSON or null). Every remover of
   * a lock file (takeover, release, a job recovery's release) must use this. True when removed.
   */
  static async compareAndDelete(path, predicate, { pollMs = 5, deadline } = {}) {
    const out = await guardedDelete(path, predicate, { pollMs, deadline })
    return out.ran ? out.value : false
  }

  /**
   * Guarded compare-and-swap of a lock file: writes `content` to a temporary sibling, then, under
   * the takeover guard, renames it over `path` only when `predicate(current)` is true (`current`
   * as in compareAndDelete, or null when the file is absent). Every in-place rewrite of a held
   * record must use this, so it never replaces a record another process has just taken. True when
   * replaced.
   */
  static async compareAndReplace(path, predicate, content, { pollMs = 5, mode = 0o600, deadline } = {}) {
    const out = await guardedReplace(path, predicate, content, { pollMs, mode, deadline })
    return out.ran ? out.value : false
  }

  /** Removes a lock file whatever its state (human/doctor use only). True when a file was removed. */
  static async forceRelease(path) {
    try {
      await unlink(path)
      return true
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return false
      throw error
    }
  }
}

/** compareAndDelete returning withGuard's `{ ran, value, timedOut }`. */
async function guardedDelete(path, predicate, { pollMs = 5, deadline } = {}) {
  return withGuard(path, async () => {
    const current = await readRecord(path)
    if (current === null || predicate(current) !== true) return false
    try {
      await unlink(path)
      return true
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return false
      throw error
    }
  }, { pollMs, ...(deadline === undefined ? {} : { deadline }) })
}

/** compareAndReplace returning withGuard's `{ ran, value, timedOut }`. */
async function guardedReplace(path, predicate, content, { pollMs = 5, mode = 0o600, deadline } = {}) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let handle
  try {
    handle = await open(tmp, 'wx', mode)
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') throw error
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    handle = await open(tmp, 'wx', mode)
  }
  try {
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync().catch(() => undefined)
    } finally {
      await handle.close().catch(() => undefined)
    }
    return await withGuard(path, async () => {
      const current = await readRecord(path)
      if (predicate(current) !== true) return false
      await rename(tmp, path)
      return true
    }, { pollMs, create: true, ...(deadline === undefined ? {} : { deadline }) })
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

/** Runs `fn(lock)` while holding a LeaseLock on `path`; always releases. */
export async function withLock(path, fn, opts = {}) {
  const lock = new LeaseLock(path, opts)
  if (!(await lock.acquire({ wait: opts.wait !== false }))) {
    throw new LockTimeoutError(`lock ${path} is held by another process`, { path })
  }
  try {
    return await fn(lock)
  } finally {
    await lock.release()
  }
}

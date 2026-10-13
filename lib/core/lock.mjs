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

import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { LockTimeoutError } from './errors.mjs'

/** Identifies this process's lock records, so a restarted process reusing the pid never mistakes an old lock for its own. */
const PROCESS_NONCE = randomBytes(8).toString('hex')
/** Tokens this process holds right now (across every LeaseLock instance). */
const HELD_TOKENS = new Set()
/** A torn or unparseable record older than this is stale (dsh store.ts:396-397). */
const TORN_STALE_MS = 5000
const DEFAULT_LEASE_MS = 30000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function errnoOf(error) {
  return error && typeof error === 'object' ? error.code : undefined
}

/** ESRCH from `kill(pid, 0)` means gone; EPERM means alive but not ours. */
function pidGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errnoOf(error) === 'ESRCH'
  }
}

/**
 * Judges a lock record. Returns `{ stale, reason, holder }`.
 * Stale when (SPEC §5.4): the mtime is older than `leaseMs`; the record is torn and older than
 * 5 s; its token carries this process's nonce but is not held; it has our pid and host but
 * lacks our nonce; or it is on this host and its pid is gone (ESRCH).
 */
function judge(content, mtimeMs, leaseMs, sticky, now = Date.now()) {
  let holder = null
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) holder = parsed
  } catch {
    holder = null
  }
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
  const sameHost = holder.host === hostname()
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

async function readRecord(path) {
  try {
    const info = await stat(path)
    const content = await readFile(path, 'utf8')
    return { content, mtimeMs: info.mtimeMs }
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null
    throw error
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
  #token = null
  #timer = null

  /**
   * `sticky` (optional, cc-rsi addition): `(holder) => boolean`; a record for which it returns
   * true is never judged stale (e.g. a workspace lock marked `restoreFailed`, SPEC §11.6).
   */
  constructor(path, { leaseMs = DEFAULT_LEASE_MS, heartbeatMs = 5000, waitMs = 60000, pollMs = 50, owner = {}, sticky } = {}) {
    this.#path = path
    this.#leaseMs = leaseMs
    this.#heartbeatMs = heartbeatMs
    this.#waitMs = waitMs
    this.#pollMs = pollMs
    this.#owner = owner
    this.#sticky = sticky
  }

  get path() {
    return this.#path
  }

  get held() {
    return this.#token !== null
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
    const record = `${JSON.stringify({ pid: process.pid, host: hostname(), token, at: new Date().toISOString(), owner: this.#owner })}\n`
    // Registered before the file exists, so a concurrent judge in this process never sees our fresh record as abandoned.
    HELD_TOKENS.add(token)
    try {
      for (;;) {
        if (await this.#tryCreate(record)) break
        const current = await readRecord(this.#path)
        if (current !== null) {
          const verdict = judge(current.content, current.mtimeMs, this.#leaseMs, this.#sticky)
          if (verdict.stale) {
            // Compare-and-delete: re-read and remove only the exact record judged stale.
            const again = await readRecord(this.#path)
            if (again !== null && again.content === current.content) await unlink(this.#path).catch(() => undefined)
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

  #startHeartbeat() {
    this.#stopHeartbeat()
    if (!(this.#heartbeatMs > 0)) return
    const path = this.#path
    this.#timer = setInterval(() => {
      const now = new Date()
      utimes(path, now, now).catch(() => undefined)
    }, this.#heartbeatMs)
    this.#timer.unref?.()
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
   * Rewrites the held record atomically with `owner` merged with `patch`, keeping pid, host and
   * token (so `release` still recognizes it). Throws when the lock is not held by this instance.
   */
  async updateOwner(patch) {
    if (this.#token === null) throw new LockTimeoutError('lock_not_held', `lock ${this.#path} is not held`, { path: this.#path })
    const current = await readRecord(this.#path)
    let record = null
    try { record = current === null ? null : JSON.parse(current.content) } catch { record = null }
    if (record === null || record.token !== this.#token) {
      throw new LockTimeoutError('lock_lost', `lock ${this.#path} was taken over`, { path: this.#path })
    }
    this.#owner = { ...(record.owner ?? {}), ...patch }
    const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ ...record, owner: this.#owner })}\n`, 'utf8')
      await handle.sync().catch(() => undefined)
    } finally {
      await handle.close().catch(() => undefined)
    }
    try {
      await rename(tmp, this.#path)
    } catch (error) {
      await unlink(tmp).catch(() => undefined)
      throw error
    }
  }

  /** Releases the lock: stops the heartbeat and unlinks the file only if it still carries our token. */
  async release() {
    this.#stopHeartbeat()
    const token = this.#token
    if (token === null) return
    this.#token = null
    try {
      const current = await readRecord(this.#path)
      if (current === null) return
      let holderToken
      try {
        holderToken = JSON.parse(current.content)?.token
      } catch {
        holderToken = undefined
      }
      if (holderToken === token) await unlink(this.#path).catch(error => { if (errnoOf(error) !== 'ENOENT') throw error })
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

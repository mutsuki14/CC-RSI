// Project-wide workspace locks (SPEC §11.6; PR §4.8).
//
// While an independent verification inspects a candidate root, `<home>/run/locks/<sha24(root)>.json`
// exists. The main-session guard (lib/hooks/guard.mjs) denies file changes and shell commands under
// a live lock in EVERY session and subagent, so the Actor cannot change the candidate mid-inspection;
// the job's checkpoint/restore reverts what the Verifier itself changed. The record is a LeaseLock
// (lib/core/lock.mjs) whose owner is `{root, jobId, sessionId, jobFile, restoreFailed,
// checkpointOpen, pidStart}`. Two owner states are sticky (never judged stale, always live):
//  - `restoreFailed`: the workspace may be in the Verifier's state; it blocks until a human releases
//    it (`cc-rsi doctor --release-lock <root>`);
//  - `checkpointOpen`: the job's checkpoint is not restored yet. A job that dies in this state keeps
//    the root locked until its recovery (`verify-job.mjs recover`) restores the checkpoint under the
//    same lock, so no other job can checkpoint (and later "restore") the Verifier's changes
//    (memory-crash-2). Whoever meets such a lock with a gone holder spawns that recovery.
// A restore failure recorded for a job that no longer holds the record is kept in a separate sticky
// marker `<sha24>.restore-failed-<jobId>.json` (memory-crash-3), so no other job's release removes it.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { readFile, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeJsonAtomic } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { CcRsiError } from '../core/errors.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { isUnderLexical, safeName } from '../core/paths.mjs'
import { machineId, sameMachine } from '../core/machine.mjs'
import { pidAlive } from '../core/proc.mjs'
import { physicalPath } from '../guard/paths.mjs'
import { IDENTITY_STALE_MS, processStartToken, sameProcess, spawnRecovery } from './task.mjs'

/** A lock refreshed within this window is live whatever its pid says (SPEC §11.6). */
export const LOCK_LIVE_MS = 30000
const HEARTBEAT_MS = 5000

const sticky = holder => holder?.owner?.restoreFailed === true || holder?.owner?.checkpointOpen === true

/** Locks acquired (or taken over) by this process, by file path (so markRestoreFailed can stop their heartbeat). */
const HELD = new Map()

function canonical(root) {
  const abs = resolve(root)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

function lockBase(root) {
  return sha256Hex(canonical(root)).slice(0, 24)
}

/** `<locksDir>/<sha256(realpath(root)).slice(0, 24)>.json`. */
export function lockFileFor(locksDir, root) {
  return join(locksDir, `${lockBase(root)}.json`)
}

/** `<locksDir>/<sha24>.restore-failed-<jobId>.json`: a restore failure of a job that no longer holds the record. */
function markerFileFor(locksDir, root, jobId) {
  return join(locksDir, `${lockBase(root)}.restore-failed-${safeName(jobId ?? 'unknown')}.json`)
}

/** Restore-failed marker files of `root` (absolute paths). */
function markersFor(locksDir, root) {
  const prefix = `${lockBase(root)}.restore-failed-`
  try {
    return readdirSync(locksDir).filter(n => n.startsWith(prefix) && n.endsWith('.json')).map(n => join(locksDir, n))
  } catch {
    return []
  }
}

function parseRecord(text) {
  try {
    const record = JSON.parse(text)
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null
  } catch {
    return null
  }
}

/**
 * The job file a lock record names for recovery, when it is a plausible job file of this home
 * (`<home>/projects/…/jobs/<id>.json`, with `<home>` = the parent of `<home>/run/locks`), else null.
 */
function jobFileOf(locksDir, owner) {
  const file = owner?.jobFile
  if (typeof file !== 'string' || !isAbsolute(file) || !file.endsWith('.json')) return null
  const home = dirname(dirname(resolve(locksDir)))
  return isUnderLexical(resolve(file), join(home, 'projects')) && resolve(dirname(file)).endsWith('jobs') ? resolve(file) : null
}

/**
 * Judges the holder of a record: `{ holderLive, holderGone }`. Live: refreshed within 30 s whatever
 * the pid says (SPEC §11.6), or a live pid on this host that is still the holder's process: its
 * start token matches, or (identity unknown) the heartbeat is younger than IDENTITY_STALE_MS
 * (portability-2). Gone (only ever on this host): the pid is gone or is another process now.
 */
function holderState(record, mtimeMs, now, identityOf) {
  const age = now - mtimeMs
  const fresh = age <= LOCK_LIVE_MS
  const sameHost = sameMachine(record)
  const pid = Number.isInteger(record?.pid) ? record.pid : null
  const alive = sameHost && pid !== null && pidAlive(pid)
  if (!alive) return { holderLive: fresh, holderGone: sameHost }
  if (fresh) return { holderLive: true, holderGone: false }
  const same = identityOf(pid, record?.owner?.pidStart)
  const holderLive = same === true || (same === null && age <= IDENTITY_STALE_MS)
  return { holderLive, holderGone: !holderLive }
}

/** Spawns the recovery of a dead job named by a checkpoint-open lock record (idempotent: recovery takes its own lock). */
function recoverHolder(locksDir, record, mtimeMs, { now = Date.now(), env = process.env, identityOf = sameProcess } = {}) {
  const owner = record?.owner
  if (owner?.checkpointOpen !== true || owner?.restoreFailed === true) return false
  const file = jobFileOf(locksDir, owner)
  if (file === null || !holderState(record, mtimeMs, now, identityOf).holderGone) return false
  return spawnRecovery(file, { env }) !== null
}

/**
 * Acquires the workspace lock for `root` without waiting (SPEC §11.5 step 2). A stale record (dead
 * pid on this host, expired lease) is taken over by compare-and-delete; a live, restore-failed or
 * checkpoint-open record, or a restore-failed marker of the root → CcRsiError('workspace_busy', …,
 * {holder}). A checkpoint-open record of a gone holder also spawns that job's recovery. Returns the
 * held LeaseLock (5 s heartbeat).
 */
export async function acquireWorkspaceLock(locksDir, root, { jobId = null, sessionId = null, jobFile = null, env = process.env, onLost } = {}) {
  const path = lockFileFor(locksDir, root)
  const owner = { root: canonical(root), jobId, sessionId, jobFile, restoreFailed: false, checkpointOpen: false, pidStart: processStartToken(process.pid) }
  const failedMarker = () => {
    for (const marker of markersFor(locksDir, root)) {
      let holder = null
      try { holder = parseRecord(readFileSync(marker, 'utf8')) } catch { continue }
      return holder
    }
    return null
  }
  const busy = holder => {
    let what
    if (holder?.owner?.restoreFailed === true) {
      what = 'a previous verification failed to restore this workspace; a human must inspect it and run "cc-rsi doctor --release-lock" in a terminal'
    } else if (holder?.owner?.checkpointOpen === true && holderState(holder, holder.mtimeMs ?? Date.now(), Date.now(), sameProcess).holderGone) {
      what = `verification job ${holder?.owner?.jobId ?? 'unknown'} ended without restoring its checkpoint; its recovery is pending`
    } else {
      what = `another verification (job ${holder?.owner?.jobId ?? 'unknown'}) is inspecting this workspace`
    }
    return new CcRsiError('workspace_busy', `the workspace ${owner.root} is locked: ${what}`, { holder, path })
  }
  const marker = failedMarker()
  if (marker) throw busy(marker)
  const lock = new LeaseLock(path, { leaseMs: LOCK_LIVE_MS, heartbeatMs: HEARTBEAT_MS, owner, sticky, onLost })
  if (!(await lock.acquire({ wait: false }))) {
    let holder = null
    let mtimeMs = Date.now()
    try {
      holder = parseRecord(readFileSync(path, 'utf8'))
      mtimeMs = statSync(path).mtimeMs
    } catch {
      holder = null
    }
    if (holder) {
      holder.mtimeMs = mtimeMs
      recoverHolder(locksDir, holder, mtimeMs, { env })
    }
    throw busy(holder)
  }
  // A marker written while we acquired: the root stays blocked.
  const late = failedMarker()
  if (late) {
    await lock.release().catch(() => undefined)
    throw busy(late)
  }
  HELD.set(path, lock)
  return lock
}

/** Releases a lock acquired by this process (compare-token unlink, heartbeat stopped). */
export async function releaseWorkspaceLock(lock) {
  if (!lock) return
  if (HELD.get(lock.path) === lock) HELD.delete(lock.path)
  await lock.release()
}

/**
 * Every workspace lock (and restore-failed marker): `[{ root, jobId, sessionId, pid, host, at,
 * restoreFailed, checkpointOpen, recoveryPending, jobFile, live, holderLive, path, mtimeMs }]` (synchronous: the
 * main-session guard calls it on every tool call). Live iff restore failed, a checkpoint is open,
 * refreshed within 30 s, or held by a live pid on this host that is still the holder's process
 * (SPEC §11.6, portability-2). `recoveryPending`: a checkpoint is open and its holder is gone, so
 * the job's recovery (`jobFile`) must run. Torn records are skipped. `identityOf` is injectable.
 */
export function listLocksSync(locksDir, { now = Date.now(), identityOf = sameProcess } = {}) {
  let names = []
  try {
    names = readdirSync(locksDir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const path = join(locksDir, name)
    let text
    let mtimeMs
    try {
      text = readFileSync(path, 'utf8')
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    const record = parseRecord(text)
    const owner = record?.owner
    if (!owner || typeof owner.root !== 'string' || owner.root === '') continue
    const restoreFailed = owner.restoreFailed === true
    const checkpointOpen = owner.checkpointOpen === true
    const holder = holderState(record, mtimeMs, now, identityOf)
    const jobFile = jobFileOf(locksDir, owner)
    out.push({
      root: owner.root,
      jobId: typeof owner.jobId === 'string' ? owner.jobId : null,
      sessionId: typeof owner.sessionId === 'string' ? owner.sessionId : null,
      pid: Number.isInteger(record.pid) ? record.pid : null,
      host: typeof record.host === 'string' ? record.host : null,
      at: typeof record.at === 'string' ? record.at : null,
      restoreFailed,
      checkpointOpen,
      recoveryPending: checkpointOpen && !restoreFailed && holder.holderGone && jobFile !== null,
      jobFile,
      live: restoreFailed || checkpointOpen || holder.holderLive,
      holderLive: holder.holderLive,
      path,
      mtimeMs,
    })
  }
  return out
}

/**
 * Spawns recovery for every listed lock whose job died with its checkpoint open (`recoveryPending`)
 * and whose root is `root` or lies under or above it (any root when `root` is omitted). Returns the
 * job files. Recovery takes its own lock, so callers may do this on every status or session start.
 */
export function recoverPendingLocks(locksDir, { root = null, env = process.env, locks } = {}) {
  const out = []
  for (const lock of locks ?? listLocksSync(locksDir)) {
    if (!lock.recoveryPending || !lock.jobFile) continue
    if (root && !isUnderLexical(resolve(lock.root), resolve(root)) && !isUnderLexical(resolve(root), resolve(lock.root))) continue
    if (spawnRecovery(lock.jobFile, { env }) !== null) out.push(lock.jobFile)
  }
  return out
}

/**
 * The first LIVE lock whose root contains `absPath` (lexically, and after resolving symbolic links of
 * the deepest existing prefix on both sides), or null.
 */
export function lockCovering(locks, absPath) {
  if (typeof absPath !== 'string' || absPath === '') return null
  const candidates = new Set([resolve(absPath)])
  try { candidates.add(physicalPath(absPath, '/')) } catch { /* keep the lexical form */ }
  for (const lock of locks ?? []) {
    if (!lock || lock.live === false || typeof lock.root !== 'string') continue
    const roots = new Set([resolve(lock.root)])
    try { roots.add(physicalPath(lock.root, '/')) } catch { /* keep */ }
    for (const p of candidates) {
      for (const r of roots) {
        if (isUnderLexical(p, r)) return lock
      }
    }
  }
  return null
}

/**
 * A workspace lock record taken over by a job's recovery (memory-crash-2): it carries this
 * process's pid and a token no LeaseLock instance owns, heartbeats like a LeaseLock (only while the
 * record still carries its token; otherwise it is `lost` and calls `onLost`, memory-crash-9), and is
 * released by a guarded compare-token delete. Same surface as the LeaseLock used by runJob.
 */
class TakenOverLock {
  #path
  #token
  #timer = null
  #lost = false
  #onLost

  constructor(path, token, { onLost } = {}) {
    this.#path = path
    this.#token = token
    this.#onLost = onLost
    let beating = false
    const timer = setInterval(async () => {
      if (beating) return
      beating = true
      try {
        // Fencing (memory-crash-9): never refresh a lease this process no longer holds.
        const record = await this.#current()
        if (this.#timer !== timer || this.#token === null) return
        if (!record || record.token !== this.#token) {
          this.#markLost()
          return
        }
        const now = new Date()
        await utimes(path, now, now).catch(() => undefined)
      } finally {
        beating = false
      }
    }, HEARTBEAT_MS)
    timer.unref?.()
    this.#timer = timer
  }

  get path() { return this.#path }
  get token() { return this.#token }
  get held() { return this.#token !== null && !this.#lost }
  get lost() { return this.#lost }

  #markLost() {
    if (this.#lost) return
    this.#lost = true
    this.stopHeartbeat()
    try { this.#onLost?.({ path: this.#path, reason: 'the lock record was taken over' }) } catch { /* never breaks the heartbeat */ }
  }

  stopHeartbeat() {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  async #current() {
    try {
      return parseRecord(await readFile(this.#path, 'utf8'))
    } catch {
      return null
    }
  }

  /** Throws CcRsiError('lock_lost') unless the record still carries this instance's token. */
  async assertHeld() {
    const token = this.#token
    const record = await this.#current()
    if (token === null || this.#lost || !record || record.token !== token) {
      this.#markLost()
      throw new CcRsiError('lock_lost', `lock ${this.#path} was taken over`, { path: this.#path })
    }
  }

  async updateOwner(patch) {
    const token = this.#token
    const record = await this.#current()
    if (!record || token === null || record.token !== token) {
      this.#markLost()
      throw new CcRsiError('lock_lost', `lock ${this.#path} was taken over`, { path: this.#path })
    }
    // Guarded compare-and-swap (memory-crash-1): never replaces a record another process just took.
    const next = `${JSON.stringify({ ...record, owner: { ...(record.owner ?? {}), ...patch } })}\n`
    if (!(await LeaseLock.compareAndReplace(this.#path, cur => cur?.record?.token === token, next))) {
      this.#markLost()
      throw new CcRsiError('lock_lost', `lock ${this.#path} was taken over`, { path: this.#path })
    }
  }

  async release() {
    this.stopHeartbeat()
    const token = this.#token
    this.#token = null
    if (token === null) return
    await LeaseLock.compareAndDelete(this.#path, cur => cur.record?.token === token).catch(() => undefined)
  }
}

/**
 * Takes over the workspace lock of `root` for the recovery of `jobId` (SPEC §11.5 "Recovery";
 * memory-crash-2), so the restore runs under the root's lock:
 *  - the record names `jobId` (and is not restore-failed): it is rewritten in place (compare-and-
 *    swap on its exact content) with this process's pid, a fresh token and `recovering: true`;
 *  - no record: the lock is acquired afresh;
 *  - otherwise (another job holds the root, or a restore failure is recorded): `{ conflict: holder }`
 *    and nothing is restored.
 * Returns `{ lock }` or `{ conflict }`.
 */
export async function takeOverWorkspaceLock(locksDir, root, { jobId, sessionId = null, jobFile = null, env = process.env, onLost } = {}) {
  const path = lockFileFor(locksDir, root)
  const marker = markersFor(locksDir, root)[0]
  if (marker) {
    let holder = null
    try { holder = parseRecord(readFileSync(marker, 'utf8')) } catch { holder = null }
    return { conflict: holder ?? { owner: { restoreFailed: true } } }
  }
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = null
  }
  if (text === null) {
    try {
      return { lock: await acquireWorkspaceLock(locksDir, root, { jobId, sessionId, jobFile, env, onLost }) }
    } catch (error) {
      return { conflict: error?.details?.holder ?? null }
    }
  }
  const record = parseRecord(text)
  if (!record || record.owner?.jobId !== jobId || record.owner?.restoreFailed === true) return { conflict: record }
  const token = `recovery:${randomBytes(6).toString('hex')}`
  const next = {
    pid: process.pid,
    host: hostname(),
    machine: machineId(),
    token,
    at: new Date().toISOString(),
    owner: { ...record.owner, root: record.owner.root ?? canonical(root), checkpointOpen: true, recovering: true, pidStart: processStartToken(process.pid) },
  }
  // Guarded compare-and-swap on the exact content judged (memory-crash-1).
  if (!(await LeaseLock.compareAndReplace(path, cur => cur !== null && cur.content === text, `${JSON.stringify(next)}\n`))) {
    let again = null
    try {
      again = await readFile(path, 'utf8')
    } catch {
      again = null
    }
    return { conflict: again === null ? null : parseRecord(again) }
  }
  const lock = new TakenOverLock(path, token, { onLost })
  HELD.set(path, lock)
  return { lock }
}

/**
 * Marks the workspace of `root` restore-failed (SPEC §11.5 step 9): it keeps blocking (sticky,
 * never stale) until a human releases it. The lock record is rewritten in place (with a fresh token
 * no LeaseLock instance owns, so no ordinary release can unlink it) when it is held by this
 * process, belongs to `jobId`, or is missing; a record of ANOTHER job is left alone and a separate
 * marker `<sha24>.restore-failed-<jobId>.json` is written instead (memory-crash-3). Returns the
 * path written.
 */
export async function markRestoreFailed(locksDir, root, { jobId = null, sessionId = null } = {}) {
  const path = lockFileFor(locksDir, root)
  const held = HELD.get(path)
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = null
  }
  const record = text === null ? null : parseRecord(text)
  const heldHere = Boolean(held && held.token && record && record.token === held.token)
  let mine = text === null
    || (record !== null && (typeof jobId === 'string' ? record.owner?.jobId === jobId : heldHere))
  const token = `restore-failed:${randomBytes(6).toString('hex')}`
  let written = null
  if (mine) {
    held?.stopHeartbeat()
    const owner = {
      ...(record?.owner ?? {}),
      root: record?.owner?.root ?? canonical(root),
      jobId: record?.owner?.jobId ?? jobId,
      sessionId: record?.owner?.sessionId ?? sessionId,
      restoreFailed: true,
    }
    const content = `${JSON.stringify({ pid: process.pid, host: hostname(), machine: machineId(), token, at: new Date().toISOString(), owner })}\n`
    // Guarded compare-and-swap on the record judged (memory-crash-1): a record another process
    // created or rewrote meanwhile is left alone and the separate marker is written instead.
    if (await LeaseLock.compareAndReplace(path, cur => (text === null ? cur === null : cur !== null && cur.content === text), content)) {
      written = path
    } else {
      mine = false
    }
  }
  if (!mine) {
    written = markerFileFor(locksDir, root, jobId)
    const owner = { root: record?.owner?.root ?? canonical(root), jobId, sessionId, restoreFailed: true, marker: true }
    await writeJsonAtomic(written, { pid: process.pid, host: hostname(), machine: machineId(), token, at: new Date().toISOString(), owner })
  }
  if (held && mine) {
    // Forget the instance: its token no longer names the record, so its release unlinks nothing.
    HELD.delete(path)
    await held.release().catch(() => undefined)
  }
  return written
}

/**
 * Removes the lock of `root` when it belongs to `jobId` and its restore did not fail (job recovery,
 * which does not hold the LeaseLock instance). Compare-and-delete: only the exact record judged is
 * removed. Returns true when a file was removed.
 */
export async function releaseWorkspaceLockFor(locksDir, root, jobId) {
  const path = lockFileFor(locksDir, root)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return false
  }
  const record = parseRecord(text)
  if (!record || record.owner?.jobId !== jobId || record.owner?.restoreFailed === true) return false
  // Guarded compare-and-delete (memory-crash-1): only the exact record judged is removed.
  return LeaseLock.compareAndDelete(path, cur => cur.content === text && cur.record?.owner?.jobId === jobId && cur.record?.owner?.restoreFailed !== true)
    .catch(() => false)
}

/**
 * Removes the workspace lock of `root` and every restore-failed marker of it, whatever their state
 * (human use only: `cc-rsi doctor --release-lock`). Returns the removed paths.
 */
export async function forceReleaseWorkspace(locksDir, root) {
  const out = []
  for (const path of [lockFileFor(locksDir, root), ...markersFor(locksDir, root)]) {
    if (await LeaseLock.forceRelease(path).catch(() => false)) out.push(path)
  }
  return out
}

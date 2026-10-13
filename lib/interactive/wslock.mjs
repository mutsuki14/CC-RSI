// Project-wide workspace locks (SPEC §11.6; PR §4.8).
//
// While an independent verification inspects a candidate root, `<home>/run/locks/<sha24(root)>.json`
// exists. The main-session guard (lib/hooks/guard.mjs) denies file changes and shell commands under
// a live lock in EVERY session and subagent, so the Actor cannot change the candidate mid-inspection;
// the job's checkpoint/restore reverts what the Verifier itself changed. The record is a LeaseLock
// (lib/core/lock.mjs) whose owner is `{root, jobId, sessionId, restoreFailed}`. A lock whose
// restore failed is sticky: it is never judged stale and blocks until a human releases it
// (`cc-rsi doctor --release-lock <root>`), because the workspace may be in the Verifier's state.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonAtomic } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { CcRsiError } from '../core/errors.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { isUnderLexical } from '../core/paths.mjs'
import { pidAlive } from '../core/proc.mjs'
import { physicalPath } from '../guard/paths.mjs'

/** A lock refreshed within this window is live whatever its pid says (SPEC §11.6). */
export const LOCK_LIVE_MS = 30000
const HEARTBEAT_MS = 5000

const sticky = holder => holder?.owner?.restoreFailed === true

/** Locks acquired by this process, by file path (so markRestoreFailed can stop their heartbeat). */
const HELD = new Map()

function canonical(root) {
  const abs = resolve(root)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** `<locksDir>/<sha256(realpath(root)).slice(0, 24)>.json`. */
export function lockFileFor(locksDir, root) {
  return join(locksDir, `${sha256Hex(canonical(root)).slice(0, 24)}.json`)
}

/**
 * Acquires the workspace lock for `root` without waiting (SPEC §11.5 step 2). A stale record (dead
 * pid on this host, expired lease) is taken over by compare-and-delete; a live or restore-failed
 * record → CcRsiError('workspace_busy', …, {holder}). Returns the held LeaseLock (5 s heartbeat).
 */
export async function acquireWorkspaceLock(locksDir, root, { jobId = null, sessionId = null } = {}) {
  const path = lockFileFor(locksDir, root)
  const owner = { root: canonical(root), jobId, sessionId, restoreFailed: false }
  const lock = new LeaseLock(path, { leaseMs: LOCK_LIVE_MS, heartbeatMs: HEARTBEAT_MS, owner, sticky })
  if (!(await lock.acquire({ wait: false }))) {
    const info = await LeaseLock.inspect(path, { leaseMs: LOCK_LIVE_MS, sticky }).catch(() => null)
    const holder = info?.holder ?? null
    const what = holder?.owner?.restoreFailed === true
      ? 'a previous verification failed to restore this workspace; a human must inspect it and run "cc-rsi doctor --release-lock" in a terminal'
      : `another verification (job ${holder?.owner?.jobId ?? 'unknown'}) is inspecting this workspace`
    throw new CcRsiError('workspace_busy', `the workspace ${owner.root} is locked: ${what}`, { holder, path })
  }
  HELD.set(path, lock)
  return lock
}

/** Releases a lock acquired by this process (compare-token unlink, heartbeat stopped). */
export async function releaseWorkspaceLock(lock) {
  if (!lock) return
  HELD.delete(lock.path)
  await lock.release()
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
 * Every workspace lock: `[{ root, jobId, sessionId, pid, host, at, restoreFailed, live, path, mtimeMs }]`
 * (synchronous: the main-session guard calls it on every tool call). Live iff restore failed, or
 * refreshed within 30 s, or held by a live pid on this host (SPEC §11.6). Torn records are skipped.
 */
export function listLocksSync(locksDir, { now = Date.now() } = {}) {
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
    const sameHost = record.host === hostname()
    const live = restoreFailed || now - mtimeMs <= LOCK_LIVE_MS || (sameHost && pidAlive(record.pid))
    out.push({
      root: owner.root,
      jobId: typeof owner.jobId === 'string' ? owner.jobId : null,
      sessionId: typeof owner.sessionId === 'string' ? owner.sessionId : null,
      pid: Number.isInteger(record.pid) ? record.pid : null,
      host: typeof record.host === 'string' ? record.host : null,
      at: typeof record.at === 'string' ? record.at : null,
      restoreFailed,
      live,
      path,
      mtimeMs,
    })
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
 * Marks the workspace lock of `root` restore-failed (SPEC §11.5 step 9): the record keeps blocking
 * (sticky, never stale) and its heartbeat stops. A lock held by this process is rewritten in place;
 * otherwise the record is rewritten (or created, when missing) with `restoreFailed: true`.
 */
export async function markRestoreFailed(locksDir, root, { jobId = null, sessionId = null } = {}) {
  const path = lockFileFor(locksDir, root)
  const held = HELD.get(path)
  if (held && held.held) {
    try {
      await held.updateOwner({ restoreFailed: true })
      held.stopHeartbeat()
      HELD.delete(path)
      return path
    } catch {
      // Taken over meanwhile: fall through and rewrite the record.
    }
  }
  let record = null
  try {
    record = parseRecord(await readFile(path, 'utf8'))
  } catch {
    record = null
  }
  const owner = { ...(record?.owner ?? {}), root: record?.owner?.root ?? canonical(root), jobId: record?.owner?.jobId ?? jobId, sessionId: record?.owner?.sessionId ?? sessionId, restoreFailed: true }
  const next = record
    ? { ...record, owner }
    : { pid: process.pid, host: hostname(), token: `restore-failed:${randomBytes(6).toString('hex')}`, at: new Date().toISOString(), owner }
  await writeJsonAtomic(path, next)
  if (held) {
    held.stopHeartbeat()
    HELD.delete(path)
  }
  return path
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
  let again
  try {
    again = await readFile(path, 'utf8')
  } catch {
    return false
  }
  if (again !== text) return false
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

// `cc-rsi gc [--older-than DAYS] [--dry-run] [--streams]` (SPEC §13.6).
//
// Removes only derived, re-creatable or transient state:
//  - MCP attestations older than 1 h;
//  - for sessions whose `endedAt` is older than N days (default 14): the memory view, checkpoints,
//    `displaced/` copies and the ctx invocation logs;
//  - `<home>/vscratch/<sid>` of retired or closed tasks (or of no task at all) older than N days;
//  - `<home>/work/<key>/<id>` (role-visible work trees) of terminal lineages;
//  - with `--streams`, the `stream.jsonl` invocation streams of terminal lineages.
// Records (task.json, verdicts, journals, results, reports, evaluations) are never deleted. Anything a
// live job, a live engine or a restore-failed workspace lock may still need is skipped.

import { lstat, readdir, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { exists, readJsonSafe } from '../core/atomic.mjs'
import { UsageError } from '../core/errors.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { ccRsiHome, globalLayout, projectLayout, safeName } from '../core/paths.mjs'
import { pidAlive } from '../core/proc.mjs'
import { removeTree } from '../workspace/copy.mjs'
import { EXIT, intOption, onlyOptions, parseArgs, say } from './main.mjs'

const DAY_MS = 24 * 3600 * 1000
const ATTESTATION_MAX_AGE_MS = 3600 * 1000
const TERMINAL_LINEAGE = new Set(['completed', 'abandoned', 'quarantined'])
const ACTIVE_JOB = new Set(['queued', 'running'])

async function list(dir) {
  return (await readdir(dir).catch(() => [])).filter(name => !name.startsWith('.')).sort()
}

async function mtimeMs(path) {
  const info = await lstat(path).catch(() => null)
  return info ? info.mtimeMs : null
}

/** Workspace locks: `{ sessionIds, jobIds, restoreFailedJobs }` of every lock that is live or restore-failed. */
async function lockState(g, now) {
  const sessionIds = new Set()
  const jobIds = new Set()
  for (const name of await list(g.locks)) {
    if (!name.endsWith('.json')) continue
    const path = join(g.locks, name)
    const record = await readJsonSafe(path, null)
    const owner = record?.owner
    if (!owner) continue
    const info = await stat(path).catch(() => null)
    const live = owner.restoreFailed === true
      || (info && now - info.mtimeMs <= 30000)
      || (record.host === hostname() && pidAlive(record.pid))
    if (!live) continue
    if (typeof owner.sessionId === 'string') sessionIds.add(owner.sessionId)
    if (typeof owner.jobId === 'string') jobIds.add(owner.jobId)
  }
  return { sessionIds, jobIds }
}

async function activeJobs(sessionDir) {
  const out = []
  for (const name of await list(join(sessionDir, 'jobs'))) {
    if (!name.endsWith('.json')) continue
    const job = await readJsonSafe(join(sessionDir, 'jobs', name), null)
    if (job && ACTIVE_JOB.has(job.status)) out.push(job)
  }
  return out
}

/** The numbered invocation dirs (and pin files) of a session's ctx logs; the session registries are kept. */
async function ctxLogs(ctxDir) {
  const out = []
  for (const key of await list(ctxDir)) {
    const keyDir = join(ctxDir, key)
    for (const name of await list(keyDir)) {
      if (/^\d+$/.test(name) || name === 'pin.md') out.push(join(keyDir, name))
    }
  }
  return out
}

export async function run(args, io) {
  const { positionals, options } = parseArgs(args, { string: ['older-than', 'project', 'session'], boolean: ['dry-run', 'streams'] })
  onlyOptions(options, ['older-than', 'dry-run', 'streams', 'project', 'session'], 'gc')
  if (positionals.length > 0) throw new UsageError('usage: cc-rsi gc [--older-than DAYS] [--dry-run] [--streams]')
  const days = intOption(options, 'older-than', 14)
  const dryRun = options['dry-run'] === true
  const now = Date.now()
  const cutoff = now - days * DAY_MS
  const home = ccRsiHome(io.env)
  const g = globalLayout(home)
  const removed = []
  const remove = async (path, why) => {
    if (!(await exists(path))) return
    if (!dryRun) await removeTree(path)
    removed.push(path)
    say(io, `${dryRun ? 'would remove' : 'removed'} ${path} (${why})`)
  }

  // 1. Attestations older than 1 h (normally swept by the MCP server at start).
  for (const name of await list(g.att)) {
    const path = join(g.att, name)
    const m = await mtimeMs(path)
    if (m !== null && now - m > ATTESTATION_MAX_AGE_MS) await remove(path, 'attestation older than 1 h')
  }

  const locks = await lockState(g, now)
  const vscratchUse = new Map() // verifier session id → { keep: boolean, reason }
  const markScratch = (id, keep, reason) => {
    if (typeof id !== 'string' || id === '') return
    const prior = vscratchUse.get(id)
    if (!prior || keep) vscratchUse.set(id, { keep, reason })
  }

  for (const key of await list(g.projects)) {
    const pl = projectLayout(home, key)
    // 2. Sessions that ended more than N days ago.
    for (const name of await list(pl.sessions)) {
      const dir = join(pl.sessions, name)
      const session = await readJsonSafe(join(dir, 'session.json'), null)
      const state = await readJsonSafe(join(dir, 'task.json'), null)
      const jobs = await activeJobs(dir)
      const sid = typeof session?.sessionId === 'string' ? session.sessionId : name
      const busy = jobs.length > 0 || state?.job != null || locks.sessionIds.has(sid) || jobs.some(j => locks.jobIds.has(j.id))
      for (const t of [state?.task, state?.prevTask]) {
        const v = t?.verifier
        if (!v || typeof v.sessionId !== 'string') continue
        const last = Date.parse(v.lastUsed ?? t.openedAt ?? '')
        const old = !Number.isFinite(last) || last < cutoff
        const done = t.closed === true || v.retired === true || (session?.endedAt && Date.parse(session.endedAt) < cutoff)
        markScratch(v.sessionId, busy || !(done && old), busy ? 'a verification may use it' : !done ? 'its task is open' : 'used recently')
      }
      for (const job of jobs) markScratch(job.verifier?.sessionId, true, 'a verification job uses it')
      const ended = Date.parse(session?.endedAt ?? '')
      if (!Number.isFinite(ended) || ended >= cutoff) continue
      if (busy) {
        say(io, `kept ${dir} (a verification job or workspace lock still refers to it)`)
        continue
      }
      await remove(join(pl.views, safeName(sid)), `memory view of a session ended ${Math.floor((now - ended) / DAY_MS)} days ago`)
      await remove(join(dir, 'checkpoints'), 'checkpoints of an ended session')
      await remove(join(dir, 'displaced'), 'displaced copies of an ended session')
      for (const path of await ctxLogs(join(dir, 'ctx'))) await remove(path, 'Verifier invocation log of an ended session')
    }

    // 4./5. Terminal lineages: role work trees and (with --streams) invocation streams.
    for (const id of await list(pl.lineages)) {
      const dir = join(pl.lineages, id)
      const state = await readJsonSafe(join(dir, 'state.json'), null)
      const terminal = (await exists(join(dir, 'result.json'))) || TERMINAL_LINEAGE.has(state?.status)
      if (!terminal) continue
      const lease = await LeaseLock.inspect(join(dir, 'engine.lock')).catch(() => null)
      if (lease && lease.holder && !lease.stale) continue
      await remove(join(pl.work, safeName(id)), `work tree of terminal lineage ${id}`)
      if (options.streams === true) {
        for (const ctxKey of await list(join(dir, 'ctx'))) {
          for (const n of await list(join(dir, 'ctx', ctxKey))) {
            if (/^\d+$/.test(n)) await remove(join(dir, 'ctx', ctxKey, n, 'stream.jsonl'), `stream of terminal lineage ${id}`)
          }
        }
      }
    }
  }

  // 3. Interactive Verifier scratch of retired/closed tasks (or unreferenced) older than N days.
  for (const name of await list(g.vscratch)) {
    const path = join(g.vscratch, name)
    const use = vscratchUse.get(name)
    if (use?.keep) continue
    const m = await mtimeMs(path)
    if (m === null || m >= cutoff) continue
    await remove(path, use ? 'Verifier scratch of a retired or closed task' : 'Verifier scratch no task refers to')
  }

  say(io, `${dryRun ? 'would remove' : 'removed'} ${removed.length} path(s); records (task.json, verdicts, journals, results, reports, evaluations) are never deleted`)
  return EXIT.ok
}

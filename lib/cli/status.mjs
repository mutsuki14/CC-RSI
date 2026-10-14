// `cc-rsi status [--json] [--session <sid>] [--project <dir>]` (SPEC §13.1, text per §11.12).
//
// Read-only: it never opens a draft, never writes task or job state, and never prints report text
// or sealed evaluation scores — only counts, verdict words, hashes and ids (SPEC §13.4 "status shows
// only counts"; §15.3 "status never prints report text"). Session state is read from the files of
// §11.1/§11.2/§11.5 without taking the session lock.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, readJsonSafe } from '../core/atomic.mjs'
import { sameMachine } from '../core/machine.mjs'
import { UsageError } from '../core/errors.mjs'
import { pidAlive } from '../core/proc.mjs'
import { resolveModel, userSettingsModel } from '../runtime/models.mjs'
import { decideIsolation, effectiveProbe, readProbe, staticProbe } from '../runtime/sandbox.mjs'
import { EXIT, onlyOptions, parseArgs, projectContext, say, storeOptions } from './main.mjs'

const TERMINAL_LINEAGE = new Set(['completed', 'abandoned', 'quarantined'])

function kib(bytes) {
  const n = Number(bytes) || 0
  if (n === 0) return '0'
  return String(Math.max(0.1, Math.round((n / 1024) * 10) / 10))
}

/** Memory summary of the project store without recovery or locks: `{files, totalBytes, tree, intact, frozen, sealed}`. */
export async function memorySummary(ctx) {
  if (!(await exists(ctx.pl.store))) {
    return { exists: false, files: 0, totalBytes: 0, tree: null, intact: true, integrity: 'intact', frozen: null, sealed: null }
  }
  const { MemoryStore } = await import('../memory/store.mjs')
  // A peek handle (no open-time recovery): status must not change anything.
  const store = new MemoryStore(ctx.pl.store, storeOptions(ctx.config, ctx.pl, { lockWaitMs: 2000 }))
  const out = { exists: true, files: 0, totalBytes: 0, tree: null, intact: true, integrity: 'intact', frozen: null, sealed: null }
  try {
    const inv = await store.inventory()
    out.files = inv.files.length
    out.totalBytes = inv.totalBytes ?? 0
    out.tree = inv.treeSha256
    // The shared lock-free rule (memory-crash-10): an install in flight (another process) is not
    // tamper, and a mismatch is read once more before it is reported.
    out.intact = (await store.integrity()).intact
    out.integrity = out.intact ? 'intact' : 'CHANGED OUTSIDE A COMMIT'
    out.frozen = await store.frozen()
    out.sealed = await store.sealed()
  } catch (error) {
    out.intact = false
    out.integrity = `unreadable: ${error?.message ?? error}`
  } finally {
    await store.close().catch(() => undefined)
  }
  return out
}

/** Lineage summaries of the project (ids, phase, status, counters only; never report text or scores). */
export async function lineageSummaries(pl) {
  const names = await readdir(pl.lineages).catch(() => [])
  const out = []
  for (const name of names.sort()) {
    const state = await readJsonSafe(join(pl.lineages, name, 'state.json'), null)
    if (!state || typeof state !== 'object') continue
    const result = await readJsonSafe(join(pl.lineages, name, 'result.json'), null)
    out.push({
      id: typeof state.id === 'string' ? state.id : name,
      phase: typeof state.phase === 'string' ? state.phase : 'unknown',
      status: typeof state.status === 'string' ? state.status : 'unknown',
      termination: typeof result?.termination === 'string' ? result.termination : null,
      wave: Number.isInteger(state.wave) ? state.wave : 0,
      projectsDone: Number.isInteger(state.projectsDone) ? state.projectsDone : 0,
      targetCycles: Number.isInteger(state.targetCycles) ? state.targetCycles : 0,
      practiceProjects: Number.isInteger(state.practiceProjects) ? state.practiceProjects : 0,
      costUsd: Number.isFinite(state.costUsd) ? state.costUsd : 0,
      pausedAt: typeof state.pausedAt === 'string' ? state.pausedAt : null,
      infra: state.infra && typeof state.infra === 'object' ? { cls: state.infra.cls ?? null, detail: state.infra.detail ?? null } : null,
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
      terminal: TERMINAL_LINEAGE.has(state.status),
    })
  }
  return out
}

/** `(wave 2, 5 projects)`-style counters. */
export function lineageCounters(l) {
  const parts = []
  if (l.phase === 'broad') parts.push(`wave ${l.wave}`, `${l.projectsDone} projects`)
  else if (l.phase === 'deep') parts.push(`${l.targetCycles} target cycles`, `${l.practiceProjects} practice projects`)
  else if (l.phase === 'frozen') parts.push(`${l.targetCycles} target cycles`)
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
}

/** lib/interactive/task.mjs NOT_CURRENT_PREFIX (kept here: status loads no interactive state module eagerly). */
const NOT_CURRENT_PREFIX = 'not-current:'

function lastReport(t) {
  if (!t || !Array.isArray(t.reports) || t.reports.length === 0) return null
  return t.reports.find(r => r.gen === t.lastVerdictGen) ?? t.reports[t.reports.length - 1]
}

/** statusDigest of a candidate root, computed the way the interactive mode computes it (§11.3). */
async function currentDigest(root, ctx) {
  if (typeof root !== 'string' || root === '') return null
  try {
    const session = await import('../interactive/session.mjs')
    if (typeof session.workspaceDigest === 'function') {
      return await session.workspaceDigest(root, { home: ctx.home, storeDir: ctx.config.memory?.dir || undefined })
    }
  } catch {
    // WP5 helper unavailable: plain statusDigest below.
  }
  const { statusDigest } = await import('../workspace/git.mjs')
  return statusDigest(root).catch(() => null)
}

/** Interactive session summary: task, verification job and learning state (no report text). */
async function sessionSummary(ctx) {
  const sl = ctx.sl
  const out = { id: ctx.sid, known: await exists(sl.dir), model: null, task: null, verification: null, learning: null }
  if (!out.known) return out
  const session = await readJsonSafe(sl.sessionJson, null)
  out.model = typeof session?.model === 'string' && session.model !== '' ? session.model : null
  const state = (await readJsonSafe(sl.task, null)) ?? {}
  const t = state.task && typeof state.task === 'object' ? state.task : null
  if (t) {
    let currency = null
    if (t.lastVerdict) {
      const report = lastReport(t)
      if (!report || report.statusDigest == null) currency = 'n/a: not a git project'
      else {
        const digest = await currentDigest(t.candidateRoot, ctx)
        currency = typeof report.statusDigest === 'string' && report.statusDigest.startsWith(NOT_CURRENT_PREFIX)
          ? 'not current: the candidate changed during the inspection'
          : digest === null ? 'unknown: the workspace digest could not be computed' : digest === report.statusDigest ? 'current' : 'stale: workspace changed since inspection'
      }
    }
    out.task = {
      seq: t.seq ?? null,
      generation: Number.isInteger(t.generation) ? t.generation : 0,
      lastVerdict: t.lastVerdict ?? null,
      currency,
      learned: t.learned === true,
      closed: t.closed === true,
      candidateRoot: t.candidateRoot ?? null,
    }
  }
  if (state.job && typeof state.job.id === 'string') {
    const job = await readJsonSafe(join(sl.jobs, `${state.job.id}.json`), null)
    const started = Date.parse(job?.startedAt ?? job?.createdAt ?? state.job.startedAt ?? '')
    const pid = Number.isInteger(job?.pid) ? job.pid : Number.isInteger(state.job.pid) ? state.job.pid : null
    const sameHost = typeof job?.host !== 'string' || sameMachine(job)
    out.verification = {
      jobId: state.job.id,
      status: job?.status ?? 'queued',
      seconds: Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0,
      alive: pid === null || !sameHost ? null : pidAlive(pid),
    }
  }
  if (state.learning && typeof state.learning === 'object') out.learning = { stage: state.learning.stage ?? null, episode: state.learning.episode ?? null }
  return out
}

/** The whole status record (also the --json output). */
export async function collectStatus(ctx, env) {
  const memory = await memorySummary(ctx)
  const session = ctx.sid ? await sessionSummary(ctx) : null
  const probe = effectiveProbe(await readProbe(ctx.home), staticProbe({ env }))
  const decision = decideIsolation({ want: ctx.config.isolation?.sandbox ?? 'auto', probe })
  const verifierModel = resolveModel(ctx.config.models?.verifier ?? '', { sessionModel: session?.model ?? null, env, userSettingsModel: await userSettingsModel(env) })
  const lineages = await lineageSummaries(ctx.pl)
  const mode = memory.frozen || ctx.config.mode === 'frozen' ? 'frozen' : 'learn'
  return {
    v: 1,
    project: { root: ctx.projectRoot, key: ctx.key },
    mode,
    memory: {
      files: memory.files,
      totalBytes: memory.totalBytes,
      tree: memory.tree,
      intact: memory.intact,
      integrity: memory.integrity,
      frozen: memory.frozen !== null,
      sealed: memory.sealed !== null,
      learningAfterSealed: memory.sealed?.learningAfterSealed === true,
    },
    session,
    isolation: { mode: decision.refuse ? 'refused' : decision.sandbox ? 'sandbox' : 'rollback', reason: decision.reason },
    verifierModel,
    lineages: lineages.map(l => ({ id: l.id, phase: l.phase, status: l.status, termination: l.termination, wave: l.wave, projectsDone: l.projectsDone, targetCycles: l.targetCycles, practiceProjects: l.practiceProjects })),
    sealedEvaluations: Array.isArray(memory.sealed?.runs) ? memory.sealed.runs.length : 0,
    configWarnings: ctx.warnings,
  }
}

/** Renders the status record as the §11.12 text. */
export function statusText(s) {
  const lines = []
  lines.push(s.session ? `cc-rsi status — session ${String(s.session.id).slice(0, 8)}, project ${s.project.key}` : `cc-rsi status — project ${s.project.key} (${s.project.root})`)
  const memory = s.memory.tree ? `${s.memory.files} files, ${kib(s.memory.totalBytes)} KiB, tree ${s.memory.tree.slice(0, 12)} (${s.memory.integrity})` : `${s.memory.files} files (${s.memory.integrity})`
  const sealed = s.memory.sealed ? (s.memory.learningAfterSealed ? 'yes (learning reopened)' : 'yes') : 'no'
  lines.push(`mode: ${s.mode} | memory: ${memory} | frozen: ${s.memory.frozen ? 'yes' : 'no'} | sealed: ${sealed}`)
  if (s.session) {
    if (!s.session.known) {
      lines.push(`session ${s.session.id}: no cc-rsi state (its hooks may be inactive; run cc-rsi doctor --session ${s.session.id})`)
    } else {
      const t = s.session.task
      if (!t) lines.push('task: none')
      else {
        const verdict = t.lastVerdict ? `${t.lastVerdict} (${t.currency})${t.learned ? ', learned' : ''}` : 'none'
        lines.push(`task ${t.seq}: generation ${t.generation}; last verdict ${verdict}`)
      }
      const v = s.session.verification
      if (!v) lines.push('verification: none')
      else if (v.alive === false) lines.push(`verification: job ${v.jobId} is no longer running (its process is gone; recovery restores the candidate at the next session start or submit)`)
      else lines.push(`verification: running (job ${v.jobId}, ${v.seconds} s)`)
      lines.push(s.session.learning ? `learning: open (stage ${s.session.learning.stage})` : 'learning: none')
    }
  }
  lines.push(`isolation: Verifier ${s.isolation.mode} (${s.isolation.reason}) | Verifier model: ${s.verifierModel.model ?? 'inherit (Claude Code default)'} (${s.verifierModel.source})`)
  const lineages = s.lineages.map(l => {
    const counters = lineageCounters(l)
    return `${l.id} ${l.phase} ${l.status}${l.termination ? ` [${l.termination}]` : ''}${counters ? ` ${counters}` : ''}`
  })
  lines.push(`lineages: ${lineages.length === 0 ? 'none' : lineages.join(', ')}`)
  lines.push(`sealed evaluations: ${s.sealedEvaluations} recorded (scores are shown only in a terminal: cc-rsi eval show)`)
  for (const w of s.configWarnings ?? []) lines.push(`warning: ${w}`)
  return lines.join('\n')
}

export async function run(args, io) {
  const { positionals, options } = parseArgs(args, { string: ['session', 'project'], boolean: ['json'] })
  onlyOptions(options, ['session', 'project', 'json'], 'status')
  if (positionals.length > 0) throw new UsageError('usage: cc-rsi status [--json] [--session <sid>] [--project <dir>]')
  const ctx = await projectContext(io, { project: options.project, session: options.session })
  const s = await collectStatus(ctx, io.env)
  say(io, options.json ? JSON.stringify(s, null, 2) : statusText(s))
  return EXIT.ok
}

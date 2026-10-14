// `cc-rsi explore …` (SPEC §13.1, §12.2, §12.4, §12.15): preflight/start/status/log/stop/resume/
// abandon/show/list of exploration lineages.
//
// `explore start` without `--yes` prints the preflight (plan + blockers) and stops: it replaces
// RSIAgent's ACK tokens with an explicit confirmation. Lineage creation, admission, abandon and
// show are WP6's (lib/engine/records.mjs); this module only parses, prints and signals.
// `explore status`, `list` and `log` never print report text or scores (ids, statuses, counters
// and hashes only).

import { readdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { exists, readJsonSafe } from '../core/atomic.mjs'
import { CcRsiError, UsageError } from '../core/errors.mjs'
import { isValidId } from '../core/ids.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { sameMachine } from '../core/machine.mjs'
import { lineageLayout, projectLayout } from '../core/paths.mjs'
import { killGracefully, pidAlive } from '../core/proc.mjs'
import { CLI_ROOT, EXIT, intOption, onlyOptions, parseArgs, processProbe, projectContext, refusal, requireHuman, say, warn } from './main.mjs'
import { lineageCounters, lineageSummaries } from './status.mjs'

const START_STRINGS = ['phase', 'direction', 'direction-file', 'target', 'target-file', 'fixtures', 'id', 'model', 'actor-model', 'verifier-model',
  'curriculum-model', 'escalation-model', 'summarizer-model']
const START_BOOLEANS = ['target-conditioned', 'allow-unconfined', 'skip-auth-probe', 'foreground', 'yes']

const SPEC = {
  string: [...START_STRINGS, 'session', 'project', 'n', 'reason', 'timeout'],
  boolean: [...START_BOOLEANS, 'json', 'follow', 'accept-drift'],
  alias: { n: 'n' },
}

const COMMON = ['session', 'project']
const ALLOWED = {
  preflight: [...COMMON, ...START_STRINGS, ...START_BOOLEANS],
  start: [...COMMON, ...START_STRINGS, ...START_BOOLEANS],
  status: [...COMMON, 'json'],
  log: [...COMMON, 'follow', 'n'],
  stop: [...COMMON, 'timeout'],
  resume: [...COMMON, 'accept-drift', 'foreground'],
  abandon: [...COMMON, 'reason'],
  show: [...COMMON],
  list: [...COMMON, 'json'],
}

const USAGE = 'usage: cc-rsi explore preflight|start <start options> | status [<id>] [--json] | log <id> [--follow] [-n N] | stop <id> | resume <id> [--accept-drift] [--foreground] | abandon <id> | show <id> | list'

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

async function engineModule(name) {
  try {
    return await import(`../engine/${name}.mjs`)
  } catch (error) {
    throw new CcRsiError('engine_unavailable', `the exploration engine (lib/engine/${name}.mjs) could not be loaded: ${error?.message ?? error}`)
  }
}

/** createLineage/preflight options from the parsed start options (SPEC §12.2). */
function startOptions(ctx, io, options) {
  const phase = options.phase
  if (!phase) throw new UsageError('explore start needs --phase broad|deep|frozen')
  if (!['broad', 'deep', 'frozen'].includes(phase)) throw new UsageError(`unknown phase ${JSON.stringify(phase)}; use broad, deep or frozen`)
  if (options.direction !== undefined && options['direction-file'] !== undefined) throw new UsageError('use --direction or --direction-file, not both')
  if (options.target !== undefined && options['target-file'] !== undefined) throw new UsageError('use --target or --target-file, not both')
  const base = options.model ?? ''
  const models = {
    actor: options['actor-model'] ?? base,
    verifier: options['verifier-model'] ?? base,
    curriculum: options['curriculum-model'] ?? base,
    escalation: options['escalation-model'] ?? '',
    summarizer: options['summarizer-model'] ?? '',
  }
  const at = p => (typeof p === 'string' && p !== '' ? resolve(io.cwd, p) : undefined)
  return {
    home: ctx.home,
    projectRoot: ctx.projectRoot,
    phase,
    id: options.id,
    direction: options.direction,
    directionFile: at(options['direction-file']),
    target: options.target,
    targetFile: at(options['target-file']),
    fixturesDir: at(options.fixtures),
    targetConditioned: options['target-conditioned'] === true,
    models,
    sessionId: ctx.sid ?? undefined,
    allowUnconfined: options['allow-unconfined'] === true,
    skipAuthProbe: options['skip-auth-probe'] === true,
    config: ctx.config,
    pluginRoot: CLI_ROOT,
    env: io.env,
  }
}

function printBlockers(io, blockers) {
  say(io, 'BLOCKERS:')
  for (const b of blockers) say(io, `  - ${b}`)
}

async function preflightCommand(ctx, io, options, { fromStart }) {
  const { preflight } = await engineModule('records')
  const opts = startOptions(ctx, io, options)
  const pre = await preflight({ ...opts, authProbe: false })
  say(io, pre.plan)
  for (const w of ctx.warnings) say(io, `warning: ${w}`)
  if (pre.blockers.length > 0) {
    printBlockers(io, pre.blockers)
    say(io, 'resolve the blockers above, then re-run with --yes to launch')
    return EXIT.refused
  }
  say(io, opts.skipAuthProbe ? 'auth preflight: skipped (--skip-auth-probe)' : 'auth preflight: one tiny model call runs at launch')
  say(io, fromStart ? 're-run with --yes to launch' : 'no blockers; launch with cc-rsi explore start … --yes')
  return EXIT.ok
}

/** An AbortSignal raised by SIGINT/SIGTERM while a foreground engine runs (pause, not kill). */
function stopSignal() {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return { signal: controller.signal, dispose: () => { process.off('SIGINT', stop); process.off('SIGTERM', stop) } }
}

function foregroundCode(status) {
  if (status === 'paused_infra' || status === 'engine_error') return EXIT.error
  if (status === 'locked') return EXIT.refused
  return EXIT.ok
}

async function startCommand(ctx, io, options) {
  if (options.yes !== true) return preflightCommand(ctx, io, options, { fromStart: true })
  const { createLineage } = await engineModule('records')
  const opts = startOptions(ctx, io, options)
  const stop = options.foreground === true ? stopSignal() : null
  let created
  try {
    created = await createLineage({ ...opts, foreground: options.foreground === true, signal: stop?.signal })
  } catch (error) {
    if (error?.code === 'lineage_blocked') {
      say(io, 'explore start refused:')
      printBlockers(io, error.details?.blockers ?? [error.message])
      return EXIT.refused
    }
    throw error
  } finally {
    stop?.dispose()
  }
  for (const w of ctx.warnings) say(io, `warning: ${w}`)
  if (options.foreground === true) {
    const result = await readJsonSafe(join(created.dir, 'result.json'), null)
    say(io, `lineage ${created.id}: ${created.status}${result?.termination ? ` (termination ${result.termination})` : ''}`)
    if (created.status !== 'completed') say(io, `inspect it with cc-rsi explore status ${created.id}; continue with cc-rsi explore resume ${created.id}`)
    return foregroundCode(created.status)
  }
  say(io, `lineage ${created.id} started (engine pid ${created.pid}); records in ${created.dir}`)
  say(io, `follow it with: cc-rsi explore status ${created.id} | cc-rsi explore log ${created.id} --follow | cc-rsi explore stop ${created.id}`)
  return EXIT.ok
}

/** The lineage directory of `id`: the current project first, else the only project that has it. */
export async function lineageDirOf(ctx, id) {
  if (typeof id !== 'string' || !isValidId(id)) throw new UsageError(`invalid lineage id ${JSON.stringify(id)}`)
  const own = lineageLayout(ctx.pl, id).dir
  if (await exists(join(own, 'lineage.json'))) return own
  const found = []
  for (const key of await readdir(ctx.g.projects).catch(() => [])) {
    const dir = lineageLayout(projectLayout(ctx.home, key), id).dir
    if (await exists(join(dir, 'lineage.json'))) found.push(dir)
  }
  if (found.length === 1) return found[0]
  if (found.length > 1) throw new UsageError(`lineage ${id} exists in several projects; pass --project <dir>`)
  throw new CcRsiError('lineage_missing', `no lineage ${id} (project ${ctx.key}); list them with cc-rsi explore list`)
}

/** `{ live, pid, host }` of a lineage's engine lease. */
async function engineLease(dir) {
  const info = await LeaseLock.inspect(join(dir, 'engine.lock')).catch(() => null)
  if (!info || !info.holder) return { live: false, pid: null, host: null, machine: null }
  return {
    live: !info.stale,
    pid: Number.isInteger(info.holder.pid) ? info.holder.pid : null,
    host: info.holder.host ?? null,
    machine: typeof info.holder.machine === 'string' ? info.holder.machine : null,
  }
}

function summaryLine(l) {
  const counters = lineageCounters(l)
  const paused = l.status === 'paused_infra' && l.infra ? ` — paused on ${l.infra.cls}` : ''
  return `${l.id}  ${l.phase}  ${l.status}${l.termination ? ` [${l.termination}]` : ''}${counters ? `  ${counters}` : ''}  cost $${l.costUsd.toFixed(4)}${paused}`
}

async function statusCommand(ctx, io, id, options) {
  if (id === undefined) {
    const all = await lineageSummaries(ctx.pl)
    if (options.json) say(io, JSON.stringify(all.map(l => ({ ...l, infra: l.infra ? { cls: l.infra.cls } : null })), null, 2))
    else if (all.length === 0) say(io, `no lineages in project ${ctx.key}`)
    else for (const l of all) say(io, summaryLine(l))
    return EXIT.ok
  }
  const dir = await lineageDirOf(ctx, id)
  const lineage = await readJsonSafe(join(dir, 'lineage.json'), {})
  const state = (await readJsonSafe(join(dir, 'state.json'), null)) ?? {}
  const result = await readJsonSafe(join(dir, 'result.json'), null)
  const lease = await engineLease(dir)
  const record = {
    id: lineage.id ?? id,
    phase: lineage.phase ?? state.phase ?? null,
    status: state.status ?? 'unknown',
    project: lineage.projectRoot ?? null,
    createdAt: lineage.createdAt ?? null,
    updatedAt: state.updatedAt ?? null,
    isolation: lineage.isolation ? { mode: lineage.isolation.mode, reason: lineage.isolation.reason } : null,
    models: lineage.models ?? {},
    engine: lease,
    counters: { wave: state.wave ?? 0, projectsDone: state.projectsDone ?? 0, targetCycles: state.targetCycles ?? 0, practiceProjects: state.practiceProjects ?? 0 },
    costUsd: Number.isFinite(state.costUsd) ? state.costUsd : 0,
    lastEvent: state.lastEvent ?? null,
    pausedAt: state.pausedAt ?? null,
    infra: state.infra ?? null,
    // Terminal facts only: never report text and never a sealed score (those live elsewhere).
    result: result ? {
      termination: result.termination ?? null,
      targetVerifierVerdict: result.target_verifier_verdict ?? null,
      curriculumDecision: result.curriculum_decision ?? null,
      finalMemoryTree: result.final_memory_tree_sha256 ?? null,
      finishedAt: result.finished_at ?? null,
    } : null,
  }
  if (options.json) {
    say(io, JSON.stringify(record, null, 2))
    return EXIT.ok
  }
  say(io, `lineage ${record.id} (${record.phase}): ${record.status}${record.engine.live ? ` — engine pid ${record.engine.pid} on ${record.engine.host}` : ''}`)
  say(io, `project: ${record.project}`)
  if (record.isolation) say(io, `isolation: ${record.isolation.mode} (${record.isolation.reason})`)
  say(io, `models: ${Object.entries(record.models).map(([role, m]) => `${role}=${m ?? '(default)'}`).join(' ')}`)
  say(io, `counters: wave ${record.counters.wave}, projects ${record.counters.projectsDone}, target cycles ${record.counters.targetCycles}, practice projects ${record.counters.practiceProjects}; cost $${record.costUsd.toFixed(4)}`)
  if (record.lastEvent) say(io, `last event: ${record.lastEvent} (${record.updatedAt ?? '?'})`)
  if (record.status === 'paused_infra' || record.status === 'paused_user') {
    say(io, `paused at: ${record.pausedAt ?? '(unknown op)'}${record.infra ? ` — ${record.infra.cls}: ${record.infra.detail}` : ''}`)
    say(io, `continue with: cc-rsi explore resume ${record.id}`)
  }
  if ((record.status === 'running' || record.status === 'starting') && !record.engine.live) {
    say(io, `the engine is not running; continue with: cc-rsi explore resume ${record.id}`)
  }
  if (record.result) {
    say(io, `ended: ${record.result.termination}${record.result.targetVerifierVerdict ? `; target verdict ${record.result.targetVerifierVerdict}` : ''}${record.result.curriculumDecision ? `; curriculum ${record.result.curriculumDecision}` : ''} (${record.result.finishedAt ?? '?'})`)
  }
  return EXIT.ok
}

function oneLine(value, max = 100) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = String(text).replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** One protocol or runtime event in one line (SPEC §13.1 `explore log`). */
export function eventLine(e) {
  const fields = Object.entries(e)
    .filter(([k]) => !['ts', 'type', 'lineage', 'runtime'].includes(k))
    .map(([k, v]) => `${k}=${oneLine(v)}`)
  return `${e.ts ?? '?'}  ${e.type ?? '?'}${e.runtime ? ' (runtime)' : ''}${fields.length > 0 ? `  ${fields.join(' ')}` : ''}`
}

async function readEvents(path) {
  const text = await readFile(path, 'utf8').catch(() => '')
  // The last element is '' after a final newline, or a torn tail that is read again on the next poll.
  const complete = text.split('\n').slice(0, -1)
  const out = []
  for (const line of complete) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e === 'object') out.push(e)
    } catch {
      // unparseable line skipped
    }
  }
  return out
}

async function logCommand(ctx, io, id, options) {
  const dir = await lineageDirOf(ctx, id)
  const n = Math.max(1, intOption(options, 'n', 50))
  const path = join(dir, 'events.jsonl')
  let seen = 0
  const events = await readEvents(path)
  for (const e of events.slice(-n)) say(io, eventLine(e))
  seen = events.length
  if (options.follow !== true) return EXIT.ok
  const stop = stopSignal()
  try {
    for (;;) {
      if (stop.signal.aborted) return EXIT.ok
      await sleep(1000)
      const now = await readEvents(path)
      for (const e of now.slice(seen)) say(io, eventLine(e))
      seen = Math.max(seen, now.length)
      const state = await readJsonSafe(join(dir, 'state.json'), null)
      const lease = await engineLease(dir)
      if (!lease.live && state?.status !== 'starting' && state?.status !== 'running') {
        const last = await readEvents(path)
        for (const e of last.slice(seen)) say(io, eventLine(e))
        say(io, `(engine not running; lineage ${state?.status ?? 'unknown'})`)
        return EXIT.ok
      }
    }
  } finally {
    stop.dispose()
  }
}

/**
 * Whether the live local `pid` runs the engine of lineage `id` (portability-7): its command line is the
 * detached daemon (`node …/lib/engine/daemon.mjs <lineageDir>`) or a foreground `cc-rsi` run naming the
 * lineage. A machine whose hostname changed (macOS DHCP or Bonjour renames) still stops its own engine.
 */
function runsEngineOf(pid, id, dir) {
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false
  const cmdline = processProbe.cmdline(pid)
  if (typeof cmdline !== 'string') return false
  const padded = ` ${cmdline} `
  const daemon = /[\s/]lib\/engine\/daemon\.mjs\s/.test(padded) && cmdline.includes(dir)
  const foreground = /[\s/]bin\/cc-rsi\s/.test(padded) && /\s(explore\s+(start|resume)|engine\s+run)\s/.test(padded) && cmdline.includes(id)
  return daemon || foreground
}

/** SIGTERM to the engine pid; escalates to the process group after the timeout (SPEC §12.4). */
async function stopCommand(ctx, io, id, options) {
  const dir = await lineageDirOf(ctx, id)
  const timeoutMs = intOption(options, 'timeout', 60) * 1000
  const lease = await engineLease(dir)
  const state = await readJsonSafe(join(dir, 'state.json'), null)
  if (!lease.live || lease.pid === null) {
    say(io, `the engine of lineage ${id} is not running (state: ${state?.status ?? 'unknown'})`)
    return EXIT.ok
  }
  if (!sameMachine(lease) && !runsEngineOf(lease.pid, id, dir)) {
    throw refusal(`the engine of lineage ${id} runs on host ${lease.host} (this host is ${hostname()}); stop it there. If this machine was renamed, `
      + `check pid ${lease.pid} with "ps -p ${lease.pid} -o command=" and stop it with "kill ${lease.pid}"`)
  }
  try {
    process.kill(lease.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  say(io, `sent SIGTERM to the engine of lineage ${id} (pid ${lease.pid}); it stops its role children gracefully…`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await engineLease(dir)).live || !pidAlive(lease.pid)) break
    await sleep(250)
  }
  if ((await engineLease(dir)).live && pidAlive(lease.pid)) {
    say(io, `the engine did not stop within ${Math.round(timeoutMs / 1000)} s; stopping its process group`)
    await killGracefully(lease.pid, { group: true, graceMs: 10000 })
  }
  const after = await readJsonSafe(join(dir, 'state.json'), null)
  say(io, `lineage ${id}: ${after?.status ?? 'unknown'}${after?.pausedAt ? ` (paused at ${after.pausedAt})` : ''}; continue with cc-rsi explore resume ${id}`)
  return EXIT.ok
}

async function resumeCommand(ctx, io, id, options) {
  const dir = await lineageDirOf(ctx, id)
  const records = await engineModule('records')
  const admission = await records.admitResume(dir, { acceptDrift: options['accept-drift'] === true, env: io.env })
  for (const note of admission.notes ?? []) say(io, `note: ${note}`)
  if (!admission.ok) {
    for (const reason of admission.reasons) say(io, `resume refused: ${reason}`)
    return EXIT.refused
  }
  await records.applyResume(dir, admission)
  for (const key of admission.overrides ?? []) say(io, `override granted for ${key}`)
  if (options.foreground === true) {
    const { runEngine } = await engineModule('daemon')
    const stop = stopSignal()
    try {
      const r = await runEngine(dir, { env: io.env, signal: stop.signal })
      const result = await readJsonSafe(join(dir, 'result.json'), null)
      say(io, `lineage ${id}: ${r.status}${result?.termination ? ` (termination ${result.termination})` : ''}`)
      return foregroundCode(r.status)
    } finally {
      stop.dispose()
    }
  }
  const pid = records.startEngine(dir, { env: io.env })
  say(io, `lineage ${id} resumed (engine pid ${pid})`)
  return EXIT.ok
}

async function abandonCommand(ctx, io, id, options) {
  requireHuman(io, 'explore abandon')
  const dir = await lineageDirOf(ctx, id)
  const { abandon } = await engineModule('records')
  const record = await abandon(dir, { reason: options.reason })
  say(io, `lineage ${id} abandoned (termination ${record?.termination ?? 'abandoned'}); its records are kept`)
  return EXIT.ok
}

async function showCommand(ctx, io, id) {
  const dir = await lineageDirOf(ctx, id)
  const { showLineage } = await engineModule('records')
  say(io, await showLineage(dir))
  return EXIT.ok
}

async function listCommand(ctx, io, options) {
  const all = await lineageSummaries(ctx.pl)
  if (options.json) say(io, JSON.stringify(all.map(l => ({ id: l.id, phase: l.phase, status: l.status, termination: l.termination })), null, 2))
  else if (all.length === 0) say(io, `no lineages in project ${ctx.key}`)
  else for (const l of all) say(io, `${l.id}  ${l.phase}  ${l.status}${l.termination ? ` [${l.termination}]` : ''}`)
  return EXIT.ok
}

export async function run(args, io) {
  const { positionals, options } = parseArgs(args, SPEC)
  // A bare `cc-rsi explore` (e.g. /cc-rsi:explore without arguments) lists the lineages' status.
  const [sub = 'status', ...rest] = positionals
  if (!sub || !ALLOWED[sub]) throw new UsageError(USAGE)
  onlyOptions(options, ALLOWED[sub], `explore ${sub}`)
  if (sub === 'abandon') requireHuman(io, 'explore abandon')
  const needsId = ['log', 'stop', 'resume', 'abandon', 'show']
  const maxRest = needsId.includes(sub) || sub === 'status' ? 1 : 0
  if (rest.length > maxRest || (needsId.includes(sub) && rest.length !== 1)) throw new UsageError(USAGE)
  const ctx = await projectContext(io, { project: options.project, session: options.session })
  switch (sub) {
    case 'preflight': return preflightCommand(ctx, io, options, { fromStart: false })
    case 'start': return startCommand(ctx, io, options)
    case 'status': return statusCommand(ctx, io, rest[0], options)
    case 'log': return logCommand(ctx, io, rest[0], options)
    case 'stop': return stopCommand(ctx, io, rest[0], options)
    case 'resume': return resumeCommand(ctx, io, rest[0], options)
    case 'abandon': return abandonCommand(ctx, io, rest[0], options)
    case 'show': return showCommand(ctx, io, rest[0])
    case 'list': return listCommand(ctx, io, options)
    default:
      warn(io, USAGE)
      return EXIT.usage
  }
}

// Lineage engine entry (SPEC §12.4): `node lib/engine/daemon.mjs <lineageDir>` (detached, spawned by
// `cc-rsi explore start|resume`) or `runEngine(lineageDir)` in-process (`--foreground`, tests).
//
// The engine holds `engine.lock` (lease, 5 s heartbeat), renders every prompt from the lineage's
// own template snapshot, dispatches the phase, and maps every way a run can end to a state:
// completed (result.json written in the `final` op), paused_user (a stop: SIGTERM/SIGINT abort the
// role children gracefully), quarantined (absorbing; the reason is never recorded), or
// paused_infra with the op key to resume at. Infrastructure is never terminal (SPEC §12.3): it
// pauses, and `explore resume` re-runs the pending op in recovering mode.

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exists, writeFileAtomic } from '../core/atomic.mjs'
import { CcRsiError, RoleContextError } from '../core/errors.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { createLogger } from '../core/log.mjs'
import {
  MemoryError, MemoryFrozenError, MemoryFrozenTamperError, MemoryQuarantineError, MemorySealedError, MemoryTamperError,
} from '../memory/errors.mjs'
import { MemoryStore } from '../memory/store.mjs'
import { activePromptsDir, promptsDir, setPromptsDir } from '../prompts/render.mjs'
import { InterruptedError, isInfraError } from '../runtime/errors.mjs'
import { runBroad } from './broad.mjs'
import { runDeep } from './deep.mjs'
import { runFrozen } from './frozen.mjs'
import { OpJournal } from './journal.mjs'
import {
  appendRuntimeEvent, countInfraPauses, ENGINE_PLUGIN_ROOT, ensureWorkTree, layoutsFor, readLineage, resultRecord, storeOptions, writeState,
} from './records.mjs'

const PHASES = { broad: runBroad, deep: runDeep, frozen: runFrozen }

/** Infra class of an error that pauses the lineage (SPEC §12.4 step 9-10). */
export function infraClassOf(error) {
  if (isInfraError(error)) return { cls: error.cls, detail: error.detail || error.message }
  if (error instanceof MemoryTamperError) return { cls: 'memory_tamper', detail: error.message }
  if (error instanceof MemoryFrozenTamperError) return { cls: 'memory_frozen_tamper', detail: error.message }
  if (error instanceof MemoryFrozenError) return { cls: 'memory_frozen', detail: error.message }
  if (error instanceof MemorySealedError) return { cls: 'memory_sealed', detail: error.message }
  if (error instanceof MemoryError) return { cls: error.code ?? 'memory_error', detail: error.message }
  return { cls: 'engine_error', detail: String(error?.message ?? error) }
}

function pausedAtOf(error) {
  const extra = error?.extra ?? {}
  const details = error?.details ?? {}
  return extra.pausedAt ?? extra.opKey ?? details.pausedAt ?? details.opKey ?? null
}

/** The EngineRun passed to every phase function (SPEC §12.4). */
function buildRun({ j, lineage, lineageDir, layout, pl, store, signal, logger, env, pluginRoot }) {
  const counters = { wave: 0, projectsDone: 0, targetCycles: 0, practiceProjects: 0 }
  let micros = 0
  let lastEvent = null
  const run = {
    j,
    lineage,
    lineageDir,
    layout,
    pl,
    home: lineage.home,
    pluginRoot,
    store,
    config: lineage.config,
    models: lineage.models ?? {},
    isolation: lineage.isolation ?? { mode: 'unconfined', reason: '', allowUnconfined: false },
    signal,
    logger,
    env,
    counters,
    sandboxDegraded: false,
    runtimeEvent: (type, data = {}) => appendRuntimeEvent(lineageDir, lineage.id, type, data),
    /** Cost of every recorded reply (recomputed on replay), in integer micro-dollars. */
    addCost(delta) {
      if (Number.isFinite(delta) && delta > 0) micros += Math.round(delta * 1e6)
    },
    costUsd: () => micros / 1e6,
    setCounters(patch) {
      Object.assign(counters, patch)
    },
    state(patch = {}) {
      return writeState(lineageDir, { ...counters, costUsd: micros / 1e6, lastEvent, ...patch })
    },
    /** A protocol event through the journal (never duplicated on replay), then a state refresh. */
    async event(key, type, data = {}) {
      await j.event(key, type, data)
      lastEvent = type
      await run.state()
    },
    /** Inside the `final` op: state completed, then result.json (an existing result.json is absorbing). */
    async complete(record) {
      await run.state({ status: 'completed', pid: null, pausedAt: null, infra: null })
      await writeFileAtomic(layout.result, `${JSON.stringify(record, null, 2)}\n`)
    },
  }
  return run
}

/**
 * Runs (or resumes) the lineage at `lineageDir` until it completes, pauses or is quarantined.
 * Options: `signal` (stop), `fault` (crash testing; journal.mjs parseFault), `env` (role child
 * parent env; default process.env), `pluginRoot` (default this code's plugin root).
 * Returns `{ status, exitCode, termination?, infra?, pausedAt? }`; exitCode 3 when another engine
 * holds the lease.
 */
export async function runEngine(lineageDir, { signal, fault, env = process.env, pluginRoot = ENGINE_PLUGIN_ROOT } = {}) {
  if (typeof env.CC_RSI_ROLE === 'string' && env.CC_RSI_ROLE !== '') throw new RoleContextError()
  const dir = resolve(lineageDir)
  const lineage = await readLineage(dir)
  const { pl, layout } = layoutsFor(lineage)
  const logger = createLogger(join(dir, 'engine.log'), 'engine')
  const lock = new LeaseLock(layout.engineLock, { leaseMs: 30000, heartbeatMs: 5000, owner: { kind: 'engine', lineage: lineage.id } })
  if (!(await lock.acquire({ wait: false }))) {
    logger.warn('another engine holds the lineage lease', { lineage: lineage.id })
    return { status: 'locked', exitCode: 3 }
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const previousPrompts = activePromptsDir()
  let store = null
  let j = null
  let run = null
  try {
    if (await exists(layout.result)) {
      await writeState(dir, { status: 'completed', pid: null })
      return { status: 'completed', exitCode: 0 }
    }
    if (!PHASES[lineage.phase]) throw new CcRsiError('lineage_phase', `unknown lineage phase ${JSON.stringify(lineage.phase)}`)
    setPromptsDir(layout.promptsSnapshot)
    await ensureWorkTree(lineage, layout)
    store = await MemoryStore.open(lineage.storeRoot, storeOptions(lineage.config, pl, logger))
    j = await OpJournal.open(dir, { lineage: lineage.id, fault })
    run = buildRun({ j, lineage, lineageDir: dir, layout, pl, store, signal: controller.signal, logger, env, pluginRoot })
    if (j.size > 0) await run.runtimeEvent('LINEAGE_RESUMED', { pid: process.pid })
    await run.state({ status: 'running', pid: process.pid, pausedAt: null, infra: null })
    logger.info('engine started', { lineage: lineage.id, phase: lineage.phase, resumed: j.size > 0 })
    const out = await PHASES[lineage.phase](run)
    await run.state({ status: 'completed', pid: null, pausedAt: null, infra: null })
    logger.info('lineage completed', { lineage: lineage.id, termination: out.termination })
    return { status: 'completed', termination: out.termination, exitCode: 0 }
  } catch (error) {
    return await settle({ error, dir, lineage, run, j, store, logger, aborted: controller.signal.aborted })
  } finally {
    if (signal) signal.removeEventListener?.('abort', onAbort)
    await j?.flush().catch(() => undefined)
    await store?.close().catch(() => undefined)
    setPromptsDir(previousPrompts === promptsDir() ? null : previousPrompts)
    await lock.release().catch(() => undefined)
  }
}

/** Maps a run's error to a pause or the absorbing quarantine (SPEC §12.4 steps 7-10). */
async function settle({ error, dir, lineage, run, j, store, logger, aborted }) {
  const counters = run ? { ...run.counters, costUsd: run.costUsd() } : {}
  if (error instanceof InterruptedError || (aborted && !(error instanceof MemoryQuarantineError) && !isInfraError(error))) {
    const pausedAt = pausedAtOf(error)
    await writeState(dir, { ...counters, status: 'paused_user', pid: null, pausedAt, infra: null })
    await appendRuntimeEvent(dir, lineage.id, 'LINEAGE_PAUSED', { reason: 'user', pausedAt })
    logger.info('lineage paused by the user', { pausedAt })
    return { status: 'paused_user', exitCode: 0, pausedAt }
  }
  if (error instanceof MemoryQuarantineError && j && store) {
    try {
      // Absorbing and neutral: the reason is never recorded (RSIAgent silent audit).
      await j.event('quarantine/ev', 'LINEAGE_QUARANTINED', {})
      await j.op('final:quarantined', 'final', { termination: 'quarantined' }, async () => {
        let finalTree = null
        try { finalTree = await store.treeHash() } catch { finalTree = null }
        const record = resultRecord(lineage, {
          termination: 'quarantined',
          rationale: '',
          waves: counters.wave ?? 0,
          targetCycles: counters.targetCycles ?? 0,
          practiceProjects: counters.practiceProjects ?? 0,
          finalTree,
          costUsd: counters.costUsd ?? 0,
          infraPauses: await countInfraPauses(dir),
        })
        await writeState(dir, { ...counters, status: 'quarantined', pid: null, pausedAt: null, infra: null, lastEvent: 'LINEAGE_QUARANTINED' })
        await writeFileAtomic(join(dir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`)
        return { termination: 'quarantined' }
      })
      logger.warn('lineage quarantined')
      return { status: 'quarantined', exitCode: 0 }
    } catch (inner) {
      error = inner
    }
  }
  const { cls, detail } = infraClassOf(error)
  const pausedAt = pausedAtOf(error)
  if (cls === 'engine_error') logger.error('engine error', { stack: String(error?.stack ?? error) })
  else logger.warn('lineage paused on infrastructure', { cls, detail, pausedAt })
  await writeState(dir, { ...counters, status: 'paused_infra', pid: null, pausedAt, infra: { cls, detail } })
  await appendRuntimeEvent(dir, lineage.id, 'LINEAGE_PAUSED', { reason: 'infra', cls, pausedAt })
  return { status: 'paused_infra', exitCode: 0, infra: { cls, detail }, pausedAt }
}

/** CLI entry: `node lib/engine/daemon.mjs <lineageDir>` (refuses inside a role context). */
export async function main(argv = process.argv.slice(2)) {
  if (typeof process.env.CC_RSI_ROLE === 'string' && process.env.CC_RSI_ROLE !== '') {
    process.stderr.write('cc-rsi: refusing to run inside a cc-rsi role context (CC_RSI_ROLE is set)\n')
    return 64
  }
  const lineageDir = argv[0]
  if (!lineageDir) {
    process.stderr.write('usage: node lib/engine/daemon.mjs <lineageDir>\n')
    return 2
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    const r = await runEngine(lineageDir, { signal: controller.signal, fault: process.env.CC_RSI_ENGINE_FAULT })
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), engine: r })}\n`)
    return r.exitCode ?? 0
  } catch (error) {
    process.stderr.write(`${String(error?.stack ?? error)}\n`)
    return 1
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().then(code => {
    process.exitCode = code
  }, error => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`)
    process.exitCode = 1
  })
}

// Lineage records (SPEC §12.2, §12.3, §12.15): preflight and creation, lineage.json/state.json,
// runtime events, the snake_case result.json, resume admission, abandon and show.
//
// RSIAgent writes a protocol JSON per phase and resumes through operator-authored, hash-chained
// recovery plans; dsh-rsi lineages were not resumable at all (dsh gap 6). cc-rsi keeps every side
// effect in the memoized op journal (journal.mjs), so `explore resume` is a pure admission check
// plus, at most, operator overrides for the exact liveness/unverified key the lineage paused at.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readJson, readJsonSafe, writeFileAtomic, writeJsonAtomic } from '../core/atomic.mjs'
import { configSha, loadConfig } from '../core/config.mjs'
import { canonicalSha256, compareUtf8, sha256File, sha256Hex } from '../core/digest.mjs'
import { CcRsiError } from '../core/errors.mjs'
import { defaultLineageId, ID_RE, uuid } from '../core/ids.mjs'
import { appendJsonl, readJsonl } from '../core/jsonl.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { ccRsiHome, lineageLayout, projectKey, projectLayout, safeName, sessionLayout } from '../core/paths.mjs'
import { spawnDetached } from '../core/proc.mjs'
import { MemoryTamperError } from '../memory/errors.mjs'
import { MemoryStore, storeIntegrity } from '../memory/store.mjs'
import { PROMPT_NAMES, promptsDir, snapshotPrompts } from '../prompts/render.mjs'
import { claudeVersion, compareVersions, missingFlags, resolveClaudeBin } from '../runtime/claude-bin.mjs'
import { RoleContext } from '../runtime/context.mjs'
import { resolveModel, userSettingsModel } from '../runtime/models.mjs'
import { decideIsolation, effectiveProbe, readProbe, staticProbe } from '../runtime/sandbox.mjs'
import { removeTree } from '../workspace/copy.mjs'
import { captureTree, shapeGate } from '../workspace/fixtures.mjs'
import { initInertRepo } from '../workspace/git.mjs'
import { OpJournal } from './journal.mjs'

/** The plugin root this engine code runs from (lib/engine/../..). */
export const ENGINE_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Oldest Claude Code version the role argv supports (SPEC header: onFailure needs ≥ 2.1.295). */
const MIN_CC_VERSION = '2.1.295'
const PHASES = new Set(['broad', 'deep', 'frozen'])
const ROLES = ['actor', 'verifier', 'curriculum', 'escalation', 'summarizer']
const TERMINAL_STATUSES = new Set(['completed', 'abandoned', 'quarantined'])

/** Pause keys `explore resume` may grant (SPEC §12.15; `commits@n` is a cc-rsi addition for commit_ceiling). */
export const OVERRIDE_KEY_RE = /\/(liveness|unverified|commits)@\d+$/

/** The config sections a lineage freezes into lineage.json (SPEC §12.3; `effort` added for --effort). */
const LINEAGE_CONFIG_KEYS = ['exploration', 'transport', 'isolation', 'memory', 'audit', 'children', 'effort']

// ------------------------------------------------------------------------------------------ helpers

/** MemoryStore.open options from an effective (or lineage) config (WAVE_A_NOTES WP1 integration). */
export function storeOptions(config, pl, logger) {
  const memory = config?.memory ?? {}
  const audit = config?.audit ?? {}
  return {
    limits: { maxFiles: memory.maxFiles ?? 400, maxTotalBytes: memory.maxTotalBytes ?? 4194304, maxFileBytes: memory.maxFileBytes ?? 65536 },
    keepHistory: memory.keepHistory !== false,
    sealedTextFiles: Array.isArray(audit.sealedTextFiles) ? audit.sealedTextFiles : [],
    shingleWords: Number.isInteger(audit.shingleWords) ? audit.shingleWords : 8,
    sessionsDir: pl.sessions,
    lineagesDir: pl.lineages,
    ...(logger ? { logger } : {}),
  }
}

/** Project and lineage layouts of a lineage.json record. */
export function layoutsFor(lineage) {
  const pl = projectLayout(lineage.home, lineage.projectKey, { storeDir: lineage.storeRoot })
  return { pl, layout: lineageLayout(pl, lineage.id) }
}

/** Reads `<lineageDir>/lineage.json` (CcRsiError 'lineage_missing' when absent). */
export async function readLineage(lineageDir) {
  const lineage = await readJson(join(lineageDir, 'lineage.json'), null)
  if (!lineage || typeof lineage !== 'object') throw new CcRsiError('lineage_missing', `no lineage.json in ${lineageDir}`, { lineageDir })
  return lineage
}

/** Reads state.json (null when absent or unreadable). */
export async function readState(lineageDir) {
  return readJsonSafe(join(lineageDir, 'state.json'), null)
}

const stateChains = new Map()

/** Merges `patch` into state.json atomically (serialized per lineage in this process). */
export function writeState(lineageDir, patch) {
  const path = join(lineageDir, 'state.json')
  const prior = stateChains.get(path) ?? Promise.resolve()
  const run = prior.then(async () => {
    const current = (await readJsonSafe(path, null)) ?? {}
    const next = { v: 1, ...current, ...patch, updatedAt: new Date().toISOString() }
    await writeJsonAtomic(path, next)
    return next
  })
  stateChains.set(path, run.catch(() => undefined))
  return run
}

/** Appends a runtime event (SPEC §12.1 rule 6: physical occurrences, may repeat across attempts). */
export async function appendRuntimeEvent(lineageDir, lineage, type, data = {}) {
  try {
    await appendJsonl(join(lineageDir, 'events.jsonl'), { ts: new Date().toISOString(), type, lineage, runtime: true, ...data })
  } catch {
    // A runtime event never fails the engine.
  }
}

async function listMjs(dir) {
  try {
    return (await readdir(dir)).filter(name => name.endsWith('.mjs')).sort(compareUtf8)
  } catch {
    return []
  }
}

/**
 * `{ pluginRev, guardSha }` of a plugin tree (SPEC §12.2 step 3): pluginRev = sha256 over
 * `rel\0sha256(file)\n` of lib/engine/*.mjs, hooks/role-guard.mjs, lib/guard/*.mjs and
 * lib/runtime/*.mjs in UTF-8 order; guardSha = sha256 of hooks/role-guard.mjs. Missing files
 * hash as '-' (a missing plugin root is reported separately).
 */
export async function pluginFingerprint(pluginRoot) {
  const rels = []
  for (const sub of ['lib/engine', 'lib/guard', 'lib/runtime']) {
    for (const name of await listMjs(join(pluginRoot, sub))) rels.push(`${sub}/${name}`)
  }
  rels.push('hooks/role-guard.mjs')
  rels.sort(compareUtf8)
  const parts = []
  let guardSha = '-'
  for (const rel of rels) {
    let digest = '-'
    try {
      digest = await sha256File(join(pluginRoot, rel))
    } catch {
      digest = '-'
    }
    if (rel === 'hooks/role-guard.mjs') guardSha = digest
    parts.push(`${rel}\0${digest}\n`)
  }
  return { pluginRev: sha256Hex(parts.join('')), guardSha }
}

/** sha256 per prompt template of the plugin's prompts/ (preflight's would-be promptSha). */
async function pluginPromptShas() {
  const out = {}
  for (const name of PROMPT_NAMES) {
    try {
      out[name] = await sha256File(join(promptsDir(), `${name}.md`))
    } catch {
      out[name] = '-'
    }
  }
  return out
}

async function readText(path, what) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new CcRsiError('input_unreadable', `cannot read the ${what} file ${path}: ${error?.code ?? error}`, { path })
  }
}

/** A read-only view of the store's integrity, frozen and sealed state (admission must not write). */
export async function readOnlyStoreState(storeRoot) {
  // The shared lock-free rule (memory-crash-10): an install in flight whose tree is in place is not
  // tamper, and a mismatch is read once more before it is reported.
  const { actual, expected, intact } = await storeIntegrity(storeRoot)
  const frozenRaw = await readJsonSafe(join(storeRoot, 'frozen.json'), null)
  const frozen = frozenRaw ? { treeHash: frozenRaw.treeHash ?? null } : ((await exists(join(storeRoot, 'frozen.json'))) ? { treeHash: null } : null)
  const sealedRaw = await readJsonSafe(join(storeRoot, 'sealed.json'), null)
  const sealed = sealedRaw ? { learningAfterSealed: sealedRaw.learningAfterSealed === true } : ((await exists(join(storeRoot, 'sealed.json'))) ? { learningAfterSealed: false } : null)
  return { actual, expected, intact: Boolean(intact), frozen, sealed }
}

// ------------------------------------------------------------------------------------------ preflight

function excerpt(text, max = 160) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Effective config: `opts.config` when given (the CLI passes it), else loadConfig. */
function effectiveConfig(opts) {
  if (opts.config && typeof opts.config === 'object') return opts.config
  return loadConfig({ home: opts.home, projectRoot: opts.projectRoot }).config
}

async function resolveModels(opts, config, pl, env) {
  const configured = {}
  for (const role of ROLES) {
    const fromOpts = opts.models && typeof opts.models[role] === 'string' ? opts.models[role] : undefined
    configured[role] = fromOpts !== undefined && fromOpts !== '' ? fromOpts : (config.models?.[role] ?? '')
  }
  let sessionModel = null
  if (typeof opts.sessionId === 'string' && opts.sessionId !== '') {
    const session = await readJsonSafe(sessionLayout(pl, opts.sessionId).sessionJson, null)
    if (session && typeof session.model === 'string' && session.model !== '') sessionModel = session.model
  }
  const fromSettings = await userSettingsModel(env)
  const models = {}
  const modelSources = {}
  for (const role of ['actor', 'verifier', 'curriculum']) {
    const r = resolveModel(configured[role], { sessionModel, env, userSettingsModel: fromSettings })
    models[role] = r.model
    modelSources[role] = r.source
  }
  // SPEC §14.2: summarizer "" → the actor model; escalation "" → no escalation.
  if (configured.summarizer === '' || configured.summarizer.toLowerCase() === 'inherit') {
    models.summarizer = models.actor
    modelSources.summarizer = 'actor'
  } else {
    models.summarizer = configured.summarizer
    modelSources.summarizer = 'config'
  }
  if (configured.escalation === '' || configured.escalation.toLowerCase() === 'inherit') {
    models.escalation = null
    modelSources.escalation = 'none'
  } else {
    models.escalation = configured.escalation
    modelSources.escalation = 'config'
  }
  return { models, modelSources }
}

function lineageConfigOf(config) {
  const out = {}
  for (const key of LINEAGE_CONFIG_KEYS) out[key] = JSON.parse(JSON.stringify(config[key] ?? {}))
  return out
}

/**
 * Computes the would-be lineage.json, a human plan and the blockers of `explore start`
 * (SPEC §12.2). Opens the store (its own recovery may run) but writes no lineage record.
 * opts = { home, projectRoot, phase, id?, direction?, directionFile?, target?, targetFile?, fixturesDir?,
 *          targetConditioned?, models?, sessionId?, allowUnconfined?, config?, pluginRoot?, env?,
 *          authProbe? (run the auth preflight here too) }
 */
export async function preflight(opts = {}) {
  const env = opts.env ?? process.env
  const blockers = []
  if (typeof env.CC_RSI_ROLE === 'string' && env.CC_RSI_ROLE !== '') blockers.push('cc-rsi refuses to start a lineage inside a cc-rsi role context (CC_RSI_ROLE is set)')
  const home = resolve(String(opts.home ?? ''))
  // Remedies name the real <home> (portability-6: CC_RSI_HOME may move it).
  const globalConfigPath = join(opts.home ? home : ccRsiHome(env), 'config.json')
  const projectRoot = resolve(String(opts.projectRoot ?? ''))
  const phase = String(opts.phase ?? '')
  if (!PHASES.has(phase)) blockers.push(`unknown phase ${JSON.stringify(opts.phase)}; use broad, deep or frozen`)
  const config = effectiveConfig(opts)
  const pluginRoot = resolve(String(opts.pluginRoot ?? ENGINE_PLUGIN_ROOT))
  const key = projectKey(projectRoot)
  const memoryDir = typeof config.memory?.dir === 'string' && config.memory.dir !== '' ? config.memory.dir : undefined
  const pl = projectLayout(home, key, { storeDir: memoryDir })
  const id = opts.id ?? defaultLineageId(PHASES.has(phase) ? phase : 'lineage')
  let layout = null
  if (typeof id !== 'string' || !ID_RE.test(id)) blockers.push(`invalid lineage id ${JSON.stringify(id)}: use lowercase letters, digits, "_" and "-" (at most 64)`)
  else {
    layout = lineageLayout(pl, id)
    if (await exists(layout.lineageJson)) blockers.push(`lineage ${id} already exists (${layout.lineageJson})`)
    const lock = await LeaseLock.inspect(layout.engineLock)
    if (lock && lock.holder && !lock.stale) blockers.push(`an engine for lineage ${id} is already running (pid ${lock.holder.pid})`)
  }

  // Inputs per phase.
  let direction = null
  let target = null
  try {
    if (typeof opts.direction === 'string' && opts.direction.trim() !== '') direction = opts.direction
    else if (opts.directionFile) direction = await readText(resolve(opts.directionFile), 'direction')
    if (typeof opts.target === 'string' && opts.target.trim() !== '') target = opts.target
    else if (opts.targetFile) target = await readText(resolve(opts.targetFile), 'target')
  } catch (error) {
    blockers.push(error.message)
  }
  const targetConditioned = opts.targetConditioned === true
  if (phase === 'broad') {
    if (targetConditioned && !target) blockers.push('--target-conditioned needs --target or --target-file')
    if (!targetConditioned && !direction) blockers.push('a broad lineage needs --direction or --direction-file (or --target with --target-conditioned)')
  }
  if ((phase === 'deep' || phase === 'frozen') && !target) blockers.push(`a ${phase} lineage needs --target or --target-file`)
  let fixturesDir = null
  if (opts.fixturesDir) {
    fixturesDir = resolve(opts.fixturesDir)
    if (phase === 'broad') blockers.push('--fixtures applies to deep and frozen lineages only')
    const problem = await shapeGate(fixturesDir)
    if (problem) blockers.push(`--fixtures ${fixturesDir} is not replayable: ${problem}`)
  }

  // Store state.
  let memoryTreeAtStart = null
  let storeState = 'unknown'
  try {
    const store = await MemoryStore.open(pl.store, storeOptions(config, pl))
    try {
      try {
        await store.assertCanonicalIntact()
      } catch (error) {
        if (!(error instanceof MemoryTamperError)) throw error
        blockers.push('canonical memory changed outside a commit; inspect it with "cc-rsi memory verify" (a human may accept it or restore a history snapshot)')
      }
      const frozen = await store.frozen()
      const sealed = await store.sealed()
      storeState = frozen ? 'frozen' : sealed && !sealed.learningAfterSealed ? 'sealed' : 'learning'
      if (phase === 'broad' || phase === 'deep') {
        if (frozen) blockers.push('memory is frozen, so a learning lineage cannot start (Phase-3 reuse runs with --phase frozen; unfreezing is human-only)')
        if (sealed && sealed.learningAfterSealed !== true) blockers.push('memory has been used for a sealed evaluation, so learning is closed (a human can reopen it with "cc-rsi memory unfreeze --after-sealed")')
      } else if (phase === 'frozen') {
        if (!frozen) blockers.push('memory is not frozen; freeze it first ("cc-rsi memory freeze" or /cc-rsi:freeze)')
        else {
          try {
            await store.assertFrozenIntact()
          } catch (error) {
            blockers.push(`the frozen memory is not intact: ${error.message}`)
          }
        }
      }
      try {
        memoryTreeAtStart = await store.treeHash()
      } catch (error) {
        blockers.push(`canonical memory is not a valid tree: ${error.message}`)
      }
    } finally {
      await store.close()
    }
  } catch (error) {
    blockers.push(`the memory store cannot be opened: ${error.message}`)
  }

  // Isolation (J2-9).
  const want = config.isolation?.sandbox ?? 'auto'
  const probe = effectiveProbe(await readProbe(home), staticProbe({ env }))
  const decision = decideIsolation({ want, probe })
  const allowUnconfined = opts.allowUnconfined === true || config.isolation?.allowUnconfined === true
  if (want === 'require' && decision.refuse) {
    blockers.push(`the OS sandbox is required (isolation.sandbox=require) but unavailable: ${probe.reason}`)
  } else if (want === 'off' && !allowUnconfined) {
    blockers.push(`isolation.sandbox=off runs lineage children without an OS sandbox; lineage children would run Bash unattended and unconfined. Re-run with --allow-unconfined (or set isolation.allowUnconfined in ${globalConfigPath}) to accept this, preferably in a disposable container or VM.`)
  } else if (!decision.sandbox && !decision.refuse && !allowUnconfined) {
    blockers.push(`no OS sandbox is available (${decision.reason}); lineage children would run Bash unattended and unconfined. Re-run with --allow-unconfined (or set isolation.allowUnconfined in ${globalConfigPath}) to accept this, preferably in a disposable container or VM.`)
  }
  const isolation = { mode: decision.sandbox ? 'sandbox' : 'unconfined', reason: decision.reason, allowUnconfined }

  // Claude Code.
  const bin = resolveClaudeBin({ config, env })
  const ccVersion = await claudeVersion(bin)
  if (!ccVersion) blockers.push(`claude (${bin}) is missing or did not report a version; run "cc-rsi doctor"`)
  else {
    if (compareVersions(ccVersion, MIN_CC_VERSION) < 0) blockers.push(`claude ${ccVersion} is older than ${MIN_CC_VERSION}; update Claude Code`)
    const missing = await missingFlags(bin)
    if (missing.length > 0) blockers.push(`claude (${bin}) lacks required flags: ${missing.join(', ')}; run "cc-rsi doctor"`)
  }

  const { models, modelSources } = await resolveModels(opts, config, pl, env)
  const lineageConfig = lineageConfigOf(config)
  const cSha = configSha(lineageConfig)
  const fingerprint = await pluginFingerprint(pluginRoot)
  const lineage = {
    v: 1,
    id,
    phase,
    projectKey: key,
    projectRoot,
    createdAt: new Date().toISOString(),
    direction: direction !== null ? { text: direction, sha256: sha256Hex(direction) } : null,
    targetConditioned,
    target: target !== null ? { text: target, sha256: sha256Hex(target), fixturesCaptured: fixturesDir !== null, fixturesDir } : null,
    config: lineageConfig,
    configSha: cSha,
    models,
    modelSources,
    isolation,
    lock: {
      pluginRoot,
      pluginRev: fingerprint.pluginRev,
      guardSha: fingerprint.guardSha,
      ccVersion,
      promptSha: await pluginPromptShas(),
      configSha: cSha,
      driftAccepted: [],
    },
    memoryTreeAtStart,
    storeRoot: pl.store,
    workRoot: layout ? layout.W : null,
    home,
    startedBy: { sessionId: typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : null, cli: true },
  }
  // The auth preflight (J2-2) costs one tiny model call: createLineage runs it unless
  // skipAuthProbe; preflight runs it only when asked (`authProbe: true`, e.g. `explore preflight --live`).
  if (opts.authProbe === true && blockers.length === 0) {
    const failure = await authProbe({ home, config, model: models.summarizer, env, pluginRoot })
    if (failure) blockers.push(failure)
  }
  const ex = lineageConfig.exploration ?? {}
  const budget = phase === 'broad'
    ? `wave concurrency ${ex.waveConcurrency}, project budget ${ex.broadProjectBudget} (checked between waves)`
    : phase === 'deep'
      ? `practice budget ${ex.deepPracticeBudget || 'unbounded'}, target cycle budget ${ex.targetCycleBudget || 'unbounded'}, stop policy ${ex.stopPolicy}`
      : `repair rounds ${ex.frozenRepairRounds}`
  const plan = [
    `cc-rsi explore start — ${phase} lineage ${id}`,
    `project: ${projectRoot} (${key})`,
    direction !== null ? `direction: ${excerpt(direction)}` : null,
    target !== null ? `target: ${excerpt(target)}${fixturesDir ? ` (fixtures ${fixturesDir})` : ''}` : null,
    targetConditioned ? 'target-conditioned Phase-1 waves' : null,
    `models: actor=${models.actor ?? '(default)'} verifier=${models.verifier ?? '(default)'} curriculum=${models.curriculum ?? '(default)'} summarizer=${models.summarizer ?? '(default)'} escalation=${models.escalation ?? '(none)'}`,
    `isolation: ${isolation.mode} (${isolation.reason})${isolation.mode === 'unconfined' ? ' — WARNING: role children run Bash unattended without an OS sandbox' : ''}`,
    `memory: ${storeState}, tree ${memoryTreeAtStart ? memoryTreeAtStart.slice(0, 12) : '?'}`,
    `limits: ${budget}; cost ceiling ${ex.maxCostUsd ? `$${ex.maxCostUsd}` : 'off'}`,
    `claude: ${bin} ${ccVersion ?? '(unknown version)'}`,
    `records: ${layout ? layout.dir : '(invalid id)'}`,
    `work tree: ${layout ? layout.W : '(invalid id)'}`,
  ].filter(line => line !== null).join('\n')
  return { plan, blockers, lineage }
}

/**
 * One tiny summarizer-shaped child with the exact role flags, env and forwarded settings
 * (`--tools ""`, "Reply with the single word OK"). Returns null on success, else a blocker (J2-2).
 */
export async function authProbe({ home, config, model, env = process.env, pluginRoot = ENGINE_PLUGIN_ROOT } = {}) {
  const base = join(home, 'run', 'probe', `auth-${randomBytes(6).toString('hex')}`)
  const cwd = join(base, 'work')
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  try {
    const spec = {
      key: 'auth-probe', role: 'summarizer', phase: null, cwd, addDirs: [], tools: [], allow: [], deny: [],
      readRoots: [cwd], writeRoots: [], readOnlyRoots: [], hidden: [], hiddenTokens: [], bashDeny: [], sandbox: null,
      sandboxDegrade: 'refuse', systemText: 'You are a cc-rsi authentication probe. Reply with the single word OK.',
      model: model ?? null, effort: null, lossless: false, pinText: null, liveness: false, stagnationRevisit: null,
      maxTurns: 1, turnTimeoutSec: 300, pauseCeilingSecs: 0, watchdogMaxWaitMs: null, maxBudgetUsd: null,
      noSessionPersistence: true, extraEnv: {}, logDir: join(base, 'ctx'), home, pluginRoot, config,
    }
    const ctx = new RoleContext(spec, { sessionId: uuid(), parentEnv: env })
    await ctx.send('Reply with the single word OK.')
    return null
  } catch (error) {
    const cls = error?.cls ?? 'error'
    return `auth: the authentication probe failed (${cls}): ${error?.detail ?? error?.message ?? error}; run "cc-rsi doctor --live" (apiKeyHelper/env from ~/.claude/settings.json are forwarded automatically)`
  } finally {
    await removeTree(base).catch(() => undefined)
  }
}

/**
 * Creates a lineage (SPEC §12.2 start sequence) and starts its engine. Throws
 * CcRsiError('lineage_blocked', …, {blockers}) when a blocker (or the auth probe) refuses.
 * Options beyond §12.2: `skipAuthProbe`, `foreground` (await runEngine in-process; returns
 * `{id, dir, status}`), `spawn: false` (create only; the caller starts the engine), `env`.
 * Detached: `{id, dir, pid}`.
 */
export async function createLineage(opts = {}) {
  const env = opts.env ?? process.env
  const pre = await preflight({ ...opts, authProbe: false })
  const blockers = [...pre.blockers]
  const lineage = pre.lineage
  if (blockers.length === 0 && opts.skipAuthProbe !== true) {
    const config = effectiveConfig(opts)
    const failure = await authProbe({ home: lineage.home, config, model: lineage.models.summarizer, env, pluginRoot: lineage.lock.pluginRoot })
    if (failure) blockers.push(failure)
  }
  if (blockers.length > 0) {
    throw new CcRsiError('lineage_blocked', `explore start refused:\n- ${blockers.join('\n- ')}`, { blockers })
  }
  const { pl, layout } = layoutsFor(lineage)
  await mkdir(layout.dir, { recursive: true, mode: 0o700 })
  try {
    if (!(await exists(pl.projectJson))) {
      await writeJsonAtomic(pl.projectJson, { v: 1, key: lineage.projectKey, root: lineage.projectRoot, createdAt: new Date().toISOString() })
    }
    // 2. prompt snapshot (the lineage renders from it, so a plugin update never changes its texts).
    lineage.lock.promptSha = await snapshotPrompts(layout.promptsSnapshot)
    // Target fixtures are captured once, at creation (immutable from the start; replayed per attempt).
    if (lineage.target && lineage.target.fixturesDir) {
      await captureTree(lineage.target.fixturesDir, join(layout.priv, 'target-fixtures'))
      lineage.target.fixturesCaptured = true
    }
    // 4. records (lineage.json last: a lineage dir without it is an unfinished creation).
    await writeJsonAtomic(layout.stateJson, {
      v: 1, id: lineage.id, phase: lineage.phase, status: 'starting', pausedAt: null, infra: null, wave: 0, projectsDone: 0,
      targetCycles: 0, practiceProjects: 0, costUsd: 0, lastEvent: null, pid: null, updatedAt: new Date().toISOString(),
    })
    await writeJsonAtomic(layout.lineageJson, lineage)
  } catch (error) {
    if (!(await exists(layout.lineageJson))) await removeTree(layout.dir).catch(() => undefined)
    throw error
  }
  // 5. inert work repo + role-visible work tree (the engine re-ensures both at every start).
  await ensureWorkTree(lineage, layout)
  // 6. engine.
  if (opts.foreground === true) {
    const { runEngine } = await import('./daemon.mjs')
    const r = await runEngine(layout.dir, { env, signal: opts.signal })
    return { id: lineage.id, dir: layout.dir, status: r.status }
  }
  if (opts.spawn === false) return { id: lineage.id, dir: layout.dir }
  const pid = startEngine(layout.dir, { env, pluginRoot: lineage.lock.pluginRoot })
  return { id: lineage.id, dir: layout.dir, pid }
}

/**
 * `<home>/work` as an inert git repository (role git never discovers an enclosing repository) and
 * the lineage's role-visible work tree (SPEC §4.1, §4.3). Idempotent.
 */
export async function ensureWorkTree(lineage, layout) {
  await initInertRepo(join(lineage.home, 'work'))
  for (const dir of [layout.curriculum, layout.actorPrivate, layout.projects, layout.verify, layout.verifyScratchRoot, layout.summarizer]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }
}

/**
 * Spawns the detached engine for a lineage (SPEC §12.2 step 6):
 * `node <pluginRoot>/lib/engine/daemon.mjs <lineageDir>` with process.env minus CC_RSI_* and CLAUDECODE.
 */
export function startEngine(lineageDir, { env = process.env, pluginRoot = ENGINE_PLUGIN_ROOT } = {}) {
  const childEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('CC_RSI_') || name === 'CLAUDECODE') continue
    childEnv[name] = value
  }
  return spawnDetached(process.execPath, [join(pluginRoot, 'lib', 'engine', 'daemon.mjs'), lineageDir], {
    cwd: lineageDir, logFile: join(lineageDir, 'engine.log'), env: childEnv,
  })
}

// ------------------------------------------------------------------------------------------ results

/** Number of infra pauses recorded in events.jsonl (runtime LINEAGE_PAUSED with reason infra). */
export async function countInfraPauses(lineageDir) {
  return (await readJsonl(join(lineageDir, 'events.jsonl'))).filter(e => e && e.type === 'LINEAGE_PAUSED' && e.reason === 'infra').length
}

/**
 * The terminal record (SPEC §12.3 result.json, RSIAgent snake_case keys so it can be
 * cross-checked against RSIAgent records). `fields` uses camelCase inputs.
 */
export function resultRecord(lineage, fields = {}) {
  const record = {
    schema_version: 1,
    lineage: lineage.id,
    phase: lineage.phase,
    termination: fields.termination,
    rationale: fields.rationale ?? '',
    isolation: { mode: lineage.isolation?.mode ?? 'unconfined', reason: lineage.isolation?.reason ?? '' },
    stop_policy: lineage.config?.exploration?.stopPolicy ?? 'curriculum_review',
    waves: fields.waves ?? 0,
    projects: (fields.projects ?? []).map(p => ({
      id: p.id,
      wave: p.wave ?? null,
      episode: p.episode,
      instruction_sha256: p.instructionSha256 ?? null,
      verdict: p.verdict,
      report_sha256: p.reportSha ?? null,
      commit: p.commit
        ? { tree_before: p.commit.treeBefore, tree_after: p.commit.treeAfter, created: p.commit.created ?? [], modified: p.commit.modified ?? [], deleted: p.commit.deleted ?? [] }
        : null,
    })),
    target_cycles: fields.targetCycles ?? 0,
    practice_projects: fields.practiceProjects ?? 0,
    history: fields.history ?? [],
    target_verifier_verdict: fields.targetVerdict ?? null,
    curriculum_decision: fields.curriculumDecision ?? null,
    candidate_root: fields.candidateRoot ?? null,
    candidate_copy: fields.candidateCopy ?? null,
    candidate_digest: fields.candidateDigest ?? null,
    // Whether the live candidate root changed after the verdict (the same Actor learning in it);
    // the candidate copy above is always the verified tree (protocol-1). null without a candidate.
    candidate_changed_after_verdict: typeof fields.candidateChangedAfterVerdict === 'boolean' ? fields.candidateChangedAfterVerdict : null,
    initial_memory_tree_sha256: fields.initialTree ?? lineage.memoryTreeAtStart ?? null,
    final_memory_tree_sha256: fields.finalTree ?? null,
    frozen_tree_sha256: fields.frozenTree ?? null,
    official_evaluator_calls: 0,
    official_evaluator_feedback_entered_learning: false,
    models: { ...(lineage.models ?? {}) },
    cost_usd: Math.round((fields.costUsd ?? 0) * 1e6) / 1e6,
    infra_pauses: fields.infraPauses ?? 0,
    cc_version: lineage.lock?.ccVersion ?? null,
    lock_sha256: canonicalSha256(lineage.lock ?? {}),
    finished_at: new Date().toISOString(),
  }
  if (fields.learningAfterSealed === true) record.learning_after_sealed_evaluation = true
  return record
}

// ------------------------------------------------------------------------------------------ resume

/**
 * Drift between the lineage lock (or its last accepted drift) and the plugin tree this code runs
 * from: `{ diff: [reason], current }`. Checked at resume and before every role invocation
 * (security-4: a role that edited the role guard mid-run pauses the lineage).
 */
export async function pluginDrift(lineage, pluginRoot) {
  return driftOf(lineage, pluginRoot)
}

async function driftOf(lineage, pluginRoot) {
  const lock = lineage.lock ?? {}
  const diff = []
  const current = await pluginFingerprint(pluginRoot)
  const accepted = Array.isArray(lock.driftAccepted) && lock.driftAccepted.length > 0 ? lock.driftAccepted[lock.driftAccepted.length - 1] : null
  const baseline = accepted && accepted.to ? accepted.to : { pluginRoot: lock.pluginRoot, pluginRev: lock.pluginRev, guardSha: lock.guardSha }
  if (!lock.pluginRoot || !(await exists(lock.pluginRoot))) diff.push(`the plugin root recorded at start (${lock.pluginRoot}) is missing`)
  if (baseline.pluginRev !== current.pluginRev) diff.push('the engine/runtime/guard code (pluginRev) changed')
  if (baseline.guardSha !== current.guardSha) diff.push('hooks/role-guard.mjs (guardSha) changed')
  return { diff, current: { pluginRoot, ...current } }
}

/**
 * Pure admission for `explore resume` (SPEC §12.15; zero writes). Returns
 * `{ ok, reasons, overrides, notes, drift, acceptDrift, lineageDir }`; each reason prints as
 * `resume refused: <reason>`.
 */
export async function admitResume(lineageDir, { acceptDrift = false, pluginRoot = ENGINE_PLUGIN_ROOT, env = process.env } = {}) {
  const reasons = []
  const notes = []
  let lineage
  try {
    lineage = await readLineage(lineageDir)
  } catch (error) {
    return { ok: false, reasons: [error.message], overrides: [], notes, drift: null, acceptDrift, lineageDir }
  }
  if (await exists(join(lineageDir, 'result.json'))) reasons.push('the lineage has ended (result.json exists); completion, abandonment and quarantine are absorbing')
  const lock = await LeaseLock.inspect(join(lineageDir, 'engine.lock'))
  if (lock && lock.holder && !lock.stale) reasons.push(`the engine is running (pid ${lock.holder.pid} on ${lock.holder.host})`)
  const drift = await driftOf(lineage, pluginRoot)
  if (drift.diff.length > 0 && !acceptDrift) {
    reasons.push(`the plugin changed since the lineage started (${drift.diff.join('; ')}); re-run with --accept-drift to continue on the current plugin`)
  } else if (drift.diff.length > 0) notes.push(`drift accepted: ${drift.diff.join('; ')}`)
  try {
    const bin = resolveClaudeBin({ config: lineage.config, env })
    const version = await claudeVersion(bin)
    if (version && lineage.lock?.ccVersion && version !== lineage.lock.ccVersion) notes.push(`Claude Code changed from ${lineage.lock.ccVersion} to ${version}`)
  } catch {
    // Reported only.
  }
  const store = await readOnlyStoreState(lineage.storeRoot)
  if (!store.intact) reasons.push(`canonical memory changed outside a commit (expected tree ${String(store.expected).slice(0, 12)}, found ${String(store.actual).slice(0, 12)}); see "cc-rsi memory verify"`)
  if (lineage.phase === 'frozen') {
    if (!store.frozen) reasons.push('memory is no longer frozen; a frozen lineage needs the frozen tree it started with')
    else if (store.frozen.treeHash !== store.actual) reasons.push('the frozen memory is not intact')
  } else {
    if (store.frozen) reasons.push('memory is frozen, so this learning lineage cannot continue')
    if (store.sealed && store.sealed.learningAfterSealed !== true) reasons.push('memory has been used for a sealed evaluation, so learning is closed')
  }
  const state = await readState(lineageDir)
  const overrides = []
  if (state && typeof state.pausedAt === 'string' && OVERRIDE_KEY_RE.test(state.pausedAt) && state.status === 'paused_infra') overrides.push(state.pausedAt)
  return { ok: reasons.length === 0, reasons, overrides, notes, drift: drift.diff.length > 0 ? drift : null, acceptDrift, lineageDir }
}

/**
 * Applies an admission (SPEC §12.15): records the operator overrides for the paused liveness /
 * unverified / commit key, and the accepted drift (lineage.json lock.driftAccepted[] + DRIFT_ACCEPTED).
 * The caller then starts the engine (startEngine or runEngine).
 */
export async function applyResume(lineageDir, admission) {
  if (!admission || admission.ok !== true) {
    throw new CcRsiError('resume_refused', `resume refused: ${(admission?.reasons ?? ['admission missing']).join('; ')}`, { reasons: admission?.reasons ?? [] })
  }
  const lineage = await readLineage(lineageDir)
  const j = await OpJournal.open(lineageDir, { lineage: lineage.id })
  for (const key of admission.overrides ?? []) {
    if (j.hasOverride(key)) continue
    await j.addOverride(key, { by: 'cli', at: new Date().toISOString() })
    await appendRuntimeEvent(lineageDir, lineage.id, 'OVERRIDE_APPLIED', { key })
  }
  if (admission.drift && admission.acceptDrift) {
    // The lineage now runs the current code, whose builders may need templates (or template
    // sections) the start-time snapshot lacks: the snapshot is refreshed with the code it serves.
    const { layout } = layoutsFor(lineage)
    const promptSha = await snapshotPrompts(layout.promptsSnapshot)
    const entry = { at: new Date().toISOString(), diff: admission.drift.diff, to: admission.drift.current, promptsRefreshed: true }
    const next = { ...lineage, lock: { ...lineage.lock, promptSha, driftAccepted: [...(lineage.lock?.driftAccepted ?? []), entry] } }
    await writeJsonAtomic(join(lineageDir, 'lineage.json'), next)
    await j.event(`drift:${next.lock.driftAccepted.length}`, 'DRIFT_ACCEPTED', { diff: admission.drift.diff })
  }
  await j.flush()
  await writeState(lineageDir, { status: 'starting' })
}

/**
 * Abandons a paused lineage (SPEC §12.15): the engine must not be live; open drafts of this lineage
 * are discarded; result.json records termination 'abandoned' with the last infra detail (or
 * `reason`) as rationale.
 */
export async function abandon(lineageDir, { reason } = {}) {
  const lineage = await readLineage(lineageDir)
  if (await exists(join(lineageDir, 'result.json'))) throw new CcRsiError('lineage_terminal', `lineage ${lineage.id} has already ended`)
  const lock = new LeaseLock(join(lineageDir, 'engine.lock'), { owner: { kind: 'abandon', lineage: lineage.id } })
  if (!(await lock.acquire({ wait: false }))) {
    throw new CcRsiError('engine_live', `the engine of lineage ${lineage.id} is running; stop it first (cc-rsi explore stop ${lineage.id})`)
  }
  try {
    const state = (await readState(lineageDir)) ?? {}
    const { pl } = layoutsFor(lineage)
    const store = await MemoryStore.open(lineage.storeRoot, storeOptions(lineage.config, pl))
    let finalTree = null
    try {
      for (const draft of await store.drafts()) {
        if (draft.owner && draft.owner.kind === 'engine' && draft.owner.lineage === lineage.id && !draft.committed) await store.discardDraft(draft.episode)
      }
      try {
        finalTree = await store.treeHash()
      } catch {
        finalTree = null
      }
    } finally {
      await store.close()
    }
    const j = await OpJournal.open(lineageDir, { lineage: lineage.id })
    await j.event('abandon/ev', 'LINEAGE_ABANDONED', {})
    const record = resultRecord(lineage, {
      termination: 'abandoned',
      rationale: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : (state.infra?.detail ?? ''),
      targetCycles: state.targetCycles ?? 0,
      practiceProjects: state.practiceProjects ?? 0,
      waves: state.wave ?? 0,
      finalTree,
      costUsd: state.costUsd ?? 0,
      infraPauses: await countInfraPauses(lineageDir),
    })
    await writeState(lineageDir, { status: 'abandoned', pid: null })
    await writeFileAtomic(join(lineageDir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`)
    return record
  } finally {
    await lock.release()
  }
}

async function invocationSummary(logDir) {
  let names = []
  try {
    names = (await readdir(logDir)).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b)
  } catch {
    return { invocations: 0, lastClass: null, model: null }
  }
  if (names.length === 0) return { invocations: 0, lastClass: null, model: null }
  const meta = await readJsonSafe(join(logDir, String(names[names.length - 1]), 'meta.json'), null)
  return { invocations: names.length, lastClass: meta?.cls ?? null, model: meta?.model ?? null }
}

/**
 * Human summary of a lineage (SPEC §12.15, PN §4.10): state, then every role context with role, key,
 * session id, resolved model, invocation count and last class, plus a
 * `claude --resume <sid> --fork-session` hint to inspect it without mutating it. Never report text.
 */
export async function showLineage(lineageDir) {
  const lineage = await readLineage(lineageDir)
  const state = (await readState(lineageDir)) ?? {}
  const result = await readJsonSafe(join(lineageDir, 'result.json'), null)
  const lines = [`lineage ${lineage.id} (${lineage.phase}) — ${result ? `ended: ${result.termination}` : state.status ?? 'unknown'}`]
  lines.push(`project: ${lineage.projectRoot}`)
  lines.push(`isolation: ${lineage.isolation?.mode} (${lineage.isolation?.reason})`)
  lines.push(`counters: wave ${state.wave ?? 0}, projects ${state.projectsDone ?? 0}, target cycles ${state.targetCycles ?? 0}, practice projects ${state.practiceProjects ?? 0}, cost $${(state.costUsd ?? 0).toFixed(4)}`)
  if (state.status === 'paused_infra' || state.status === 'paused_user') {
    lines.push(`paused at: ${state.pausedAt ?? '(unknown op)'}${state.infra ? ` — ${state.infra.cls}: ${state.infra.detail}` : ''}`)
  }
  const j = await OpJournal.open(lineageDir, { lineage: lineage.id })
  const contexts = j.keysWithPrefix('').filter(key => key.endsWith('/open') && j.isDone(key)).map(key => key.slice(0, -'/open'.length))
  lines.push(contexts.length === 0 ? 'contexts: none yet' : 'contexts:')
  for (const key of contexts) {
    const opened = j.result(`${key}/open`) ?? {}
    let sessionId = opened.sessionId ?? null
    for (const restart of j.keysWithPrefix(`${key}/restart:`)) {
      if (j.isDone(restart) && /\/restart:\d+$/.test(restart)) sessionId = j.result(restart)?.sessionId ?? sessionId
    }
    const summary = await invocationSummary(join(lineageDir, 'ctx', safeName(key)))
    lines.push(`  ${opened.role ?? '?'}  ${key}  session ${sessionId ?? '?'}  model ${summary.model ?? opened.model ?? '(default)'}  invocations ${summary.invocations}  last ${summary.lastClass ?? '-'}`)
    // Summarizer calls run with --no-session-persistence: there is no transcript to fork.
    if (sessionId && opened.role !== 'summarizer') lines.push(`    inspect without mutating: claude --resume ${sessionId} --fork-session`)
  }
  return lines.join('\n')
}

/** Whether a state status is terminal. */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

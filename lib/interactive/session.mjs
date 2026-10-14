// Main-session state helpers (SPEC §11.1): which project a Claude Code session works in, its
// session.json, the effective configuration, the Verifier model resolution and the memory store.
//
// Hooks import this module on their hot path (SPEC §3 import boundaries), so it stays light:
// node:*, lib/core, lib/workspace/git.mjs and lib/runtime/models.mjs. The memory store is
// loaded lazily (`openStore`).
//
// The project identity follows SPEC §4.1: `dir` = CLAUDE_PROJECT_DIR (hooks, MCP) else the payload
// cwd; `root` = projectRoot(dir) (the git common dir's parent, so every worktree shares memory);
// `key` = projectKey(root). The (root, key) pair is cached per session in
// `<home>/run/sessions/<sid>.json` so the hooks do not run git on every event.

import { createHash } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonSafe, readJsonSafeSync, writeFileAtomic, writeJsonAtomic } from '../core/atomic.mjs'
import { loadConfig, userConfigFromEnv } from '../core/config.mjs'
import { CcRsiError } from '../core/errors.mjs'
import { ccRsiHome, globalLayout, isUnderLexical, projectKey, projectLayout, safeName, sessionLayout } from '../core/paths.mjs'
import { claudeConfigDir, resolveModel, userSettingsModelSync } from '../runtime/models.mjs'
import { gitTopLevel, projectRoot as gitProjectRoot, statusDigest } from '../workspace/git.mjs'

/** Option prefix of the plugin userConfig: hooks get CLAUDE_PLUGIN_OPTION_*, the MCP server CC_RSI_OPT_* (SPEC §14.1). */
export const HOOK_OPT_PREFIX = 'CLAUDE_PLUGIN_OPTION_'
export const MCP_OPT_PREFIX = 'CC_RSI_OPT_'

/** The session id of a hook payload or an attestation record. */
function sessionIdOf(payload) {
  const sid = payload?.session_id ?? payload?.sessionId
  return typeof sid === 'string' && sid.trim() !== '' ? sid.trim() : null
}

/** The directory a session's project is derived from (SPEC §4.1): CLAUDE_PROJECT_DIR, else the payload cwd. */
export function projectDirOf(payload, env = process.env) {
  const fromEnv = env?.CLAUDE_PROJECT_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return resolve(fromEnv)
  if (typeof payload?.cwd === 'string' && payload.cwd !== '') return resolve(payload.cwd)
  return process.cwd()
}

function cachePath(home, sid) {
  return join(globalLayout(home).runSessions, `${safeName(sid)}.json`)
}

/** The effective configuration for a project: DEFAULTS < global < project < userConfig (SPEC §5.2, §14). */
export function effectiveConfig({ home, projectRoot, env = process.env, optPrefix = HOOK_OPT_PREFIX, session = null } = {}) {
  const userConfig = optPrefix === MCP_OPT_PREFIX ? mcpUserConfig(env, session) : userConfigFromEnv(env, optPrefix)
  return loadConfig({ home, projectRoot, userConfig })
}

let manifestDefaults = null

/** The userConfig defaults the plugin manifest declares (`.claude-plugin/plugin.json`), `{ key: default }`. */
export function manifestOptionDefaults() {
  if (manifestDefaults === null) {
    manifestDefaults = {}
    try {
      const manifest = JSON.parse(readFileSync(join(CODE_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
      for (const [key, spec] of Object.entries(manifest?.userConfig ?? {})) {
        if (spec && typeof spec === 'object' && typeof spec.default === 'string') manifestDefaults[key] = spec.default
      }
    } catch {
      // no manifest: no substituted defaults are known
    }
  }
  return manifestDefaults
}

/** Whether a session record carries the plugin options its SessionStart hook saw. */
function recordedOptions(session) {
  const options = session?.pluginOptions
  return options && typeof options === 'object' && !Array.isArray(options) ? options : null
}

/**
 * The plugin userConfig as the MCP server must apply it (cc-integration-2). Claude Code substitutes
 * the manifest default of an option the user never saved into the server's env (CC_RSI_OPT_*), while
 * hooks see only saved options (CLAUDE_PLUGIN_OPTION_*), so the server would let a substituted
 * default (e.g. sandbox `auto`) override `~/.cc-rsi/config.json`. The options SessionStart recorded
 * from the hook env win; an env value for an option the record lacks counts only when it differs
 * from the manifest default (a substituted default is not a user choice). Without a record, the env.
 */
export function mcpUserConfig(env = process.env, session = null) {
  const fromEnv = userConfigFromEnv(env, MCP_OPT_PREFIX)
  const recorded = recordedOptions(session)
  if (!recorded) return fromEnv
  const defaults = manifestOptionDefaults()
  const out = {}
  for (const [key, value] of Object.entries(fromEnv)) {
    if (value !== '' && value !== (defaults[key] ?? '')) out[key] = value
  }
  for (const [key, value] of Object.entries(recorded)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Resolves the session's project and layouts (SPEC §11.1):
 * `{ home, g, sid, projectDir, projectRoot, key, pl, sl, session, config, configWarnings }`.
 * `payload` is a hook payload or an attestation record (`session_id`, `cwd`). With `create`
 * (default) the session directory, `<P>/project.json` and the per-session cache are written;
 * hooks on the hot path pass `create: false`. `config` may be passed to skip loading it.
 * Throws CcRsiError('no_session') when the payload carries no session id.
 */
export async function sessionContext({ payload, env = process.env, create = true, optPrefix = HOOK_OPT_PREFIX, config: given } = {}) {
  const sid = sessionIdOf(payload)
  if (sid === null) throw new CcRsiError('no_session', 'the hook payload carries no session_id')
  const home = ccRsiHome(env)
  const g = globalLayout(home)
  const projectDir = projectDirOf(payload, env)
  const cache = readJsonSafeSync(cachePath(home, sid), null)
  let root
  let key
  if (cache && cache.projectDir === projectDir && typeof cache.projectRoot === 'string' && typeof cache.projectKey === 'string') {
    root = cache.projectRoot
    key = cache.projectKey
  } else {
    root = await gitProjectRoot(projectDir)
    key = projectKey(root)
    // The index is always cached (even for read-only callers), so later hot-path calls of a session
    // whose SessionStart hook never ran do not run git again.
    try {
      await writeJsonAtomic(cachePath(home, sid), { v: 1, sessionId: sid, projectDir, projectRoot: root, projectKey: key, at: new Date().toISOString() })
    } catch {
      // An unwritable home only costs speed.
    }
  }
  let config
  let configWarnings = []
  if (given && typeof given === 'object') {
    config = given
  } else {
    const loaded = effectiveConfig({ home, projectRoot: root, env, optPrefix })
    config = loaded.config
    configWarnings = loaded.warnings
  }
  const storeDir = typeof config?.memory?.dir === 'string' && config.memory.dir !== '' ? config.memory.dir : undefined
  const pl = projectLayout(home, key, { storeDir })
  const sl = sessionLayout(pl, sid)
  if (create) {
    mkdirSync(sl.dir, { recursive: true, mode: 0o700 })
    try {
      await writeFileAtomicOnce(pl.projectJson, `${JSON.stringify({ v: 1, key, root, createdAt: new Date().toISOString() }, null, 2)}\n`)
    } catch {
      // project.json is informational; a failure never blocks a session.
    }
  }
  const read = await readJsonSafe(sl.sessionJson, null)
  const session = read && typeof read === 'object' && !Array.isArray(read) ? read : null
  if (!(given && typeof given === 'object') && optPrefix === MCP_OPT_PREFIX && recordedOptions(session)) {
    // The MCP server applies the options its session's hooks see (memory.dir, which places the
    // session directory, is global-only and never a plugin option, so `sl` stays valid).
    const loaded = effectiveConfig({ home, projectRoot: root, env, optPrefix, session })
    config = loaded.config
    configWarnings = loaded.warnings
  }
  return { home, g, sid, projectDir, projectRoot: root, key, pl, sl, session, config, configWarnings }
}

/** Writes `path` only when it does not exist yet (atomic; a concurrent first writer wins). */
async function writeFileAtomicOnce(path, text) {
  if (readJsonSafeSync(path, null) !== null) return
  await writeFileAtomic(path, text)
}

/** Atomic merge of `patch` into `<sl>/session.json` (SPEC §11.1). Returns the merged record. */
export async function writeSession(sl, patch = {}) {
  const current = await readJsonSafe(sl.sessionJson, null)
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : { v: 1 }
  const next = { ...base, ...patch, v: 1 }
  await writeJsonAtomic(sl.sessionJson, next)
  return next
}

/**
 * The session record of the spawn-time session (`CLAUDE_CODE_SESSION_ID`), or null (SPEC §11.4
 * step 5: `status` falls back to it when the call is unattested). Returns the session.json record
 * with `_ctx` = `{ home, sid, key, pl, sl }` attached (non-enumerable).
 */
export async function readSessionByEnv(env = process.env) {
  const sid = typeof env?.CLAUDE_CODE_SESSION_ID === 'string' ? env.CLAUDE_CODE_SESSION_ID.trim() : ''
  if (sid === '') return null
  const home = ccRsiHome(env)
  const cache = readJsonSafeSync(cachePath(home, sid), null)
  if (!cache || typeof cache.projectKey !== 'string') return null
  let loaded = effectiveConfig({ home, projectRoot: cache.projectRoot, env, optPrefix: MCP_OPT_PREFIX })
  const storeDir = loaded.config.memory.dir || undefined
  const pl = projectLayout(home, cache.projectKey, { storeDir })
  const sl = sessionLayout(pl, sid)
  const session = await readJsonSafe(sl.sessionJson, null)
  if (!session || typeof session !== 'object') return null
  if (recordedOptions(session)) loaded = effectiveConfig({ home, projectRoot: cache.projectRoot, env, optPrefix: MCP_OPT_PREFIX, session })
  Object.defineProperty(session, '_ctx', { value: { home, sid, key: cache.projectKey, projectRoot: cache.projectRoot, pl, sl, config: loaded.config }, enumerable: false })
  return session
}

async function realOr(path) {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The candidate root of a working directory (PR §4.3): the git top level (so `EnterWorktree`
 * sessions verify their own worktree); outside git, the session's project directory when `dir`
 * lies inside it (a `cd` into a subdirectory does not shrink the candidate), else `dir` itself.
 * Realpath'd.
 */
export async function workspaceRootFor(dir, { projectDir } = {}) {
  const top = await gitTopLevel(dir)
  if (top) return realOr(top)
  const target = await realOr(dir)
  if (typeof projectDir === 'string' && projectDir !== '') {
    const project = await realOr(projectDir)
    if (isUnderLexical(target, project)) return project
  }
  return target
}

/** Relative paths of harness state (`<home>`, an external store) that lie inside `root`, for git and checkpoint excludes. */
export function harnessExcludes(root, paths = []) {
  const out = []
  let realRoot = root
  try { realRoot = realpathSync(root) } catch { /* keep */ }
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') continue
    let target = resolve(p)
    try { target = realpathSync(target) } catch { /* not created yet */ }
    for (const base of new Set([root, realRoot])) {
      if (target !== base && isUnderLexical(target, base)) {
        const rel = relative(base, target).split(sep).join('/')
        if (rel !== '' && !rel.startsWith('..')) out.push(rel)
      }
    }
  }
  return [...new Set(out)]
}

/**
 * statusDigest of a candidate root with harness state excluded (SPEC §11.3). Every staleness
 * comparison (UPS open digest, Stop, learn, status, the job) uses this one helper, so the digests
 * are always computed the same way. Null outside git, on failure or after `timeoutMs`.
 */
export async function workspaceDigest(root, { home, storeDir, timeoutMs = 3000 } = {}) {
  if (typeof root !== 'string' || root === '') return null
  try {
    return await statusDigest(root, { exclude: harnessExcludes(root, [home, storeDir]), timeoutMs })
  } catch {
    return null
  }
}

/**
 * The Verifier model for this session (SPEC §10.3 chain): configured `models.verifier`, else the
 * session model (SessionStart / PostModelSwitch), else ANTHROPIC_MODEL, else the user settings
 * model, else null (Claude Code's default). Returns `{ model, source }`.
 */
export function resolveVerifierModel(config, session, env = process.env) {
  return resolveModel(config?.models?.verifier ?? '', {
    sessionModel: session?.model ?? null,
    env,
    userSettingsModel: userSettingsModelSync(env),
  })
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/**
 * The model of the last main-thread assistant record in a Claude Code transcript (`message.model`;
 * sidechains and `<synthetic>` records skipped), read from the file's tail only; null when unknown.
 */
export function transcriptModelSync(path) {
  if (typeof path !== 'string' || path === '') return null
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const { size } = fstatSync(fd)
    if (size === 0) return null
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    if (length < size) lines.shift() // the first line may be cut
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"assistant"')) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (record?.type !== 'assistant' || record.isSidechain === true) continue
      const model = record.message?.model
      if (typeof model === 'string' && model.trim() !== '' && !model.startsWith('<')) return model.trim()
    }
    return null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * Fills session.json's model from the transcript when no hook reported one (cc-integration-3: the
 * 2.1.296 SessionStart payload carries no model and PostModelSwitch fires only on /model, so a
 * `--model` session would otherwise leave the inheriting Verifier on Claude Code's default). A model
 * from SessionStart or PostModelSwitch is never overridden; a transcript-derived one is refreshed.
 * Only an existing session record is updated. Returns the session model (or null).
 */
export async function recordTranscriptModel(ctx, transcriptPath) {
  const session = await readJsonSafe(ctx.sl.sessionJson, null)
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const known = typeof session.model === 'string' && session.model !== '' ? session.model : null
  if (known !== null && session.modelSource !== 'transcript') return known
  const path = typeof transcriptPath === 'string' && transcriptPath !== '' ? transcriptPath : session.transcriptPath
  const model = transcriptModelSync(path)
  if (model === null || model === known) return known
  await writeSession(ctx.sl, { model, modelSource: 'transcript' })
  if (ctx.session && typeof ctx.session === 'object') Object.assign(ctx.session, { model, modelSource: 'transcript' })
  return model
}

/** MemoryStore options for a project (SPEC §6.3, WAVE_A_NOTES WP1: sessionsDir/lineagesDir for draft liveness). */
export function storeOptions(config, pl, { lockWaitMs = 10000, logger } = {}) {
  const memory = config?.memory ?? {}
  return {
    limits: { maxFiles: memory.maxFiles ?? 400, maxTotalBytes: memory.maxTotalBytes ?? 4194304, maxFileBytes: memory.maxFileBytes ?? 65536 },
    keepHistory: memory.keepHistory !== false,
    sealedTextFiles: Array.isArray(config?.audit?.sealedTextFiles) ? config.audit.sealedTextFiles : [],
    shingleWords: config?.audit?.shingleWords ?? 8,
    logger,
    lockOptions: { waitMs: lockWaitMs },
    sessionsDir: pl.sessions,
    lineagesDir: pl.lineages,
  }
}

/** Opens (and recovers) the project's memory store; loaded lazily so hooks that never need it stay fast. */
export async function openStore(config, pl, opts = {}) {
  const { MemoryStore } = await import('../memory/store.mjs')
  return MemoryStore.open(pl.store, storeOptions(config, pl, opts))
}

/**
 * A store handle WITHOUT recovery (no lock, no writes unless the inventory cache is missing):
 * read-only callers (`status`, the UserPromptSubmit view check) use it.
 */
export async function peekStore(config, pl, opts = {}) {
  const { MemoryStore } = await import('../memory/store.mjs')
  return new MemoryStore(pl.store, storeOptions(config, pl, opts))
}

const LIVE_LINEAGE = new Set(['starting', 'running', 'paused_user', 'paused_infra'])

/**
 * Lineage summaries of the project (ids, phase, status, counters; never report text or scores):
 * `[{ id, phase, status, wave, projectsDone, targetCycles, practiceProjects, live }]`, sorted by id.
 */
export function lineageStates(pl) {
  let names = []
  try {
    names = readdirSync(pl.lineages)
  } catch {
    return []
  }
  const out = []
  for (const name of names.sort()) {
    const state = readJsonSafeSync(join(pl.lineages, name, 'state.json'), null)
    if (!state || typeof state !== 'object') continue
    const status = typeof state.status === 'string' ? state.status : 'unknown'
    out.push({
      id: typeof state.id === 'string' ? state.id : name,
      phase: typeof state.phase === 'string' ? state.phase : 'unknown',
      status,
      wave: Number.isInteger(state.wave) ? state.wave : null,
      projectsDone: Number.isInteger(state.projectsDone) ? state.projectsDone : null,
      targetCycles: Number.isInteger(state.targetCycles) ? state.targetCycles : null,
      practiceProjects: Number.isInteger(state.practiceProjects) ? state.practiceProjects : null,
      live: LIVE_LINEAGE.has(status),
    })
  }
  return out
}

/** `(wave 2, 5 projects)`-style counters of a lineage summary, or ''. */
export function lineageCounters(l) {
  const parts = []
  if (l.wave !== null) parts.push(`wave ${l.wave}`)
  if (l.projectsDone !== null) parts.push(`${l.projectsDone} projects`)
  if (l.targetCycles !== null) parts.push(`${l.targetCycles} target cycles`)
  if (l.practiceProjects !== null) parts.push(`${l.practiceProjects} practice projects`)
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
}

/** The root of the code that is running (`lib/interactive/../..`). Programs cc-rsi spawns by path live here. */
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The plugin directories whose files decide verdicts (code the harness runs from disk, and the role prompts). */
export const FINGERPRINT_DIRS = Object.freeze(['lib', 'hooks', 'bin', 'mcp', 'prompts'])

/**
 * sha256 over `rel\0sha256(file)\n` of every regular file under FINGERPRINT_DIRS of `root`, sorted
 * by relative path (security-4): SessionStart records it, so a later run can tell that the plugin
 * code changed under a session (each verification spawns verify-job.mjs and the hooks from disk).
 */
export function pluginCodeFingerprint(root = CODE_ROOT) {
  const rels = []
  const walk = rel => {
    let entries = []
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) rels.push(child)
    }
  }
  for (const dir of FINGERPRINT_DIRS) walk(dir)
  rels.sort()
  const outer = createHash('sha256')
  for (const rel of rels) {
    let digest = '-'
    try { digest = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex') } catch { digest = '-' }
    outer.update(`${rel}\0${digest}\n`)
  }
  return outer.digest('hex')
}

/** Lexical and physical spellings of `path` (the physical one only when it exists). */
function rootSpellings(path) {
  const out = new Set([resolve(path)])
  try { out.add(realpathSync(path)) } catch { /* lexical only */ }
  return [...out]
}

/**
 * Whether the session's project is the cc-rsi checkout the plugin code runs from (developing cc-rsi
 * with cc-rsi): a plugin root inside the project that is not an installed plugin under the Claude
 * config dir, or the project inside a plugin root. The code-integrity rules (security-4) are not
 * enforced then. `roots` defaults to CODE_ROOT and the reported plugin root (both spellings).
 */
export function developsPlugin(projectRoot, { env = process.env, roots, userHome } = {}) {
  const home = typeof userHome === 'string' && userHome !== '' ? userHome : (typeof env?.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir())
  if (typeof projectRoot !== 'string' || projectRoot === '' || projectRoot === '/' || resolve(projectRoot) === resolve(home)) return false
  const list = roots ?? [...new Set([CODE_ROOT, pluginRootOf(env)])].flatMap(rootSpellings)
  const configDir = resolve(claudeConfigDir(env))
  const installed = r => isUnderLexical(r, configDir) || isUnderLexical(r, join(home, '.claude'))
  return list.some(r => (isUnderLexical(r, projectRoot) && !installed(r)) || isUnderLexical(projectRoot, r))
}

/**
 * The plugin code check before a verification (security-4 part 3): every verdict runs
 * verify-job.mjs, the hooks and the role guard from disk, so code changed after SessionStart
 * recorded its fingerprint must not judge. Returns `{ recorded, current }` when the code changed,
 * else null (no fingerprint recorded, or developing cc-rsi itself).
 */
export function pluginCodeChanged(session, { projectRoot, env = process.env } = {}) {
  const recorded = session?.pluginFingerprint
  if (typeof recorded !== 'string' || recorded === '') return null
  if (developsPlugin(projectRoot, { env })) return null
  const current = pluginCodeFingerprint(CODE_ROOT)
  return current === recorded ? null : { recorded, current }
}

/**
 * The plugin root Claude Code reports (CLAUDE_PLUGIN_ROOT for hooks, CC_RSI_PLUGIN_ROOT for the MCP
 * server), else CODE_ROOT. Used for records and the `<home>/bin` shim; spawned programs always come
 * from CODE_ROOT.
 */
export function pluginRootOf(env = process.env) {
  const fromEnv = env?.CLAUDE_PLUGIN_ROOT || env?.CC_RSI_PLUGIN_ROOT
  if (typeof fromEnv === 'string' && fromEnv !== '' && !/^\$\{/.test(fromEnv)) return resolve(fromEnv)
  return CODE_ROOT
}

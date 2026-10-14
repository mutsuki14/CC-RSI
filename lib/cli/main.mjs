// `cc-rsi` command-line interface (SPEC §13.1): argument parsing, dispatch, the role-context and
// human-only refusals, and the helpers every subcommand module shares.
//
// Trust boundaries kept here (SPEC §2):
//  - inside a cc-rsi role child (`CC_RSI_ROLE` set) every command refuses with exit 64 (J2-4);
//  - human-only commands (★ in §13.1) refuse with exit 65 whenever `CLAUDECODE` is set, which Claude
//    Code sets in every subprocess, including skill `!` injection and the Bash tool (J2-6). The
//    main-session guard also denies them to model Bash (§11.8); this is the second, independent
//    refusal.
//
// Every subcommand module exports `run(args, io)` → exit code, where
// `io = { stdout, stderr, env, cwd, isTTY }` (`stdout`/`stderr` have `write(text)`).
//
// `--report-exit` (after the command word) is for skill `!` injection, where any non-zero exit aborts
// the whole skill and Claude never sees its instructions: the CLI then prints `[cc-rsi exit N]` as its
// last stdout line and exits 0, so blockers, FAIL checks and refusals reach Claude in-band.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonSafeSync } from '../core/atomic.mjs'
import { loadConfig, USERCONFIG_MAP, userConfigFromEnv } from '../core/config.mjs'
import { CcRsiError, HumanOnlyError, RoleContextError, UsageError } from '../core/errors.mjs'
import { createLogger } from '../core/log.mjs'
import { sameMachine } from '../core/machine.mjs'
import { ccRsiHome, globalLayout, projectKey, projectLayout, safeName, sessionLayout } from '../core/paths.mjs'
import { claudeConfigDir } from '../runtime/models.mjs'

/** The plugin root this CLI runs from (`lib/cli/../..`). */
export const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The plugin version (`.claude-plugin/plugin.json`), else '0.1.0'. */
export const VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(join(CLI_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

/** Exit codes (SPEC §13.1). */
export const EXIT = Object.freeze({ ok: 0, error: 1, usage: 2, refused: 3, role: 64, humanOnly: 65 })

/** Error codes that mean "refused by a blocker" (exit 3) rather than a failure (exit 1). */
const REFUSAL_CODES = new Set([
  'refused', 'lineage_blocked', 'resume_refused', 'engine_live', 'lineage_terminal', 'workspace_busy',
  'memory_frozen', 'memory_sealed', 'memory_tamper', 'memory_frozen_tamper', 'memory_not_frozen', 'memory_quarantined',
  'memory_conflict', 'memory_limit', 'eval_refused',
])

const USAGE = `usage: cc-rsi <command> [options]

  status [--json] [--session <sid>] [--project <dir>]
  doctor [--live] [--json] [--session <sid>] [--release-lock <root>*]
  memory show [<rel>] | inventory | history | log [-n N] | verify [--accept-external*] | restore <N>*
         | freeze | unfreeze [--after-sealed]* | export <dir> | import <dir>* | drafts [--prune*]
  explore preflight <start options>
  explore start --phase broad|deep|frozen [--direction TEXT|--direction-file F] [--target TEXT|--target-file F]
          [--target-conditioned] [--fixtures DIR] [--id ID] [--model M] [--actor-model M] [--verifier-model M]
          [--curriculum-model M] [--escalation-model M] [--summarizer-model M] [--allow-unconfined]
          [--skip-auth-probe] [--foreground] [--yes] [--session <sid>]
  explore status [<id>] [--json] | log <id> [--follow] [-n N] | stop <id> | resume <id> [--accept-drift] [--foreground]
          | abandon <id>* | show <id> | list
  eval run <lineage> [--retries N] [--json-out PATH]* | eval show <lineage> [--run R]*
  verify cancel [--session <sid>] [--grace SECONDS]*
  gc [--older-than DAYS] [--dry-run] [--streams] [--project <dir> [--session <sid>]]
  engine run <lineageDir>
  version

Most commands accept --project <dir> (default: the current directory's project).
* human-only: refused inside Claude Code (CLAUDECODE is set); run it in a terminal. Every session
  start refreshes the terminal shim <home>/bin/cc-rsi (default ~/.cc-rsi/bin/cc-rsi); put that
  directory on your PATH once, or run node <plugin root>/bin/cc-rsi.
--report-exit (after the command): print "[cc-rsi exit N]" last and exit 0 (for skill injection).

Configuration, lowest to highest precedence: built-in defaults < <home>/config.json
  < <project>/.claude/cc-rsi.json < plugin options (verifier_model, stop_policy, sandbox) as saved
  by Claude Code in \${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json pluginConfigs["cc-rsi@<marketplace>"]
  (or "cc-rsi@inline"), overridden by CLAUDE_PLUGIN_OPTION_* when set < command-line options.
  sandbox=require saved for any cc-rsi install applies. CC_RSI_HOME moves <home>.
Exit codes: 0 ok, 1 error, 2 usage, 3 refused by a blocker, 64 role context, 65 human-only.
`

/** The default io: the process streams, environment and working directory. */
export function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdout.isTTY === true,
  }
}

function normalizeIo(io) {
  const base = defaultIo()
  const given = io && typeof io === 'object' ? io : {}
  const stdout = given.stdout ?? base.stdout
  return {
    stdout,
    stderr: given.stderr ?? base.stderr,
    env: given.env ?? base.env,
    cwd: resolve(given.cwd ?? base.cwd),
    isTTY: typeof given.isTTY === 'boolean' ? given.isTTY : given.stdout ? stdout.isTTY === true : base.isTTY,
  }
}

/** Writes `text` and a newline to io.stdout. */
export function say(io, text = '') {
  io.stdout.write(`${text}\n`)
}

/** Writes `text` and a newline to io.stderr. */
export function warn(io, text = '') {
  io.stderr.write(`${text}\n`)
}

/**
 * Dependency-free argument parser (SPEC §13.1): `--key value`, `--key=value`, `--flag`, aliases
 * such as `-n 5`, and `--` to end options. Options may appear anywhere.
 * `spec = { string: [names], boolean: [names], alias: { n: 'n' }, optional: [names] }` (names without
 * dashes). Repeated string options keep the last value. An `optional` string option (default:
 * `session`) given without a value is ignored instead of refused. Unknown options, a missing value, or a value given
 * to a boolean throw UsageError. Returns `{ positionals, options }`.
 */
export function parseArgs(argv, spec = {}) {
  const strings = new Set(spec.string ?? [])
  const booleans = new Set(spec.boolean ?? [])
  const optional = new Set(spec.optional ?? ['session'])
  const alias = spec.alias ?? {}
  const positionals = []
  const options = {}
  const list = Array.isArray(argv) ? argv.map(String) : []
  for (let i = 0; i < list.length; i++) {
    const token = list[i]
    if (token === '--') {
      positionals.push(...list.slice(i + 1))
      break
    }
    let name = null
    let inline
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      name = eq >= 0 ? token.slice(2, eq) : token.slice(2)
      inline = eq >= 0 ? token.slice(eq + 1) : undefined
    } else if (/^-[A-Za-z]$/.test(token)) {
      const short = token.slice(1)
      if (!Object.prototype.hasOwnProperty.call(alias, short)) throw new UsageError(`unknown option ${token}`)
      name = alias[short]
    } else {
      positionals.push(token)
      continue
    }
    if (booleans.has(name)) {
      if (inline !== undefined) throw new UsageError(`option --${name} takes no value`)
      options[name] = true
    } else if (strings.has(name)) {
      let value = inline
      if (value === undefined) {
        const next = list[i + 1]
        if (next === undefined || (next.startsWith('--') && next.length > 2)) {
          // `--session ${CLAUDE_SESSION_ID}` from a skill whose variable expanded to nothing: no session.
          if (optional.has(name)) continue
          throw new UsageError(`option --${name} needs a value`)
        }
        value = next
        i++
      }
      options[name] = value
    } else {
      throw new UsageError(`unknown option ${token.split('=')[0]}`)
    }
  }
  return { positionals, options }
}

/** Throws UsageError when an option outside `allowed` was given (per-subcommand option sets). */
export function onlyOptions(options, allowed, what) {
  const ok = new Set(allowed)
  for (const name of Object.keys(options)) {
    if (!ok.has(name)) throw new UsageError(`option --${name} does not apply to "${what}"`)
  }
}

/** A non-negative integer option value, or `fallback` when absent (UsageError when malformed). */
export function intOption(options, name, fallback) {
  if (options[name] === undefined) return fallback
  const text = String(options[name])
  if (!/^\d+$/.test(text)) throw new UsageError(`option --${name} needs a non-negative integer (got ${JSON.stringify(text)})`)
  return Number.parseInt(text, 10)
}

/**
 * Refuses a human-only command inside Claude Code (SPEC §13.1 ★, J2-6): `CLAUDECODE` is set in
 * every Claude Code subprocess, including the Bash tool and skill `!` injection.
 */
export function requireHuman(io, label) {
  const value = io?.env?.CLAUDECODE
  if (typeof value === 'string' && value !== '') throw new HumanOnlyError(label)
}

/** `text` quoted for a POSIX shell when it holds anything but plain path characters. */
export function shellQuote(text) {
  const s = String(text)
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * The command line a human runs in a terminal for `args` (portability-6): the shim
 * `<home>/bin/cc-rsi` when SessionStart wrote it, else `node <plugin root>/bin/cc-rsi`. Absolute,
 * because the user's terminal PATH may not hold `<home>/bin`.
 */
export function terminalCommand(env, args = []) {
  const shim = globalLayout(ccRsiHome(env)).binShim
  const head = existsSync(shim) ? shellQuote(shim) : `node ${shellQuote(join(CLI_ROOT, 'bin', 'cc-rsi'))}`
  return [head, ...args.map(shellQuote)].join(' ')
}

/** The marketplace a plugin root was installed from (`…/plugins/cache/<marketplace>/cc-rsi/<version>`), or null. */
function marketplaceOf(pluginRoot) {
  const parts = String(pluginRoot ?? '').split(sep)
  for (let i = 0; i + 3 < parts.length; i++) {
    if (parts[i] === 'plugins' && parts[i + 1] === 'cache' && parts[i + 3] === 'cc-rsi' && parts[i + 2] !== '') return parts[i + 2]
  }
  return null
}

/** The cc-rsi option values of one `pluginConfigs` entry: non-empty strings of the known keys only. */
function knownOptions(options) {
  const out = {}
  if (!options || typeof options !== 'object' || Array.isArray(options)) return out
  for (const key of Object.keys(USERCONFIG_MAP)) {
    const value = options[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim()
  }
  return out
}

/**
 * The plugin options the user saved in Claude Code (portability-3). Claude Code exports them as
 * `CLAUDE_PLUGIN_OPTION_*` to hooks only, so a terminal or skill-injected CLI reads them where Claude
 * Code stores them: `pluginConfigs["cc-rsi@<marketplace>"].options` in the user settings
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` (`cc-rsi@inline` for `--plugin-dir`). The entry of
 * the marketplace this CLI was installed from wins, else the only cc-rsi entry; `sandbox: require`
 * saved for any cc-rsi entry applies (it only refuses). Sensitive options are never stored there and
 * are not used. Returns `{ options, source }` (source null when nothing applies).
 */
export function savedPluginOptions(env, { pluginRoot = CLI_ROOT } = {}) {
  const file = join(claudeConfigDir(env), 'settings.json')
  const settings = readJsonSafeSync(file, null)
  const configs = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.pluginConfigs : null
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return { options: {}, source: null }
  const entries = Object.entries(configs).filter(([id]) => id.startsWith('cc-rsi@')).map(([id, value]) => [id, knownOptions(value?.options)])
  if (entries.length === 0) return { options: {}, source: null }
  const marketplace = marketplaceOf(pluginRoot)
  const preferred = marketplace ? `cc-rsi@${marketplace}` : 'cc-rsi@inline'
  const pick = entries.find(([id]) => id === preferred) ?? (entries.length === 1 ? entries[0] : null)
  const options = pick ? { ...pick[1] } : {}
  const requiring = entries.find(([, values]) => values.sandbox === 'require')
  if (requiring) options.sandbox = 'require'
  const used = pick ?? requiring
  if (!used || Object.keys(options).length === 0) return { options: {}, source: null }
  return { options, source: `${file} pluginConfigs["${used[0]}"]` }
}

/**
 * The userConfig layer of the CLI's configuration: the saved plugin options, overridden by
 * `CLAUDE_PLUGIN_OPTION_*` where Claude Code set them (hook processes). `{ options, source }`.
 */
export function pluginUserConfig(env) {
  const saved = savedPluginOptions(env)
  const fromEnv = userConfigFromEnv(env, 'CLAUDE_PLUGIN_OPTION_')
  const options = { ...saved.options, ...fromEnv }
  const sources = [saved.source, Object.keys(fromEnv).length > 0 ? 'CLAUDE_PLUGIN_OPTION_*' : null].filter(Boolean)
  return { options, source: sources.length > 0 ? sources.join(' + ') : null }
}

/** A CcRsiError that exits 3 (refused by a blocker). */
export function refusal(message, details = {}) {
  const error = new CcRsiError('refused', message, details)
  error.exitCode = EXIT.refused
  return error
}

/** MemoryStore.open options for a project (WAVE_A_NOTES WP1: sessionsDir/lineagesDir for draft liveness). */
export function storeOptions(config, pl, { logger, lockWaitMs = 30000 } = {}) {
  const memory = config?.memory ?? {}
  const audit = config?.audit ?? {}
  return {
    limits: { maxFiles: memory.maxFiles ?? 400, maxTotalBytes: memory.maxTotalBytes ?? 4194304, maxFileBytes: memory.maxFileBytes ?? 65536 },
    keepHistory: memory.keepHistory !== false,
    sealedTextFiles: Array.isArray(audit.sealedTextFiles) ? audit.sealedTextFiles : [],
    shingleWords: Number.isInteger(audit.shingleWords) ? audit.shingleWords : 8,
    lockOptions: { waitMs: lockWaitMs },
    sessionsDir: pl.sessions,
    lineagesDir: pl.lineages,
    ...(logger ? { logger } : {}),
  }
}

/** Opens (and recovers) the project's memory store. */
export async function openStore(ctx) {
  const { MemoryStore } = await import('../memory/store.mjs')
  return MemoryStore.open(ctx.pl.store, storeOptions(ctx.config, ctx.pl, { logger: ctx.logger }))
}

/**
 * Resolves the project a command works on (SPEC §4.1: the CLI's --project or cwd; with --session the
 * session's cached project), its key, layouts and effective configuration:
 * `{ home, g, sid, projectDir, projectRoot, key, pl, sl, config, warnings, sources, pluginOptions, logger }`.
 * The userConfig layer is the saved plugin options (pluginUserConfig; portability-3).
 */
export async function projectContext(io, { project, session } = {}) {
  const home = ccRsiHome(io.env)
  const g = globalLayout(home)
  const sid = typeof session === 'string' && session.trim() !== '' ? session.trim() : null
  let projectDir = null
  let cached = null
  if (typeof project === 'string' && project !== '') {
    projectDir = resolve(io.cwd, project)
  } else if (sid) {
    cached = readJsonSafeSync(join(g.runSessions, `${safeName(sid)}.json`), null)
    if (cached && typeof cached.projectRoot === 'string' && typeof cached.projectKey === 'string') projectDir = cached.projectRoot
    else cached = null
  }
  if (projectDir === null) projectDir = io.cwd
  const info = await stat(projectDir).catch(() => null)
  if (!info || !info.isDirectory()) throw new UsageError(`project directory ${projectDir} does not exist`)
  let root
  let key
  if (cached && cached.projectRoot === projectDir) {
    root = cached.projectRoot
    key = cached.projectKey
  } else {
    const { projectRoot } = await import('../workspace/git.mjs')
    root = await projectRoot(projectDir)
    key = projectKey(root)
  }
  const pluginOptions = pluginUserConfig(io.env)
  const loaded = loadConfig({ home, projectRoot: root, userConfig: pluginOptions.options })
  const storeDir = typeof loaded.config.memory?.dir === 'string' && loaded.config.memory.dir !== '' ? loaded.config.memory.dir : undefined
  const pl = projectLayout(home, key, { storeDir })
  return {
    home,
    g,
    sid,
    projectDir,
    projectRoot: root,
    key,
    pl,
    sl: sid ? sessionLayout(pl, sid) : null,
    config: loaded.config,
    warnings: loaded.warnings,
    sources: loaded.sources,
    pluginOptions,
    logger: createLogger(g.cliLog, 'cli'),
  }
}

// ---------------------------------------------------------------- built-in commands

async function runVersion(args, io) {
  parseArgs(args, {})
  say(io, `cc-rsi ${VERSION} (node ${process.versions.node}; plugin root ${CLI_ROOT})`)
  return EXIT.ok
}

/** `cc-rsi engine run <lineageDir>` (internal; = `node lib/engine/daemon.mjs <lineageDir>`). */
async function runEngineCommand(args, io) {
  const { positionals } = parseArgs(args, {})
  if (positionals[0] !== 'run' || positionals.length !== 2) throw new UsageError('usage: cc-rsi engine run <lineageDir>')
  const daemon = await import('../engine/daemon.mjs')
  return daemon.main([resolve(io.cwd, positionals[1])])
}

/**
 * `cc-rsi verify cancel [--session <sid>]` ★ — stops the running interactive verification job
 * gracefully: SIGTERM to the job process only, so its own abort path stops the Verifier child and
 * its finally-restore runs (it records infra `cancelled`, SPEC §13.1, §11.5); after `--grace`
 * seconds (default 60) the job's process group is stopped (SIGINT → SIGTERM → SIGKILL). The CLI never
 * writes job or task state itself.
 */
async function runVerify(args, io) {
  const { positionals, options } = parseArgs(args, { string: ['session', 'project', 'grace'] })
  if (positionals[0] !== 'cancel' || positionals.length !== 1) throw new UsageError('usage: cc-rsi verify cancel [--session <sid>]')
  requireHuman(io, 'verify cancel')
  const graceMs = intOption(options, 'grace', 60) * 1000
  const ctx = await projectContext(io, { project: options.project, session: options.session })
  const { readdir } = await import('node:fs/promises')
  const { readJsonSafe } = await import('../core/atomic.mjs')
  const { killGracefully, pidAlive } = await import('../core/proc.mjs')
  const sessions = ctx.sid ? [safeName(ctx.sid)] : await readdir(ctx.pl.sessions).catch(() => [])
  const running = []
  for (const name of sessions) {
    const jobsDir = join(ctx.pl.sessions, name, 'jobs')
    for (const file of await readdir(jobsDir).catch(() => [])) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue
      const job = await readJsonSafe(join(jobsDir, file), null)
      if (job && typeof job.id === 'string' && (job.status === 'running' || job.status === 'queued')) running.push({ job, file: join(jobsDir, file), session: name })
    }
  }
  if (running.length === 0) {
    say(io, ctx.sid ? `no verification is running for session ${ctx.sid}` : `no verification is running in project ${ctx.key}`)
    return EXIT.ok
  }
  if (running.length > 1) {
    say(io, 'several verifications are running; pass --session <sid>:')
    for (const r of running) say(io, `  session ${r.session}: job ${r.job.id} (${r.job.candidateRoot ?? '?'})`)
    return EXIT.usage
  }
  const { job, file } = running[0]
  const pid = Number.isInteger(job.pid) && job.pid > 0 ? job.pid : null
  if (pid === null || !pidAlive(pid)) {
    say(io, `job ${job.id} has no live process; it is recovered (and the candidate restored) at the next session start, submit or status call`)
    return EXIT.ok
  }
  const sameStart = await startTokenCheck()
  const identity = jobProcessIdentity(job, file, { sameStart })
  if (identity.other) {
    say(io, `job ${job.id} has no live process (${identity.reason}); it is recovered (and the candidate restored) at the next session start, submit or status call`)
    return EXIT.ok
  }
  if (!identity.ok) {
    // Never signal on pid liveness alone: after a crash the pid may belong to an unrelated process.
    say(io, `job ${job.id} is not cancelled: ${identity.reason}`)
    say(io, `if pid ${pid} really is this verification job, stop it by hand (kill ${pid}); otherwise the job is recovered (and the candidate restored) at the next session start, submit or status call`)
    return EXIT.refused
  }
  say(io, `cancelling verification job ${job.id} (pid ${pid}); the job restores the candidate before it exits…`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  const finished = () => readJsonSafe(file, null).then(j => j?.status === 'done' || j?.status === 'infra')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && pidAlive(pid) && !(await finished())) await new Promise(res => setTimeout(res, 100))
  let escalated = false
  if (pidAlive(pid) && !(await finished())) {
    escalated = true
    // The group is stopped only while the pid is still the job and leads its own group (the job is
    // spawned detached); otherwise only the pid itself.
    const still = jobProcessIdentity(job, file, { sameStart }).ok
    const leader = still && processProbe.pgid(pid) === pid
    if (!still) {
      say(io, `pid ${pid} can no longer be identified as the job; nothing more is signalled`)
    } else {
      say(io, `the job did not finish within ${Math.round(graceMs / 1000)} s; stopping its ${leader ? 'process group' : 'process'}`)
      await killGracefully(pid, { graceMs: 10000, group: leader })
    }
  }
  const after = await readJsonSafe(file, null)
  say(io, `job ${job.id}: ${escalated ? 'stopped after the grace period' : 'stopped'}; status ${after?.status ?? 'unknown'}${after?.infra?.cls ? ` (${after.infra.cls})` : ''}`)
  if (after?.status !== 'infra' && after?.status !== 'done') say(io, 'the job did not record its end; the next session start or submit runs its recovery (run cc-rsi doctor to check the workspace lock)')
  return EXIT.ok
}

/** A job heartbeat younger than this proves the job process still runs (3 × the 30 s stale rule). */
const FRESH_HEARTBEAT_MS = 90000

/** One `ps` field of `pid` (macOS/BSD fallback when /proc is missing or hidden), or null. */
function psField(pid, field) {
  if (process.platform === 'win32') return null
  try {
    const r = spawnSync('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })
    const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** The command line of `pid` (/proc/<pid>/cmdline, else `ps -o command=`), or null when unknown. */
function readCmdline(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    if (text !== '') return text.replace(/\0+$/, '').replace(/\0/g, ' ')
  } catch {
    // no /proc (macOS) or hidden (hidepid): fall back to ps
  }
  return psField(pid, 'command')
}

/** The process group of `pid` (/proc/<pid>/stat field 5, else `ps -o pgid=`), or null when unknown. */
function readPgid(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const pgrp = Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[2])
    if (Number.isInteger(pgrp) && pgrp > 0) return pgrp
  } catch {
    // fall back to ps
  }
  const value = Number(psField(pid, 'pgid'))
  return Number.isInteger(value) && value > 0 ? value : null
}

/** Process probes of `verify cancel` (portability-1); tests replace them to simulate a system without /proc. */
export const processProbe = { cmdline: readCmdline, pgid: readPgid }

/** `sameProcess(pid, pidStart)` of lib/interactive/task.mjs when that module provides it, else null. */
async function startTokenCheck() {
  try {
    const task = await import('../interactive/task.mjs')
    return typeof task.sameProcess === 'function' ? task.sameProcess : null
  } catch {
    return null
  }
}

/**
 * Whether the live `job.pid` may be signalled as verification job `job` (file `jobFile`), as
 * `{ ok, other, reason }` (portability-1). Never on liveness alone: the job must have run on this
 * host and the pid must be shown to be the job, by its recorded start token (`pidStart`, through
 * `sameStart`), else by its command line (`verify-job` and the job file), else by a heartbeat
 * younger than 90 s. `other` is true when the pid is known to be another process now (the job is
 * gone); when nothing can identify the process, both are false and nothing may be signalled.
 */
export function jobProcessIdentity(job, jobFile, { now = Date.now(), probe = processProbe, sameStart = null } = {}) {
  const pid = job?.pid
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, other: false, reason: 'the job recorded no process id' }
  const host = typeof job.host === 'string' && job.host !== '' ? job.host : null
  if (host !== null && !sameMachine(job)) return { ok: false, other: false, reason: `the job ran on host ${host}, not on ${hostname()}; cancel it there` }
  const start = typeof sameStart === 'function' && typeof job.pidStart === 'string' ? sameStart(pid, job.pidStart) : null
  if (start === true) return { ok: true, other: false, reason: 'the process start time matches the job' }
  if (start === false) return { ok: false, other: true, reason: `pid ${pid} is another process now: its start time differs from the job's` }
  const cmdline = probe.cmdline(pid)
  if (typeof cmdline === 'string') {
    if (cmdline.includes('verify-job') && cmdline.includes(basename(jobFile))) return { ok: true, other: false, reason: 'the command line names the job' }
    return { ok: false, other: true, reason: `pid ${pid} runs another program now: ${cmdline.slice(0, 120)}` }
  }
  const beat = Date.parse(job.heartbeatAt ?? '')
  if (host !== null && Number.isFinite(beat) && now - beat <= FRESH_HEARTBEAT_MS) return { ok: true, other: false, reason: 'the job heartbeat is fresh' }
  return { ok: false, other: false, reason: `pid ${pid} cannot be identified as the job (its command line is unreadable here) and the job heartbeat is ${Number.isFinite(beat) ? `${Math.round((now - beat) / 1000)} s old` : 'missing'}` }
}

const COMMANDS = {
  status: () => import('./status.mjs'),
  doctor: () => import('./doctor.mjs'),
  memory: () => import('./memory.mjs'),
  explore: () => import('./explore.mjs'),
  eval: () => import('./eval.mjs'),
  gc: () => import('./gc.mjs'),
}

const BUILTIN = { version: runVersion, engine: runEngineCommand, verify: runVerify }

function exitCodeOf(error) {
  if (error instanceof RoleContextError) return EXIT.role
  if (error instanceof HumanOnlyError) return EXIT.humanOnly
  if (error instanceof UsageError) return EXIT.usage
  if (Number.isInteger(error?.exitCode)) return error.exitCode
  if (error instanceof CcRsiError && REFUSAL_CODES.has(error.code)) return EXIT.refused
  return EXIT.error
}

/**
 * Runs `cc-rsi <argv…>` and resolves to the exit code (SPEC §13.1). `io` (optional, for tests)
 * overrides the streams, environment, working directory and TTY flag.
 */
export async function main(argv, io) {
  const ctxIo = normalizeIo(io)
  const role = ctxIo.env?.CC_RSI_ROLE
  if (typeof role === 'string' && role !== '') {
    warn(ctxIo, new RoleContextError().message)
    return EXIT.role
  }
  const { args, reportExit } = splitReportExit(Array.isArray(argv) ? argv.map(String) : [])
  const code = await dispatch(args, ctxIo)
  if (!reportExit) return code
  // Skill `!` injection aborts the whole skill on any non-zero exit (cc-integration-4).
  ctxIo.stdout.write(`[cc-rsi exit ${code}]\n`)
  return EXIT.ok
}

/**
 * Removes `--report-exit` given after the command word (and before a `--`). The command word itself
 * is never taken as the flag, so the first argument still names the command.
 */
function splitReportExit(args) {
  const end = args.indexOf('--')
  const limit = end < 0 ? args.length : end
  const kept = args.filter((arg, i) => i === 0 || i >= limit || arg !== '--report-exit')
  return { args: kept, reportExit: kept.length !== args.length }
}

async function dispatch(args, ctxIo) {
  const [command, ...rest] = args
  if (command === undefined) {
    ctxIo.stderr.write(USAGE)
    return EXIT.usage
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    ctxIo.stdout.write(USAGE)
    return EXIT.ok
  }
  if (command === '--version' || command === '-V') return runVersion([], ctxIo)
  try {
    if (Object.prototype.hasOwnProperty.call(BUILTIN, command)) return await BUILTIN[command](rest, ctxIo)
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) throw new UsageError(`unknown command "${command}"; run "cc-rsi help"`)
    const mod = await COMMANDS[command]()
    const code = await mod.run(rest, ctxIo)
    return Number.isInteger(code) ? code : EXIT.ok
  } catch (error) {
    const code = exitCodeOf(error)
    const message = String(error?.message ?? error)
    warn(ctxIo, message.startsWith('cc-rsi') ? message : `cc-rsi: ${message}`)
    if (error instanceof HumanOnlyError) warn(ctxIo, `in a terminal, run: ${terminalCommand(ctxIo.env, args)}`)
    if (code === EXIT.usage && !(error instanceof HumanOnlyError)) warn(ctxIo, 'run "cc-rsi help" for usage')
    if (code === EXIT.error) {
      try {
        createLogger(globalLayout(ccRsiHome(ctxIo.env)).cliLog, 'cli').error('command failed', { argv: args, error: String(error?.stack ?? error) })
      } catch {
        // logging never changes the outcome
      }
    }
    return code
  }
}

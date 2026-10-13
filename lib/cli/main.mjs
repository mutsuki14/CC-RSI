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

import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonSafeSync } from '../core/atomic.mjs'
import { loadConfig, userConfigFromEnv } from '../core/config.mjs'
import { CcRsiError, HumanOnlyError, RoleContextError, UsageError } from '../core/errors.mjs'
import { createLogger } from '../core/log.mjs'
import { ccRsiHome, globalLayout, projectKey, projectLayout, safeName, sessionLayout } from '../core/paths.mjs'

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
  verify cancel [--session <sid>]*
  gc [--older-than DAYS] [--dry-run] [--streams]
  engine run <lineageDir>
  version

Most commands accept --project <dir> (default: the current directory's project).
* human-only: refused inside Claude Code (CLAUDECODE is set); run it in a terminal.
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
 * `{ home, g, sid, projectDir, projectRoot, key, pl, sl, config, warnings, sources, logger }`.
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
  const loaded = loadConfig({ home, projectRoot: root, userConfig: userConfigFromEnv(io.env, 'CLAUDE_PLUGIN_OPTION_') })
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
  if (pid === null || !pidAlive(pid) || !runsVerifyJob(pid)) {
    say(io, `job ${job.id} has no live process; it is recovered (and the candidate restored) at the next session start, submit or status call`)
    return EXIT.ok
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
    say(io, `the job did not finish within ${Math.round(graceMs / 1000)} s; stopping its process group`)
    await killGracefully(pid, { graceMs: 10000, group: true })
  }
  const after = await readJsonSafe(file, null)
  say(io, `job ${job.id}: ${escalated ? 'stopped after the grace period' : 'stopped'}; status ${after?.status ?? 'unknown'}${after?.infra?.cls ? ` (${after.infra.cls})` : ''}`)
  if (after?.status !== 'infra' && after?.status !== 'done') say(io, 'the job did not record its end; the next session start or submit runs its recovery (run cc-rsi doctor to check the workspace lock)')
  return EXIT.ok
}

/** Whether a live pid still runs a verification job (Linux /proc check against pid reuse; elsewhere assumed). */
function runsVerifyJob(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('verify-job')
  } catch {
    return true
  }
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
  const args = Array.isArray(argv) ? argv.map(String) : []
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

// `cc-rsi doctor [--live] [--json] [--session <sid>] [--release-lock <root>★]` (SPEC §13.5).
//
// Every check prints `PASS|WARN|FAIL <name>: <detail> [→ remedy]`. Without --live nothing calls a
// model. `--live` adds (SPEC §13.5 item 12, §17 V4/V10):
//   (a) an auth probe: one role child with the exact role flags, env and forwarded settings,
//       `--tools ""`, stdin "Reply with the single word OK." → class `reply` (J2-2);
//   (b) a hook probe: that invocation's guard log holds the UserPromptSubmit `prompt` pass entry, and
//       a second message on the same context (`--resume`) holds one too (V4);
//   (c) the sandbox live probe, when the static probe passes.
// Exit code: 1 when any check FAILs, else 0. `--release-lock` (human-only) only releases the
// workspace lock of <root> after a failed restore, once the user has inspected the displaced copies.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { exists, readJsonSafe } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { UsageError } from '../core/errors.mjs'
import { uuid } from '../core/ids.mjs'
import { readJsonlSync } from '../core/jsonl.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { sameMachine } from '../core/machine.mjs'
import { globalLayout, safeName } from '../core/paths.mjs'
import { pidAlive, runCapture } from '../core/proc.mjs'
import { claudeVersion, compareVersions, missingFlags, resolveClaudeBin } from '../runtime/claude-bin.mjs'
import { effective, resolveModel, userSettingsModel } from '../runtime/models.mjs'
import { decideIsolation, effectiveProbe, liveProbe, readProbe, recordLiveResult, staticProbe } from '../runtime/sandbox.mjs'
import { removeTree } from '../workspace/copy.mjs'
import { forceReleaseWorkspace, listLocksSync, recoverPendingLocks } from '../interactive/wslock.mjs'
import { CLI_ROOT, EXIT, onlyOptions, parseArgs, projectContext, refusal, requireHuman, say, storeOptions, VERSION } from './main.mjs'

/** Oldest Claude Code the role argv supports (SPEC header: `onFailure` needs ≥ 2.1.295). */
export const MIN_CLAUDE_VERSION = '2.1.295'
const LOCK_LIVE_MS = 30000
const MCP_TOOLS = ['submit', 'wait_verdict', 'learn', 'memory_commit', 'status']
const NETWORK_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'fuse.sshfs', 'sshfs', '9p', 'afs', 'ceph', 'glusterfs', 'lustre', 'gpfs', 'fuse.s3fs', 'davfs', 'fuse.rclone'])

/** One check result. */
function check(status, name, detail, remedy = null) {
  return { status, name, detail, remedy }
}

/** The printed form `STATUS name: detail [→ remedy]`. */
export function checkLine(c) {
  return `${c.status} ${c.name}: ${c.detail}${c.remedy ? ` → ${c.remedy}` : ''}`
}

// ---------------------------------------------------------------- individual checks

function nodeCheck() {
  const major = Number(process.versions.node.split('.')[0])
  return major >= 18
    ? check('PASS', 'node', `Node ${process.versions.node}`)
    : check('FAIL', 'node', `Node ${process.versions.node} is older than 18`, 'install Node 18 or newer')
}

async function claudeCheck(bin, configPath) {
  const version = await claudeVersion(bin)
  if (!version) return check('FAIL', 'claude', `${bin} is missing or reported no version`, `install Claude Code ≥ ${MIN_CLAUDE_VERSION}, or set children.claudeBin in ${configPath}`)
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) return check('FAIL', 'claude', `${bin} ${version} is older than ${MIN_CLAUDE_VERSION}`, 'update Claude Code (claude update)')
  const missing = await missingFlags(bin)
  if (missing.length > 0) return check('FAIL', 'claude', `${bin} ${version} lacks required flags: ${missing.join(', ')}`, 'update Claude Code')
  return check('PASS', 'claude', `${bin} ${version}; every required flag is present`)
}

async function gitCheck(env) {
  const r = await runCapture('git', ['--version'], { timeoutMs: 5000, env })
  return r.code === 0
    ? check('PASS', 'git', r.stdout.trim())
    : check('WARN', 'git', 'git is not available: change facts and verdict staleness digests degrade', 'install git')
}

/** The filesystem type of the mount holding `path` (Linux /proc/mounts), or null. */
async function filesystemOf(path) {
  let text
  try {
    text = await readFile('/proc/mounts', 'utf8')
  } catch {
    return null
  }
  let best = null
  for (const line of text.split('\n')) {
    const [, mount, type] = line.split(' ')
    if (!mount || !type) continue
    const point = mount.replace(/\\040/g, ' ')
    if ((path === point || path.startsWith(point.endsWith('/') ? point : `${point}/`)) && (!best || point.length > best.point.length)) best = { point, type }
  }
  return best?.type ?? null
}

async function homeCheck(home) {
  const out = []
  const info = await stat(home).catch(() => null)
  if (!info) {
    out.push(check('PASS', 'home', `${home} does not exist yet (it is created with mode 0700 on first use)`))
    return out
  }
  if (!info.isDirectory()) {
    out.push(check('FAIL', 'home', `${home} is not a directory`, 'remove it or set CC_RSI_HOME'))
    return out
  }
  const probe = join(home, `.doctor-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(probe, 'ok', { flag: 'wx', mode: 0o600 })
    await unlink(probe)
  } catch (error) {
    out.push(check('FAIL', 'home', `${home} is not writable (${error?.code ?? error})`, `fix the permissions of ${home}`))
    return out
  }
  const mode = info.mode & 0o777
  if (mode !== 0o700) out.push(check('WARN', 'home', `${home} has mode ${mode.toString(8)}; cc-rsi state is private`, `chmod 700 ${home}`))
  const fsType = await filesystemOf(await realpath(home).catch(() => home))
  if (fsType && NETWORK_FS.has(fsType)) {
    out.push(check('WARN', 'home', `${home} is on a network filesystem (${fsType}): lease locks and fsync may be unreliable`, 'set CC_RSI_HOME to a local directory'))
  }
  if (out.length === 0) out.push(check('PASS', 'home', `${home} is writable, mode 700${fsType ? `, ${fsType}` : ''}`))
  return out
}

/**
 * The terminal shim (portability-6): human-only commands run only from a terminal, where `cc-rsi`
 * is `<home>/bin/cc-rsi` (refreshed by every session start) once that directory is on PATH. Inside
 * Claude Code, PATH is the one Claude Code inherited, usually the login shell's.
 */
async function shimCheck(home, env) {
  const g = globalLayout(home)
  const exportLine = `export PATH="${g.bin}:$PATH" (in your shell profile)`
  const direct = `node "${join(CLI_ROOT, 'bin', 'cc-rsi')}"`
  const info = await lstat(g.binShim).catch(() => null)
  if (!info) {
    return check('WARN', 'shim', `${g.binShim} does not exist yet: "cc-rsi" does not run in a terminal (human-only commands need one)`,
      `start a Claude Code session with the plugin enabled (it writes the shim), then ${exportLine}; meanwhile run ${direct} …`)
  }
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    return check('WARN', 'shim', `${g.binShim} is not an executable file`, 'start a new Claude Code session to rewrite it')
  }
  const text = await readFile(g.binShim, 'utf8').catch(() => '')
  const m = /exec node "((?:[^"\\]|\\.)*)"/.exec(text)
  const target = m ? m[1].replace(/\\(.)/g, '$1') : null
  if (!target || !(await exists(target))) {
    return check('WARN', 'shim', `${g.binShim} points at ${target ?? 'no plugin'}, which no longer exists (the plugin was updated or removed)`,
      `start a new Claude Code session to refresh it; meanwhile run ${direct} …`)
  }
  const onPath = String(env?.PATH ?? '').split(delimiter).some(dir => dir !== '' && resolve(dir) === resolve(g.bin))
  if (!onPath) return check('WARN', 'shim', `${g.bin} is not on PATH, so "cc-rsi" does not run in a terminal (human-only commands need it)`, exportLine)
  return check('PASS', 'shim', `${g.binShim} → ${target}; ${g.bin} is on PATH`)
}

async function storeChecks(ctx) {
  const out = []
  if (!(await exists(ctx.pl.store))) {
    out.push(check('PASS', 'store', `no memory store for project ${ctx.key} yet`))
    return out
  }
  const { MemoryStore } = await import('../memory/store.mjs')
  let store
  try {
    store = await MemoryStore.open(ctx.pl.store, storeOptions(ctx.config, ctx.pl, { lockWaitMs: 10000 }))
  } catch (error) {
    out.push(check('FAIL', 'store', `the memory store cannot be opened: ${error?.message ?? error}`, 'run cc-rsi doctor again; if it persists, inspect the store directory'))
    return out
  }
  try {
    const journal = await store.journal()
    try {
      await store.assertCanonicalIntact()
      out.push(check('PASS', 'store', `recovery ran; canonical memory intact (tree ${(await store.treeHash()).slice(0, 12)}, ${journal.length} commits)`))
    } catch (error) {
      if (error?.code === 'memory_tamper') {
        out.push(check('FAIL', 'store', `canonical memory changed outside a commit (expected ${String(error.expected).slice(0, 12)}, found ${String(error.actual).slice(0, 12)})`,
          'cc-rsi memory verify --accept-external | cc-rsi memory restore <N> (human-only, in a terminal)'))
      } else {
        out.push(check('FAIL', 'store', `the integrity check failed: ${error?.message ?? error}`, 'run cc-rsi doctor again; if it persists, run cc-rsi memory verify'))
      }
    }
    const frozen = await store.frozen()
    if (frozen) {
      try {
        await store.assertFrozenIntact()
        out.push(check('PASS', 'store-frozen', `frozen at tree ${String(frozen.treeHash).slice(0, 12)} and intact`))
      } catch (error) {
        out.push(check('FAIL', 'store-frozen', error.message, 'inspect with cc-rsi memory verify; a frozen lineage or sealed evaluation cannot use this memory'))
      }
    }
    if (await exists(join(ctx.pl.store, 'commit.pending.json'))) {
      out.push(check('FAIL', 'store-pending', 'an interrupted commit could not be resolved by recovery', 'run cc-rsi memory verify; restore a history snapshot if the tree is broken'))
    } else {
      out.push(check('PASS', 'store-pending', 'no interrupted commit'))
    }
    const drafts = await store.drafts()
    // A live owner's missing directory or pending rebase is transient: the next rebaseDraft or
    // openDraft finishes it (memory-crash-4/-5), so it is not abandoned.
    const abandoned = drafts.filter(d => !d.live || d.committed)
    if (abandoned.length > 0) {
      out.push(check('WARN', 'store-drafts', `abandoned drafts: ${abandoned.map(d => d.episode).join(', ')}`, 'cc-rsi memory drafts --prune (human-only)'))
    } else {
      out.push(check('PASS', 'store-drafts', drafts.length === 0 ? 'no open drafts' : `${drafts.length} open draft(s): ${drafts.map(d => d.episode).join(', ')}`))
    }
  } catch (error) {
    out.push(check('FAIL', 'store', `the store check failed: ${error?.message ?? error}`, 'run cc-rsi doctor again; if it persists, run cc-rsi memory verify'))
  } finally {
    await store.close()
  }
  return out
}

/**
 * Every workspace lock record and restore-failed marker (lib/interactive/wslock.mjs listLocksSync:
 * the guard's own liveness rules, portability-2): `{ path, root, jobId, sessionId, pid, host,
 * restoreFailed, checkpointOpen, recoveryPending, jobFile, live, holderLive }`.
 */
async function readLocks(locksDir) {
  return listLocksSync(locksDir).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The displaced-copies directory of a lock's job (searched across projects), or null. */
async function displacedDirOf(home, lock) {
  if (!lock.sessionId || !lock.jobId) return null
  for (const key of await readdir(join(home, 'projects')).catch(() => [])) {
    const dir = join(home, 'projects', key, 'sessions', safeName(lock.sessionId), 'displaced', lock.jobId)
    if (await exists(dir)) return dir
  }
  return null
}

async function lockChecks(ctx, env) {
  const locks = await readLocks(ctx.g.locks)
  if (locks.length === 0) return [check('PASS', 'locks', 'no workspace locks')]
  const out = []
  for (const lock of locks) {
    if (lock.recoveryPending) {
      // A job that died with its checkpoint open keeps the root locked until its recovery restores
      // the checkpoint (memory-crash-2); the recovery is idempotent, so doctor starts it too.
      let started = false
      try { started = recoverPendingLocks(ctx.g.locks, { locks: [lock], env }).length > 0 } catch { started = false }
      out.push(check('WARN', 'locks', `job ${lock.jobId ?? '?'} died with its checkpoint of ${lock.root} open; recovery pending${started ? ' (started now)' : ''}`,
        `run cc-rsi doctor again shortly; if it persists, inspect ${lock.root} and run cc-rsi doctor --release-lock ${lock.root} (human-only)`))
    } else if (lock.restoreFailed) {
      const displaced = await displacedDirOf(ctx.home, lock)
      out.push(check('FAIL', 'locks', `a verification (job ${lock.jobId ?? '?'}) failed to restore ${lock.root}; file changes there stay blocked`,
        `inspect ${displaced ?? 'the displaced copies under <home>/projects/<key>/sessions/<sid>/displaced/'}, then cc-rsi doctor --release-lock ${lock.root} (human-only)`))
    } else if (!lock.live) {
      out.push(check('WARN', 'locks', `stale workspace lock for ${lock.root} (job ${lock.jobId ?? '?'})`, 'the next verification takes it over; or cc-rsi doctor --release-lock <root>'))
    } else {
      out.push(check('PASS', 'locks', `a verification (job ${lock.jobId ?? '?'}) holds ${lock.root}`))
    }
  }
  return out
}

/** `--release-lock <root>` (human-only): removes the workspace lock of <root> unless a live job holds it. */
async function releaseLock(ctx, io, rootArg) {
  requireHuman(io, 'doctor --release-lock')
  const abs = resolve(io.cwd, rootArg)
  const real = await realpath(abs).catch(() => abs)
  const candidates = new Set([abs, real])
  const locks = (await readLocks(ctx.g.locks)).filter(lock => candidates.has(lock.root) || candidates.has(resolve(lock.root)))
  const byName = join(ctx.g.locks, `${sha256Hex(real).slice(0, 24)}.json`)
  if (locks.length === 0 && !(await exists(byName))) {
    say(io, `no workspace lock for ${real}`)
    return EXIT.ok
  }
  for (const lock of locks) {
    // A live holder is never released, whatever host it names (a macOS hostname can change under a
    // running job; portability-7). Restore-failed, expired and dead checkpoint-open locks are.
    if (!lock.restoreFailed && lock.holderLive) {
      if (sameMachine(lock) && pidAlive(lock.pid)) {
        throw refusal(`a verification (job ${lock.jobId ?? '?'}, pid ${lock.pid}) is running on ${lock.root}; cancel it with cc-rsi verify cancel`)
      }
      throw refusal(`the workspace lock of ${lock.root} (job ${lock.jobId ?? '?'}, host ${lock.host ?? '?'}, pid ${lock.pid ?? '?'}) was renewed within the last ${LOCK_LIVE_MS / 1000} s; `
        + 'a verification may still run (on that host, or here under an old hostname): cancel it with cc-rsi verify cancel, or wait until the lease expires and retry')
    }
  }
  const paths = new Set(locks.map(lock => lock.path))
  if (await exists(byName)) paths.add(byName)
  for (const path of paths) await LeaseLock.forceRelease(path)
  // The lock and every restore-failed marker of the root (memory-crash-3: a marker alone keeps it blocked).
  await forceReleaseWorkspace(ctx.g.locks, real)
  const unrestored = locks.some(l => l.restoreFailed || l.checkpointOpen)
  say(io, `released the workspace lock of ${real}${unrestored ? ' (it was kept after a failed or unfinished restore; the workspace may still hold the Verifier\'s changes)' : ''}`)
  return EXIT.ok
}

async function lineageChecks(ctx) {
  const out = []
  for (const id of (await readdir(ctx.pl.lineages).catch(() => [])).sort()) {
    const dir = join(ctx.pl.lineages, id)
    const state = await readJsonSafe(join(dir, 'state.json'), null)
    if (!state) continue
    const lease = await LeaseLock.inspect(join(dir, 'engine.lock')).catch(() => null)
    const live = Boolean(lease && lease.holder && !lease.stale)
    if ((state.status === 'running' || state.status === 'starting') && !live && !(await exists(join(dir, 'result.json')))) {
      out.push(check('WARN', 'lineages', `lineage ${id} is marked ${state.status} but its engine is gone`, `cc-rsi explore resume ${id}`))
    } else if (state.status === 'paused_infra') {
      out.push(check('WARN', 'lineages', `lineage ${id} paused on infrastructure (${state.infra?.cls ?? '?'}: ${state.infra?.detail ?? ''})`, `fix the cause, then cc-rsi explore resume ${id}`))
    }
  }
  if (out.length === 0) out.push(check('PASS', 'lineages', 'no lineage needs attention'))
  return out
}

async function sandboxCheck(ctx, env) {
  const st = staticProbe({ env })
  const eff = effectiveProbe(await readProbe(ctx.home), st)
  const want = ctx.config.isolation?.sandbox ?? 'auto'
  const decision = decideIsolation({ want, probe: eff })
  if (decision.refuse) return check('FAIL', 'sandbox', `${decision.reason}`, 'install the sandbox dependencies (Linux: bubblewrap and socat) or set the sandbox option to auto')
  if (!eff.available) {
    return check('WARN', 'sandbox', `${eff.reason}; the interactive Verifier runs in rollback mode and lineages need --allow-unconfined`,
      'install bubblewrap and socat (Linux) to confine role children; see "Isolation: what is and is not protected" in the README')
  }
  return check('PASS', 'sandbox', `${eff.reason}${want === 'off' ? ' (but isolation.sandbox is off)' : ''}`)
}

async function hooksCheck(ctx) {
  if (!ctx.sid) return null
  if (await exists(ctx.sl.requests)) {
    const lines = (await readFile(ctx.sl.requests, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
    return check('PASS', 'hooks', `the cc-rsi hooks are active in session ${ctx.sid} (${lines} request(s) captured)`)
  }
  return check('WARN', 'hooks', `no request was captured for session ${ctx.sid}: the cc-rsi hooks may be inactive (disableAllHooks, allowManagedHooksOnly, or the plugin is disabled)`,
    'check /hooks and /plugin in Claude Code; submit refuses without the hooks')
}

/** Spawns the MCP server, sends initialize + tools/list, and checks the 5 tools (SPEC §13.5 item 10). */
async function mcpCheck(env) {
  const server = join(CLI_ROOT, 'mcp', 'server.mjs')
  try {
    await access(server, constants.R_OK)
  } catch {
    return check('FAIL', 'mcp', `${server} is missing`, 'reinstall the plugin')
  }
  const childEnv = { ...env, CC_RSI_PLUGIN_ROOT: CLI_ROOT }
  delete childEnv.CC_RSI_ROLE
  const result = await new Promise(resolvePromise => {
    let child
    try {
      child = spawn(process.execPath, [server], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ error: String(error?.message ?? error) })
      return
    }
    let buffer = ''
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.stdin.end() } catch { /* closed */ }
      try { child.kill('SIGTERM') } catch { /* gone */ }
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish({ error: 'no tools/list response within 15 s' }), 15000)
    child.on('error', error => finish({ error: String(error?.message ?? error) }))
    child.on('exit', code => finish({ error: `the server exited (code ${code}) before answering` }))
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line === '') continue
        let msg
        try { msg = JSON.parse(line) } catch { finish({ error: `the server wrote a non-JSON line on stdout: ${line.slice(0, 80)}` }); return }
        if (msg.id === 2) finish({ tools: Array.isArray(msg.result?.tools) ? msg.result.tools.map(t => t.name) : null, error: msg.error?.message })
      }
    })
    child.stdin.on('error', () => undefined)
    const send = obj => child.stdin.write(`${JSON.stringify(obj)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc-rsi-doctor', version: VERSION } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  })
  if (result.error || !Array.isArray(result.tools)) return check('FAIL', 'mcp', `the MCP server did not list its tools (${result.error ?? 'no tools'})`, 'run node mcp/server.mjs by hand to see the error; reinstall the plugin')
  const missing = MCP_TOOLS.filter(name => !result.tools.includes(name))
  if (missing.length > 0 || result.tools.length !== MCP_TOOLS.length) {
    return check('FAIL', 'mcp', `unexpected tool list: ${result.tools.join(', ')}`, 'reinstall the plugin')
  }
  return check('PASS', 'mcp', `the rsi server lists ${MCP_TOOLS.join(', ')}`)
}

async function modelsCheck(ctx, env) {
  const session = ctx.sl ? await readJsonSafe(ctx.sl.sessionJson, null) : null
  const fromSettings = await userSettingsModel(env)
  const verifier = resolveModel(ctx.config.models?.verifier ?? '', { sessionModel: session?.model ?? null, env, userSettingsModel: fromSettings })
  const actor = typeof session?.model === 'string' && session.model !== ''
    ? { model: session.model, source: 'session' }
    : resolveModel(ctx.config.models?.actor ?? '', { env, userSettingsModel: fromSettings })
  const known = model => typeof model === 'string' && model !== ''
  if (!known(actor.model)) {
    // The session model is often unknown until the first cc-rsi tool call reads it from the
    // transcript (cc-integration-3): two unknown models are not "equal".
    return check('PASS', 'models', `Verifier ${effective(verifier.model)} (${verifier.source}); session model not yet known (read from the transcript at the first cc-rsi tool call)`)
  }
  const detail = `Verifier ${effective(verifier.model)} (${verifier.source}); Actor ${effective(actor.model)} (${actor.source})`
  if (known(verifier.model) && verifier.model === actor.model) {
    return check('WARN', 'models', `${detail}: the Verifier model equals the Actor model, so RSIAgent's cross-model asymmetry is off`,
      `set the verifier_model plugin option (/plugin configure) or models.verifier in ${join(ctx.home, 'config.json')}`)
  }
  return check('PASS', 'models', detail)
}

function configChecks(ctx) {
  const options = ctx.pluginOptions?.source
    ? `; plugin options ${Object.entries(ctx.pluginOptions.options).map(([k, v]) => `${k}=${v}`).join(', ')} from ${ctx.pluginOptions.source}`
    : ''
  if (ctx.warnings.length === 0) return [check('PASS', 'config', `no configuration warnings${options}`)]
  return ctx.warnings.map(w => check('WARN', 'config', w, `edit ${join(ctx.home, 'config.json')} or ${join(ctx.projectRoot, '.claude', 'cc-rsi.json')}`))
}

/**
 * The live auth + hook probe (SPEC §13.5 item 12 a/b): a summarizer-shaped role child (`--tools ""`)
 * with the exact flags, env and forwarded settings, two messages on one context (`--session-id`, then
 * `--resume`). Reads each invocation's meta.json for the hook attestation.
 */
async function liveAuthAndHooks(ctx, env, bin, model) {
  const out = []
  const base = join(ctx.home, 'run', 'probe', `doctor-${randomBytes(6).toString('hex')}`)
  const cwd = join(base, 'work')
  const logDir = join(base, 'ctx')
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const { RoleContext } = await import('../runtime/context.mjs')
  const spec = {
    key: 'doctor-probe', role: 'summarizer', phase: null, cwd, addDirs: [], tools: [], allow: [], deny: [],
    readRoots: [cwd], writeRoots: [], readOnlyRoots: [], hidden: [], hiddenTokens: [], bashDeny: [], sandbox: null,
    sandboxDegrade: 'refuse', systemText: 'You are a cc-rsi diagnostic probe. Reply with the single word OK.',
    model: model ?? null, effort: null, lossless: false, pinText: null, liveness: false, stagnationRevisit: null,
    maxTurns: 1, turnTimeoutSec: 300, pauseCeilingSecs: 0, watchdogMaxWaitMs: null, maxBudgetUsd: null,
    noSessionPersistence: false, extraEnv: {}, logDir, home: ctx.home, pluginRoot: CLI_ROOT, config: ctx.config,
  }
  const meta = async n => readJsonSafe(join(logDir, String(n), 'meta.json'), null)
  const guardPass = n => {
    try {
      return readJsonlSync(join(logDir, String(n), 'guard.jsonl')).some(e => e && e.hook === 'prompt' && e.decision === 'pass')
    } catch {
      return false
    }
  }
  try {
    const ctxRole = new RoleContext(spec, { sessionId: uuid(), parentEnv: env, bin })
    let first = null
    try {
      first = await ctxRole.send('Reply with the single word OK.')
      out.push(check('PASS', 'live-auth', `a role child authenticated and replied (model ${first.model ?? effective(model)})`))
    } catch (error) {
      const cls = error?.cls ?? 'error'
      if (cls === 'auth') out.push(check('FAIL', 'live-auth', `authentication failed in the role child: ${error.detail ?? error.message}`, 'log in again, or check apiKeyHelper/env in ~/.claude/settings.json (they are forwarded automatically)'))
      else if (cls === 'hooks_not_run') out.push(check('WARN', 'live-auth', 'not proven: the child ran but its hooks did not (see live-hooks)'))
      else out.push(check('FAIL', 'live-auth', `the role child failed (${cls}): ${error?.detail ?? error?.message ?? error}`, cls === 'config' ? 'check the configured model names' : 'run cc-rsi doctor --live again (the probe removes its logs; the detail above is the child\'s error)'))
    }
    const m1 = await meta(1)
    const ran1 = m1?.hooksRan === true || guardPass(1)
    if (!m1) {
      out.push(check('FAIL', 'live-hooks', 'the probe invocation did not run'))
    } else if (!ran1) {
      out.push(check('FAIL', 'live-hooks', 'hooks_not_run: the role guard (UserPromptSubmit) left no pass entry, so role children cannot run',
        'remove allowManagedHooksOnly/disableAllHooks from managed settings, or ask the administrator'))
    } else if (first) {
      // V4: the role UserPromptSubmit guard also fires on --resume.
      let second = null
      try {
        second = await ctxRole.send('Reply with the single word OK again.')
      } catch (error) {
        out.push(check('WARN', 'live-hooks', `the role guard ran on the first message; the --resume message failed (${error?.cls ?? 'error'}): ${error?.detail ?? error?.message ?? error}`))
      }
      if (second) {
        const m2 = await meta(2)
        out.push(m2?.hooksRan === true || guardPass(2)
          ? check('PASS', 'live-hooks', 'the role guard ran on the first message and on --resume')
          : check('FAIL', 'live-hooks', 'the role guard did not run on the --resume message (V4)', 'report this Claude Code version; role children cannot be trusted'))
      }
    } else {
      out.push(check('PASS', 'live-hooks', 'the role guard ran (UserPromptSubmit digest entry)'))
    }
  } finally {
    await removeTree(base).catch(() => undefined)
  }
  return out
}

async function liveSandboxCheck(ctx, env, bin, model) {
  const st = staticProbe({ env })
  if (!st.available) return null
  const r = await liveProbe({ bin, home: ctx.home, env, model, pluginRoot: CLI_ROOT, config: ctx.config })
  const version = await claudeVersion(bin)
  if (!r.available && !r.inconclusive) {
    await recordLiveResult(ctx.home, { available: false, reason: r.reason, ccVersion: version }, { env })
    return check('FAIL', 'live-sandbox', r.reason, 'the Verifier degrades to rollback mode; fix the sandbox (bubblewrap/socat) or set the sandbox option to off')
  }
  if (r.inconclusive) return check('WARN', 'live-sandbox', r.reason)
  await recordLiveResult(ctx.home, { available: true, reason: r.reason, ccVersion: version, enforced: r.enforced }, { env })
  return r.enforced
    ? check('PASS', 'live-sandbox', r.reason)
    : check('WARN', 'live-sandbox', r.reason, 'correctness is unaffected (the workspace is always restored), but Verifier writes are not confined')
}

/** Runs every check; returns the check list. */
export async function runChecks(ctx, io, { live = false } = {}) {
  const env = io.env
  const bin = resolveClaudeBin({ config: ctx.config, env })
  const checks = [nodeCheck(), await claudeCheck(bin, join(ctx.home, 'config.json')), await gitCheck(env), ...(await homeCheck(ctx.home)),
    await shimCheck(ctx.home, env), ...(await storeChecks(ctx)),
    ...(await lockChecks(ctx, env)), ...(await lineageChecks(ctx)), await sandboxCheck(ctx, env)]
  const hooks = await hooksCheck(ctx)
  if (hooks) checks.push(hooks)
  checks.push(await mcpCheck(env))
  checks.push(await modelsCheck(ctx, env))
  if (live) {
    const session = ctx.sl ? await readJsonSafe(ctx.sl.sessionJson, null) : null
    const model = resolveModel(ctx.config.models?.verifier ?? '', { sessionModel: session?.model ?? null, env, userSettingsModel: await userSettingsModel(env) }).model
    if (checks.some(c => c.name === 'claude' && c.status === 'FAIL')) {
      checks.push(check('FAIL', 'live', 'skipped: claude is not usable (see above)'))
    } else {
      checks.push(...(await liveAuthAndHooks(ctx, env, bin, model)))
      const sandbox = await liveSandboxCheck(ctx, env, bin, model)
      if (sandbox) checks.push(sandbox)
    }
  }
  checks.push(...configChecks(ctx))
  return checks
}

export async function run(args, io) {
  const { positionals, options } = parseArgs(args, { string: ['session', 'project', 'release-lock'], boolean: ['live', 'json'] })
  onlyOptions(options, ['session', 'project', 'release-lock', 'live', 'json'], 'doctor')
  if (positionals.length > 0) throw new UsageError('usage: cc-rsi doctor [--live] [--json] [--session <sid>] [--release-lock <root>]')
  if (options['release-lock'] !== undefined) requireHuman(io, 'doctor --release-lock')
  const ctx = await projectContext(io, { project: options.project, session: options.session })
  if (options['release-lock'] !== undefined) return releaseLock(ctx, io, options['release-lock'])
  const checks = await runChecks(ctx, io, { live: options.live === true })
  const failed = checks.some(c => c.status === 'FAIL')
  if (options.json) say(io, JSON.stringify({ ok: !failed, project: { root: ctx.projectRoot, key: ctx.key }, checks }, null, 2))
  else {
    say(io, `cc-rsi doctor — ${VERSION}, project ${ctx.key} (${ctx.projectRoot}), home ${ctx.home}`)
    for (const c of checks) say(io, checkLine(c))
  }
  return failed ? EXIT.error : EXIT.ok
}

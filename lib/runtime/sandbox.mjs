// OS sandbox probe and isolation decision (SPEC §10.11).
//
// Claude Code's sandbox wraps Bash only (bubblewrap + socat on Linux, sandbox-exec on macOS).
// `sandbox.failIfUnavailable` makes it a hard gate: the child exits 1 before any model call
// (claude-code-experiments.md f2). The static probe is a filesystem lookup (no spawn), so hooks may
// import this module (SPEC §3); the live probe loads the runtime lazily.

import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { readJsonSafe, writeJsonAtomic } from '../core/atomic.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** First executable `name` on `env.PATH`, or null (filesystem lookup only). */
function which(name, env) {
  const path = typeof env?.PATH === 'string' ? env.PATH : ''
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

function isWsl1() {
  try {
    const v = readFileSync('/proc/version', 'utf8')
    return /Microsoft/.test(v) && !/WSL2/i.test(v)
  } catch {
    return false
  }
}

/**
 * Static availability (SPEC §10.11): Linux needs `bwrap` AND `socat` on PATH and is never WSL1;
 * macOS needs /usr/bin/sandbox-exec; other platforms are unavailable.
 * Returns `{ available, reason, details: { bwrap, socat, sandboxExec, wsl1 } }`.
 */
export function staticProbe({ platform = process.platform, env = process.env } = {}) {
  const details = { bwrap: null, socat: null, sandboxExec: false, wsl1: false }
  if (platform === 'linux') {
    details.bwrap = which('bwrap', env)
    details.socat = which('socat', env)
    details.wsl1 = isWsl1()
    if (details.wsl1) return { available: false, reason: 'sandbox unavailable: WSL1 cannot run the Claude Code sandbox', details }
    const missing = []
    if (!details.bwrap) missing.push('bubblewrap (bwrap) not installed')
    if (!details.socat) missing.push('socat not installed')
    if (missing.length > 0) return { available: false, reason: `sandbox unavailable: ${missing.join(', ')}`, details }
    return { available: true, reason: `bubblewrap (${details.bwrap}) and socat (${details.socat}) found`, details }
  }
  if (platform === 'darwin') {
    details.sandboxExec = existsSync('/usr/bin/sandbox-exec')
    return details.sandboxExec
      ? { available: true, reason: 'sandbox-exec found', details }
      : { available: false, reason: 'sandbox unavailable: /usr/bin/sandbox-exec not found', details }
  }
  return { available: false, reason: `sandbox unavailable: platform ${platform} is not supported`, details }
}

/** `<home>/probe.json` parsed, or null. */
export async function readProbe(home) {
  const probe = await readJsonSafe(join(home, 'probe.json'), null)
  return probe && typeof probe === 'object' && !Array.isArray(probe) ? probe : null
}

/** Writes `<home>/probe.json` atomically (mode 0600). */
export async function writeProbe(home, probe) {
  await writeJsonAtomic(join(home, 'probe.json'), probe)
}

/** The probe.json record for a static result: {v:1, platform, bwrap, socat, sandboxExec, static:{available, reason}}. */
export function probeRecord(staticResult, { platform = process.platform } = {}) {
  const d = staticResult?.details ?? {}
  return {
    v: 1,
    platform,
    bwrap: d.bwrap ?? null,
    socat: d.socat ?? null,
    sandboxExec: d.sandboxExec === true,
    static: { available: staticResult?.available === true, reason: String(staticResult?.reason ?? '') },
  }
}

function sameDetails(probeFile, staticResult, platform) {
  const d = staticResult?.details ?? {}
  return probeFile.platform === platform
    && (probeFile.bwrap ?? null) === (d.bwrap ?? null)
    && (probeFile.socat ?? null) === (d.socat ?? null)
    && (probeFile.sandboxExec === true) === (d.sandboxExec === true)
}

/**
 * The availability to act on: a live failure recorded in probe.json for the same static details
 * (platform, bwrap, socat, sandbox-exec) wins over a static success; otherwise the static result.
 */
export function effectiveProbe(probeFile, staticResult, { platform = process.platform } = {}) {
  const fallback = { available: staticResult?.available === true, reason: String(staticResult?.reason ?? 'sandbox state unknown') }
  if (!fallback.available) return fallback
  const live = probeFile?.live
  if (probeFile && live && live.available === false && sameDetails(probeFile, staticResult, platform)) {
    return { available: false, reason: String(live.reason ?? 'sandbox unavailable (live probe)') }
  }
  return fallback
}

/**
 * `want` 'off' | 'auto' | 'require' and an effective probe → `{ sandbox, refuse, reason }`.
 * auto without a sandbox degrades explicitly (the reason is shown and recorded); require refuses.
 */
export function decideIsolation({ want = 'auto', probe } = {}) {
  const available = probe?.available === true
  const reason = String(probe?.reason ?? (available ? 'sandbox available' : 'sandbox unavailable'))
  if (want === 'off') return { sandbox: false, refuse: false, reason: 'sandbox disabled by configuration (isolation.sandbox=off)' }
  if (available) return { sandbox: true, refuse: false, reason }
  if (want === 'require') return { sandbox: false, refuse: true, reason: `${reason} (isolation.sandbox=require)` }
  return { sandbox: false, refuse: false, reason }
}

/**
 * Records a live sandbox failure in probe.json (`live = {ccVersion, available:false, reason, at}`),
 * keeping the static details current so `effectiveProbe` matches it. Never throws.
 */
export async function recordLiveResult(home, { available, reason, ccVersion = null, enforced = null } = {}, { platform = process.platform, env = process.env } = {}) {
  try {
    const staticResult = staticProbe({ platform, env })
    const record = { ...probeRecord(staticResult, { platform }), live: { ccVersion, available: available === true, reason: String(reason ?? ''), enforced, at: new Date().toISOString() } }
    await writeProbe(home, record)
    return record
  } catch {
    return null
  }
}

/** POSIX single-quoted shell word (`'` becomes `'\''`), safe for any path (spaces, `$`, quotes). */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Live probe (`cc-rsi doctor --live`, SPEC §10.11, §13.5): one role child with a sandbox block
 * ({enabled, failIfUnavailable, allowUnsandboxedCommands:false, filesystem.allowWrite:[tmp]}).
 * Exit 1 with "sandbox required but unavailable" → unavailable without a model call (f2). Otherwise
 * the model is asked to run ONE Bash command that `touch`es a control file inside the allowed
 * directory and a marker outside it (both paths single-quoted, so a home with spaces works).
 * Enforcement is concluded only when the control file exists and the marker does not; a missing
 * control file means the command never ran (or ran mangled), which is inconclusive, never a PASS.
 * Inconclusive outcomes (auth, API errors, command not run) set `inconclusive: true`.
 * Returns `{ available, reason, enforced, inconclusive?, cls? }`.
 */
export async function liveProbe({ bin, home, env = process.env, model = null, pluginRoot = PLUGIN_ROOT, config = {}, timeoutSec = 300 } = {}) {
  if (typeof home !== 'string' || home === '') throw new TypeError('liveProbe: home is required')
  const { RoleContext } = await import('./context.mjs')
  const { InfraError } = await import('./errors.mjs')
  const { uuid } = await import('../core/ids.mjs')
  const base = join(home, 'run', 'probe', `live-${randomBytes(6).toString('hex')}`)
  const work = join(base, 'work')
  const outside = join(base, 'outside')
  const marker = join(outside, 'probe')
  const control = join(work, 'ok')
  await mkdir(work, { recursive: true, mode: 0o700 })
  await mkdir(outside, { recursive: true, mode: 0o700 })
  const spec = {
    key: 'sandbox-probe',
    role: 'verifier',
    phase: null,
    cwd: work,
    addDirs: [],
    tools: ['Bash'],
    allow: ['Bash'],
    deny: ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill'],
    readRoots: [work],
    writeRoots: [],
    readOnlyRoots: [],
    hidden: [],
    hiddenTokens: [],
    bashDeny: [],
    sandbox: { allowWrite: [work], denyWrite: [], denyRead: [], network: [] },
    sandboxDegrade: 'refuse',
    systemText: 'You are a sandbox probe for cc-rsi. Follow the instruction exactly and briefly.',
    model,
    effort: null,
    lossless: true,
    pinText: null,
    liveness: false,
    stagnationRevisit: null,
    maxTurns: 4,
    turnTimeoutSec: timeoutSec,
    pauseCeilingSecs: 0,
    watchdogMaxWaitMs: null,
    maxBudgetUsd: null,
    noSessionPersistence: true,
    extraEnv: {},
    logDir: join(base, 'ctx'),
    home,
    pluginRoot,
    config,
  }
  try {
    const ctx = new RoleContext(spec, { sessionId: uuid(), parentEnv: env, bin })
    await ctx.send(`Use the Bash tool to run exactly this command, then reply with the single word DONE:\ntouch ${shellQuote(control)} ${shellQuote(marker)}\n`)
    if (existsSync(marker)) return { available: true, reason: 'the sandbox started but did not confine a write outside its allowed directory', enforced: false }
    if (!existsSync(control)) {
      return { available: true, reason: 'live probe inconclusive: the sandbox started but the probe command did not run (no control file was written inside the allowed directory)', enforced: null, inconclusive: true, cls: 'probe_not_run' }
    }
    return { available: true, reason: 'the sandbox started and confined a write outside its allowed directory', enforced: true }
  } catch (error) {
    if (error instanceof InfraError && error.cls === 'sandbox_unavailable') return { available: false, reason: error.detail, enforced: null, cls: error.cls }
    const cls = error?.cls ?? 'error'
    return { available: false, reason: `live probe inconclusive (${cls}): ${error?.detail ?? error?.message ?? error}`, enforced: null, inconclusive: true, cls }
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => undefined)
  }
}

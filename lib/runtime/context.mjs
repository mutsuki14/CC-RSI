// Role contexts: one persistent Claude Code session per role identity (SPEC §10.9).
//
// A context is a fresh uuid sent with `--session-id` on its first message and `--resume` on every
// later one (F2/E1: context and id are kept). Each message is one atomic, watchdogged, logged
// invocation of `claude -p` (SPEC §1.2 D2). This is the seam shared by the interactive
// verification job (SPEC §11.5) and the lineage engine (SPEC §12.5).
//
// RSIAgent analogue: the transport layer under `_run_handoff_phase` (explore/practice_loop.py):
// transient transport failures pause with backoff and are never charged or graded; the request is
// retried in the SAME context. Claude Code keeps a failed user message in the transcript (F4), so a
// retry sends a short recovery note that embeds the original message instead of a duplicate (R1).

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ensureDir, readJsonSafe, writeFileAtomic, writeJsonAtomic } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { uuid as newUuid } from '../core/ids.mjs'
import { readJsonlSync } from '../core/jsonl.mjs'
import { recoveryNote } from '../prompts/roles.mjs'
import { buildArgv } from './argv.mjs'
import { forwardedUserSettings } from './auth-settings.mjs'
import { runInvocation } from './child.mjs'
import { resolveClaudeBin } from './claude-bin.mjs'
import { classify } from './classify.mjs'
import { childEnv } from './env.mjs'
import { InfraError, InterruptedError } from './errors.mjs'
import { buildPolicy, writePolicy } from './policy.mjs'
import { recordLiveResult } from './sandbox.mjs'
import { buildSettings, pinFileFor, writeContentAddressed, writeSettings } from './settings.mjs'
import { hookAttestation, parseStream } from './stream.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLES = new Set(['actor', 'verifier', 'curriculum', 'summarizer'])

/**
 * Prefix sent when the OS sandbox disappears after a context's first message and the caller's
 * `onDegrade` supplies no note of its own (SPEC §10.9 `sandbox_unavailable` row).
 */
export const DEGRADE_NOTE = 'HARNESS NOTE: the OS sandbox is unavailable from now on; your shell commands are NOT sandboxed: network access and other processes are NOT isolated. The harness still checkpoints the workspace and restores it afterwards. State in an external service outside this workspace cannot be rolled back: observe such services without sending mutating requests.'

/** The recovery note for a re-sent message (= prompts.recoveryNote({message}); R1/F4-safe). */
export function recoveryNoteFor(message) {
  return recoveryNote({ message })
}

function abs(value, what) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new TypeError(`RoleSpec: ${what} must be an absolute path (got ${JSON.stringify(value)})`)
  return resolve(value)
}

function pick(obj, role, fallback) {
  if (obj && typeof obj === 'object' && Number.isFinite(obj[role])) return obj[role]
  return fallback
}

/**
 * Validates a RoleSpec (SPEC §10.9) and fills omitted optional fields. Throws TypeError for a
 * missing required field: role, cwd, logDir, home, pluginRoot (absolute), systemText, tools.
 */
export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('RoleSpec is required')
  if (!ROLES.has(spec.role)) throw new TypeError(`RoleSpec: unknown role ${JSON.stringify(spec.role)}`)
  if (typeof spec.systemText !== 'string') throw new TypeError('RoleSpec: systemText must be a string')
  if (!Array.isArray(spec.tools)) throw new TypeError('RoleSpec: tools must be an array')
  const config = spec.config && typeof spec.config === 'object' ? spec.config : {}
  const transport = config.transport ?? {}
  const role = spec.role
  const defaults = {
    phase: null, addDirs: [], allow: [], deny: [], readRoots: [], writeRoots: [], readOnlyRoots: [], hidden: [], hiddenTokens: [], bashDeny: [],
    sandbox: null, sandboxDegrade: 'refuse', model: null, effort: null, lossless: false, pinText: null, liveness: false, stagnationRevisit: null,
    maxBudgetUsd: null, noSessionPersistence: false, extraEnv: {}, watchdogMaxWaitMs: null,
  }
  const out = { ...spec }
  for (const [k, v] of Object.entries(defaults)) {
    if (out[k] === undefined || out[k] === null) out[k] = v
  }
  Object.assign(out, {
    key: String(spec.key ?? role),
    role,
    config,
    cwd: abs(spec.cwd, 'cwd'),
    logDir: abs(spec.logDir, 'logDir'),
    home: abs(spec.home, 'home'),
    pluginRoot: abs(spec.pluginRoot, 'pluginRoot'),
  })
  out.maxTurns = Number.isInteger(spec.maxTurns) && spec.maxTurns > 0 ? spec.maxTurns : pick(transport.maxTurns, role, role === 'summarizer' ? 1 : 2000)
  out.turnTimeoutSec = Number.isFinite(spec.turnTimeoutSec) && spec.turnTimeoutSec >= 0 ? spec.turnTimeoutSec : pick(transport.turnTimeoutSec, role, 14400)
  out.pauseCeilingSecs = Number.isFinite(spec.pauseCeilingSecs) && spec.pauseCeilingSecs >= 0 ? spec.pauseCeilingSecs : 1800
  return out
}

function emptyRegistry() {
  return { attempted: 0, completed: 0, lastCostUsdTotal: 0 }
}

/** Next free invocation number in `logDir` (monotonic; `mkdir` without `recursive` claims it atomically). */
async function claimInvocationDir(logDir) {
  await ensureDir(logDir)
  let max = 0
  for (const name of await readdir(logDir).catch(() => [])) {
    if (/^\d+$/.test(name)) max = Math.max(max, Number(name))
  }
  for (let n = max + 1; ; n++) {
    const dir = join(logDir, String(n))
    try {
      await mkdir(dir, { mode: 0o700 })
      return { n, dir }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
}

/** Sleeps `ms`, resolving early with `true` when `signal` aborts. */
function pause(ms, signal) {
  return new Promise(resolvePromise => {
    if (signal?.aborted) {
      resolvePromise(true)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise(false)
    }, ms)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * One persistent role context (SPEC §10.9).
 * Options: `sessionId` (a uuid minted by the caller; minted here when omitted), `logger`
 * (lib/core/log.mjs), `onRuntimeEvent(type, data)` (ROLE_INVOCATION, TRANSPORT_PAUSE,
 * ISOLATION_DEGRADED, GUARD_GAP), `signal` (AbortSignal → InterruptedError), `onDegrade(first)`
 * (returns a new spec, or `{spec, note}`, without a sandbox block), and two additions for tests and
 * probes: `parentEnv` (default process.env) and `bin` (default `resolveClaudeBin`).
 */
export class RoleContext {
  #spec
  #sessionId
  #logger
  #onRuntimeEvent
  #signal
  #onDegrade
  #parentEnv
  #bin
  #busy = false

  constructor(spec, { sessionId, logger, onRuntimeEvent = () => {}, signal, onDegrade, parentEnv, bin } = {}) {
    this.#spec = normalizeSpec(spec)
    const id = sessionId ?? newUuid()
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError(`RoleContext: sessionId must be a uuid (got ${JSON.stringify(id)})`)
    this.#sessionId = id.toLowerCase()
    this.#logger = logger ?? null
    this.#onRuntimeEvent = typeof onRuntimeEvent === 'function' ? onRuntimeEvent : () => {}
    this.#signal = signal ?? null
    this.#onDegrade = typeof onDegrade === 'function' ? onDegrade : null
    this.#parentEnv = parentEnv ?? process.env
    this.#bin = typeof bin === 'string' && bin !== '' ? bin : null
  }

  get sessionId() {
    return this.#sessionId
  }

  get spec() {
    return this.#spec
  }

  /** Replaces the spec, e.g. the Actor's work → learn policy switch (same session). */
  setSpec(spec) {
    this.#spec = normalizeSpec(spec)
  }

  get #registryPath() {
    return join(this.#spec.logDir, 'sessions', `${this.#sessionId}.json`)
  }

  async #readRegistry() {
    const reg = await readJsonSafe(this.#registryPath, null)
    if (!reg || typeof reg !== 'object') return emptyRegistry()
    return {
      attempted: Number.isInteger(reg.attempted) && reg.attempted >= 0 ? reg.attempted : 0,
      completed: Number.isInteger(reg.completed) && reg.completed >= 0 ? reg.completed : 0,
      lastCostUsdTotal: Number.isFinite(reg.lastCostUsdTotal) ? reg.lastCostUsdTotal : 0,
    }
  }

  async #writeRegistry(reg) {
    await writeJsonAtomic(this.#registryPath, reg)
  }

  #event(type, data) {
    try {
      this.#onRuntimeEvent(type, { ctx: this.#spec.key, role: this.#spec.role, sessionId: this.#sessionId, ...data })
    } catch (error) {
      this.#logger?.warn?.('runtime event handler failed', { type, error: String(error?.message ?? error) })
    }
  }

  /**
   * Delivers `message` and resolves to the role's Reply (SPEC §10.9):
   * `{ text, actions, truncated, stopReason, model, costUsdTotal, costUsdDelta, sessionId, invocation,
   *    numTurns, permissionDenials, guardGaps, durationMs }`.
   * Throws InfraError (`cls` per SPEC §10.8; `session_missing` carries `extra.established`) or
   * InterruptedError. With `recovering` and an earlier attempt on this session, the message is
   * wrapped in the recovery note.
   */
  async send(message, { recovering = false } = {}) {
    if (typeof message !== 'string') throw new TypeError('RoleContext.send: message must be a string')
    if (this.#busy) throw new Error(`RoleContext ${this.#spec.key}: concurrent send on one context`)
    this.#busy = true
    try {
      return await this.#send(message, recovering)
    } finally {
      this.#busy = false
    }
  }

  async #send(message, recovering) {
    let reg = await this.#readRegistry()
    let text = recovering && reg.attempted > 0 && !this.#spec.noSessionPersistence ? recoveryNote({ message }) : message
    let spent = 0
    let k = 0
    let degraded = false
    for (;;) {
      if (this.#signal?.aborted) throw new InterruptedError()
      const spec = this.#spec
      if (spec.noSessionPersistence && reg.attempted > 0) {
        // Nothing of a --no-session-persistence session survives (the summarizer): a retry or a later
        // message starts a fresh session with the original message (an id is never reused: R4).
        this.#sessionId = newUuid()
        reg = emptyRegistry()
        text = message
      }
      const first = reg.attempted === 0
      reg.attempted++
      await this.#writeRegistry(reg)
      const inv = await this.#invoke(spec, text, first, recovering)
      const c = inv.c
      switch (c.cls) {
        case 'reply': {
          reg.completed++
          const total = c.reply.costUsdTotal
          let delta = null
          if (Number.isFinite(total)) {
            delta = total >= reg.lastCostUsdTotal ? total - reg.lastCostUsdTotal : total
            reg.lastCostUsdTotal = total
          }
          await this.#writeRegistry(reg)
          return {
            text: c.reply.text,
            actions: c.reply.actions,
            truncated: c.reply.truncated,
            stopReason: c.reply.stopReason,
            model: c.reply.model,
            costUsdTotal: total,
            costUsdDelta: delta,
            sessionId: this.#sessionId,
            invocation: inv.n,
            numTurns: c.reply.numTurns,
            permissionDenials: c.reply.permissionDenials,
            guardGaps: inv.gaps.length,
            durationMs: inv.durationMs,
          }
        }
        case 'transient': {
          if (spent >= spec.pauseCeilingSecs) {
            throw new InfraError('transient_exhausted', `transient API errors persisted through ${spent} s of pauses (last: ${c.detail})`, { last: c.detail })
          }
          const t = spec.config?.transport ?? {}
          const pauseSecs = Number.isFinite(spec.pauseSecs) ? spec.pauseSecs : Number.isFinite(t.pauseSecs) ? t.pauseSecs : 30
          const pauseMaxSecs = Number.isFinite(spec.pauseMaxSecs) ? spec.pauseMaxSecs : Number.isFinite(t.pauseMaxSecs) ? t.pauseMaxSecs : 300
          const secs = Math.min(pauseSecs * 2 ** k, pauseMaxSecs)
          this.#event('TRANSPORT_PAUSE', { secs, cls: c.cls, status: c.status ?? null, invocation: inv.n })
          this.#logger?.warn?.('transient transport failure; pausing', { ctx: spec.key, secs, detail: c.detail })
          const aborted = await pause(secs * 1000, this.#signal)
          if (aborted) throw new InterruptedError('interrupted: the harness stopped during a transport pause')
          spent += secs
          text = recoveryNote({ message })
          k++
          continue
        }
        case 'sandbox_unavailable': {
          if (spec.sandboxDegrade !== 'allow' || degraded) throw new InfraError('sandbox_unavailable', c.detail)
          this.#event('ISOLATION_DEGRADED', { reason: c.detail, invocation: inv.n })
          await recordLiveResult(spec.home, { available: false, reason: c.detail }, { env: this.#parentEnv })
          // The child exited before creating a session (f2): the attempt does not count.
          reg.attempted--
          await this.#writeRegistry(reg)
          const answer = this.#onDegrade ? await this.#onDegrade(first) : null
          const nextSpec = answer && typeof answer === 'object' && answer.spec ? answer.spec : answer
          if (!nextSpec || typeof nextSpec !== 'object' || nextSpec.sandbox) {
            throw new InfraError('sandbox_unavailable', `${c.detail} (no unsandboxed role specification was provided)`)
          }
          this.setSpec(nextSpec)
          if (!first) {
            const note = answer && typeof answer.note === 'string' && answer.note !== '' ? answer.note : DEGRADE_NOTE
            text = `${note}\n\n${text}`
          }
          degraded = true
          continue
        }
        case 'session_missing':
          throw new InfraError('session_missing', c.detail, { established: reg.completed > 0 })
        case 'interrupted':
          throw new InterruptedError()
        default:
          throw new InfraError(c.cls, c.detail, { invocation: inv.n })
      }
    }
  }

  async #invoke(spec, text, first, recovering) {
    const { n, dir } = await claimInvocationDir(spec.logDir)
    const expect = sha256Hex(text)
    const guardLog = join(dir, 'guard.jsonl')
    const systemFile = await writeContentAddressed(join(spec.home, 'run', 'prompts'), spec.systemText, '.md')
    const pinFile = pinFileFor(spec)
    if (pinFile !== null && typeof spec.pinText === 'string' && spec.pinText !== '' && pinFile === join(spec.logDir, 'pin.md')) {
      const current = await readFile(pinFile, 'utf8').catch(() => null)
      if (current !== spec.pinText) await writeFileAtomic(pinFile, spec.pinText)
    }
    const policyFile = await writePolicy(spec.home, buildPolicy(spec))
    const passthrough = spec.config?.children?.envPassthrough ?? []
    const forwarded = await forwardedUserSettings({ env: this.#parentEnv, passthrough })
    const settingsFile = await writeSettings(spec.home, buildSettings(spec, { pluginRoot: spec.pluginRoot, forwarded }))
    const set = {}
    if (spec.config?.transport?.retryWatchdog !== false) {
      set.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      if (Number.isFinite(spec.watchdogMaxWaitMs) && spec.watchdogMaxWaitMs > 0) set.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = String(Math.floor(spec.watchdogMaxWaitMs))
    }
    if (spec.lossless) set.DISABLE_AUTO_COMPACT = '1'
    Object.assign(set, spec.extraEnv ?? {})
    // The guard's inputs always come from this invocation (extraEnv cannot replace them).
    Object.assign(set, {
      CC_RSI_ROLE: spec.role,
      CC_RSI_HOME: spec.home,
      CC_RSI_POLICY: policyFile,
      CC_RSI_GUARD_LOG: guardLog,
      CC_RSI_EXPECT: expect,
    })
    const env = childEnv({ parentEnv: this.#parentEnv, role: spec.role, set, passthrough, pluginRoot: spec.pluginRoot, home: spec.home })
    const argv = buildArgv({
      first,
      sessionId: this.#sessionId,
      model: spec.model,
      effort: spec.effort,
      systemFile,
      settingsFile,
      maxTurns: spec.maxTurns,
      maxBudgetUsd: spec.maxBudgetUsd,
      noSessionPersistence: spec.noSessionPersistence,
      tools: spec.tools,
    })
    const bin = this.#bin ?? (typeof spec.claudeBin === 'string' && spec.claudeBin !== '' ? spec.claudeBin : resolveClaudeBin({ config: spec.config, env: this.#parentEnv }))
    await writeFileAtomic(join(dir, 'prompt.md'), text)
    const meta = {
      n,
      role: spec.role,
      ctxKey: spec.key,
      sessionId: this.#sessionId,
      mode: first ? 'new' : 'resume',
      recovering: recovering === true,
      bin,
      argv,
      settingsFile,
      policyFile,
      systemFile,
      cwd: spec.cwd,
      expectDigest: expect,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    await writeJsonAtomic(join(dir, 'meta.json'), meta)
    const r = await runInvocation({
      bin,
      argv,
      cwd: spec.cwd,
      env,
      stdin: text,
      timeoutSec: spec.turnTimeoutSec,
      signal: this.#signal ?? undefined,
      dir,
      graceMs: Number.isFinite(spec.killGraceMs) ? spec.killGraceMs : 10000,
      keepStream: true,
    })
    const ps = parseStream(r.lines)
    let guardEntries = []
    try {
      guardEntries = readJsonlSync(guardLog)
    } catch {
      guardEntries = []
    }
    const attestation = hookAttestation(ps, guardEntries, expect)
    const c = classify({ spawnError: r.spawnError, exitCode: r.exitCode, signal: r.signal, killedBy: r.killedBy, stderr: r.stderr, ps, attestation })
    for (const w of c.warnings ?? []) this.#logger?.warn?.(w, { ctx: spec.key, invocation: n })
    if (spec.config?.children?.keepStreams === false) {
      const { rm } = await import('node:fs/promises')
      await rm(join(dir, 'stream.jsonl'), { force: true }).catch(() => undefined)
    }
    Object.assign(meta, {
      finishedAt: r.finishedAt,
      exitCode: r.exitCode,
      signal: r.signal,
      killedBy: r.killedBy,
      cls: c.cls,
      detail: c.detail,
      actions: ps.actions,
      numTurns: Number.isFinite(ps.result?.num_turns) ? ps.result.num_turns : null,
      costUsdTotal: Number.isFinite(ps.result?.total_cost_usd) ? ps.result.total_cost_usd : null,
      model: ps.init?.model ?? null,
      guardGaps: attestation.gaps,
      hooksRan: attestation.hooksRan,
      permissionDenials: Array.isArray(ps.result?.permission_denials) ? ps.result.permission_denials.length : 0,
      truncated: c.reply?.truncated ?? false,
      warnings: c.warnings ?? [],
      durationMs: r.durationMs,
    })
    await writeJsonAtomic(join(dir, 'meta.json'), meta)
    this.#event('ROLE_INVOCATION', { invocation: n, mode: meta.mode, cls: c.cls, actions: ps.actions, costUsdTotal: meta.costUsdTotal, model: meta.model, durationMs: r.durationMs })
    if (attestation.gaps.length > 0) {
      this.#event('GUARD_GAP', { invocation: n, toolUseIds: attestation.gaps })
      this.#logger?.warn?.('tool calls without a role-guard entry', { ctx: spec.key, invocation: n, toolUseIds: attestation.gaps })
    }
    return { n, c, gaps: attestation.gaps, durationMs: r.durationMs }
  }
}

// Role contexts in lineages (SPEC §12.5, §10.6 per-role table, §4.3 hidden roots, §10.12).
//
// One EngineContext is one persistent Claude Code session of one role identity (dsh-rsi
// RoleConversation; RSIAgent keeps one conversation per role). Its uuid comes from a journal op,
// so a resumed engine continues the very same session with `--resume`. Every message is a
// journaled `send` op; a recovering send re-sends through RoleContext with the recovery note
// (R1/F4), and a context whose first message never established a session restarts with a NEW
// uuid (R4 forbids reusing the id; SPEC §10.9).

import { realpathSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../core/digest.mjs'
import { uuid } from '../core/ids.mjs'
import { isUnderLexical, safeName } from '../core/paths.mjs'
import {
  curriculumSystem, engineSystem, memoryRevisit, strategyReviewSystem, summarizerSystem, taskPin, verifierSystem,
} from '../prompts/roles.mjs'
import { RoleContext } from '../runtime/context.mjs'
import { InfraError } from '../runtime/errors.mjs'
import { CONFIG_PRIVATE_TOKENS, harnessPrivateRoots, tokensWithoutOwn, withoutOwn } from '../runtime/private.mjs'
import { absRule } from '../runtime/settings.mjs'
import { MUTATION_BASH_DENY } from '../guard/bash.mjs'

const NEVER_TOOLS = ['Agent', 'Task', 'Skill', 'NotebookEdit']
const WEB_TOOLS = ['WebFetch', 'WebSearch']
const VERIFIER_DENY = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill']

/** Sub-directories of `dir` (dot entries such as the inert `<home>/work/.git` excluded). */
async function childDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => join(dir, e.name))
  } catch {
    return []
  }
}

const same = (a, b) => resolve(a) === resolve(b)

/** The plugin code this engine runs (the same tree as records.mjs ENGINE_PLUGIN_ROOT). */
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The running plugin code (both spellings): never writable by a role (security-4). */
function codeRoots(pluginRoot) {
  const out = new Set()
  for (const root of [CODE_ROOT, pluginRoot]) {
    if (typeof root !== 'string' || root === '') continue
    out.add(resolve(root))
    try { out.add(realpathSync(root)) } catch { /* lexical only */ }
  }
  return [...out]
}

/**
 * Hidden roots shared by every lineage role (SPEC §4.3 "all roles"), computed from the dirs that
 * exist at spawn time: the harness-private roots of every role child (lib/runtime/private.mjs:
 * harness state, Claude Code transcripts, credentials, plans, task lists, file and prompt history,
 * the user's session temp dirs, an external memory store; the same list as the interactive
 * Verifier's), all of `<home>/vscratch` (the interactive Verifiers' scratch; the lineage
 * Verifier's scratch is under <W>/verify-scratch), and every other lineage's work tree.
 */
async function commonHidden({ home, W, env, storeDir }) {
  const hidden = [...harnessPrivateRoots({ home, env, storeDir }), join(home, 'vscratch')]
  // Every other lineage's work tree (this project's siblings and other projects' trees).
  const work = join(home, 'work')
  const keyDir = resolve(W, '..')
  for (const key of await childDirs(work)) {
    if (!same(key, keyDir)) {
      hidden.push(key)
      continue
    }
    for (const other of await childDirs(key)) if (!same(other, W)) hidden.push(other)
  }
  return hidden
}

const COMMON_TOKENS = ['/.cc-rsi/projects', '/.cc-rsi/run', ...CONFIG_PRIVATE_TOKENS]

/**
 * A role's own TMPDIR (security-9): Claude Code keeps its session temp files (background task
 * output, scratchpads) under `$TMPDIR/claude-<uid>`, and the user's own session dirs there are
 * hidden from every role, so each role child gets a private one. Created before the spawn.
 */
async function ownTmp(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * The last step of every spec: hidden roots and tokens that would cover the role's own
 * directories are dropped (a deny rule over its own cwd would block the role), and the running
 * plugin code is read-only for file tools and (sandboxed) shell commands alike (security-4).
 */
function finalize(spec, p) {
  const own = [spec.cwd, ...(spec.addDirs ?? []), spec.scratch].filter(d => typeof d === 'string' && d !== '')
  const code = withoutOwn(codeRoots(p.pluginRoot), own)
  const out = {
    ...spec,
    hidden: withoutOwn(spec.hidden ?? [], own),
    hiddenTokens: tokensWithoutOwn(spec.hiddenTokens ?? [], own),
    readOnlyRoots: [...new Set([...(spec.readOnlyRoots ?? []), ...code])],
  }
  if (out.sandbox) out.sandbox = { ...out.sandbox, denyWrite: [...new Set([...(out.sandbox.denyWrite ?? []), ...code])] }
  return out
}

/**
 * The Actor's literal heuristic for `<W>/verify` (the practice Verifiers' original fixtures):
 * `../../verify` is that root seen from the Actor's cwd `<W>/projects/<ep>` or anything below it
 * (`$PWD/../../verify`, `../../../verify`). The absolute `<W>/verify` is a hidden root, and the guard
 * resolves relative operands against the cwd (following `cd`), so no bare `/verify/` token is used:
 * it also matched the Actor's own `<root>/verify/…`, `./verify/…` and URLs (prompts-11).
 */
const ACTOR_VERIFY_TOKEN = '../../verify'

/** The Actor's private scratch directory: `<W>/actor-private/<ep>/scratch` (beside its memory dir). */
export function actorScratchDir(memoryDir) {
  return join(resolve(memoryDir, '..'), 'scratch')
}

function modelFor(models, role) {
  return models?.[role] ?? null
}

/**
 * The RoleSpec of one lineage role message (SPEC §12.5 spec rules and the §10.6 table).
 * `p` = { role: 'actor'|'verifier'|'curriculum'|'summarizer', phase, kind, ep, W, home, pluginRoot,
 *        config, model, isolation, logDir, env, storeDir?, ... } with per-role fields:
 *  - actor: kind 'practice'|'target'|'frozen', root (cwd), memoryDir, target (pin text for target/frozen);
 *  - verifier: kind 'practice'|'target', root (cwd: the candidate at the Actor's own project root,
 *    a fresh replay for practice or the live root for targets), scratch, original?, allowUnverified;
 *  - curriculum: cwd, memoryDir (null when access none);
 *  - summarizer: cwd, review (strategy review system text).
 * `sandboxOff` forces the unsandboxed variant (degrade).
 */
export async function specFor(p) {
  return finalize(await buildSpec(p), p)
}

async function buildSpec(p) {
  const config = p.config ?? {}
  const transport = config.transport ?? {}
  const exploration = config.exploration ?? {}
  const isolationCfg = config.isolation ?? {}
  const env = p.env ?? process.env
  const sandboxed = p.isolation?.mode === 'sandbox' && p.sandboxOff !== true
  const common = await commonHidden({ home: p.home, W: p.W, env, storeDir: p.storeDir })
  const base = {
    key: p.key,
    role: p.role,
    phase: p.phase ?? null,
    home: p.home,
    pluginRoot: p.pluginRoot,
    config,
    logDir: p.logDir,
    model: p.model ?? null,
    effort: (config.effort?.[p.role] || '') || null,
    sandboxDegrade: p.isolation?.allowUnconfined ? 'allow' : 'refuse',
    pauseCeilingSecs: transport.pauseCeilingSecs?.lineage ?? 21600,
    watchdogMaxWaitMs: transport.watchdogMaxWaitMs?.lineage ?? 21600000,
    maxBudgetUsd: transport.maxBudgetUsdPerMessage > 0 ? transport.maxBudgetUsdPerMessage : null,
    maxTurns: transport.maxTurns?.[p.role] ?? (p.role === 'summarizer' ? 1 : 2000),
    turnTimeoutSec: transport.turnTimeoutSec?.[p.role] ?? (p.role === 'summarizer' ? 600 : 14400),
    userHome: env.HOME || undefined,
    extraEnv: {},
    bashDeny: [],
    hiddenTokens: [...COMMON_TOKENS, '/.cc-rsi/vscratch'],
    noSessionPersistence: false,
    liveness: false,
    stagnationRevisit: null,
    pinText: null,
    lossless: false,
  }
  const W = p.W
  if (p.role === 'actor') {
    const root = p.root
    const memdir = p.memoryDir
    // The Actor's private scratch (prompts-3): beside its memory under <W>/actor-private/<ep>,
    // outside the project root (never captured) and hidden from every other role.
    const scratch = actorScratchDir(memdir)
    await ownTmp(join(scratch, 'tmp'))
    const learn = p.phase === 'learn'
    const web = exploration.webTools === true
    const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...(web ? WEB_TOOLS : [])]
    const allow = ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', root), ...(web ? WEB_TOOLS : [])]
    const deny = [...NEVER_TOOLS, ...(web ? [] : WEB_TOOLS)]
    if (learn) allow.push(absRule('Edit', memdir))
    else deny.push(absRule('Edit', memdir))
    const hidden = [...common, join(W, 'curriculum-private'), join(W, 'verify'), join(W, 'verify-scratch'), join(W, 'summarizer')]
    for (const dir of await childDirs(join(W, 'actor-private'))) if (!same(dir, resolve(memdir, '..'))) hidden.push(dir)
    for (const dir of await childDirs(join(W, 'projects'))) if (!same(dir, root)) hidden.push(dir)
    const compaction = p.kind === 'practice' ? transport.compaction?.practiceActor : transport.compaction?.targetActor
    const pinned = p.kind === 'target' || p.kind === 'frozen'
    return {
      ...base,
      cwd: root,
      addDirs: [memdir, scratch],
      tools,
      allow: [...allow, absRule('Edit', scratch)],
      deny,
      readRoots: [root, memdir, scratch],
      writeRoots: learn ? [root, memdir, scratch] : [root, scratch],
      readOnlyRoots: learn ? [] : [memdir],
      hidden,
      hiddenTokens: [...base.hiddenTokens, 'curriculum-private', 'verify-scratch', ACTOR_VERIFY_TOKEN],
      sandbox: sandboxed
        ? { allowWrite: learn ? [root, memdir, scratch] : [root, scratch], denyWrite: learn ? [] : [memdir], denyRead: [], network: isolationCfg.actorNetwork ?? [] }
        : null,
      extraEnv: { TMPDIR: join(scratch, 'tmp') },
      systemText: engineSystem(),
      lossless: (compaction ?? (p.kind === 'practice' ? 'off' : 'auto')) === 'off',
      pinText: pinned && typeof p.target === 'string' && p.target.trim() !== ''
        ? `${taskPin({ messages: [{ text: p.target, current: true }] })}${memoryRevisit('fold', { memoryDir: memdir })}`
        : null,
      liveness: true,
      stagnationRevisit: memoryRevisit('stagnation', { memoryDir: memdir }),
    }
  }
  if (p.role === 'verifier') {
    const root = p.root
    const scratch = p.scratch
    const original = p.original ?? null
    // Practice candidates are replayed at the Actor's own root (<W>/projects/<ep>, RSIAgent's one
    // project path for both roles); the Verifier's own <W>/verify/<ep> holds its original fixtures.
    const own = dir => isUnderLexical(root, dir) || (p.kind === 'practice' && original !== null && isUnderLexical(original, dir))
    const hidden = [...common, join(W, 'curriculum-private'), join(W, 'actor-private'), join(W, 'summarizer')]
    for (const dir of await childDirs(join(W, 'projects'))) if (!own(dir)) hidden.push(dir)
    for (const dir of await childDirs(join(W, 'verify'))) if (!(p.kind === 'practice' && own(dir))) hidden.push(dir)
    for (const dir of await childDirs(join(W, 'verify-scratch'))) if (!same(dir, scratch)) hidden.push(dir)
    const addDirs = [scratch, ...(original ? [original] : [])]
    const readOnly = [root, ...(original ? [original] : [])]
    return {
      ...base,
      cwd: root,
      addDirs,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      allow: ['Read', 'Grep', 'Glob', 'Bash'],
      deny: [...VERIFIER_DENY],
      readRoots: [root, ...addDirs],
      writeRoots: [],
      readOnlyRoots: readOnly,
      hidden,
      hiddenTokens: [...COMMON_TOKENS, 'actor-private', 'curriculum-private'],
      bashDeny: !sandboxed && isolationCfg.verifierBashDeny !== false ? MUTATION_BASH_DENY : [],
      sandbox: sandboxed ? { allowWrite: [scratch], denyWrite: readOnly, denyRead: [], network: isolationCfg.verifierNetwork ?? [] } : null,
      // Live inspections checkpoint and restore the whole project root (inspectTarget), so the full
      // rollback paragraph is accurate (prompts-1); keep in sync with target.mjs targetVerifier.
      systemText: verifierSystem({ location: p.kind === 'practice' ? 'replay' : 'live', sandbox: sandboxed, allowUnverified: p.allowUnverified === true, checkpoint: 'full' }),
      lossless: (transport.compaction?.verifier ?? 'off') === 'off',
      scratch,
      extraEnv: { VERIFIER_SCRATCH: scratch, TMPDIR: join(scratch, 'tmp') },
    }
  }
  if (p.role === 'curriculum') {
    const cwd = p.cwd
    const memory = join(cwd, 'memory')
    const tmp = await ownTmp(join(cwd, '.tmp'))
    const hidden = [...common, join(W, 'actor-private'), join(W, 'projects'), join(W, 'verify'), join(W, 'verify-scratch'), join(W, 'summarizer')]
    return {
      ...base,
      cwd,
      addDirs: [],
      tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
      allow: ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', cwd)],
      deny: [...NEVER_TOOLS, ...WEB_TOOLS, absRule('Edit', memory)],
      readRoots: [cwd],
      writeRoots: [cwd],
      readOnlyRoots: [memory],
      hidden,
      hiddenTokens: [...base.hiddenTokens, 'actor-private', 'verify-scratch'],
      sandbox: sandboxed ? { allowWrite: [cwd], denyWrite: [memory], denyRead: [], network: [] } : null,
      extraEnv: { TMPDIR: tmp },
      systemText: `${engineSystem()}\n\n${curriculumSystem()}`,
      lossless: (transport.compaction?.curriculum ?? 'off') === 'off',
      liveness: true,
      stagnationRevisit: p.memoryDir ? memoryRevisit('stagnation', { memoryDir: p.memoryDir }) : null,
    }
  }
  if (p.role === 'summarizer') {
    const cwd = p.cwd
    const hidden = [...common, join(W, 'curriculum-private'), join(W, 'actor-private'), join(W, 'projects'), join(W, 'verify'), join(W, 'verify-scratch')]
    return {
      ...base,
      cwd,
      addDirs: [],
      tools: [],
      allow: [],
      deny: [],
      readRoots: [cwd],
      writeRoots: [],
      readOnlyRoots: [],
      hidden,
      sandbox: null,
      systemText: p.review ? strategyReviewSystem() : summarizerSystem(),
      noSessionPersistence: true,
      maxTurns: transport.maxTurns?.summarizer ?? 1,
      turnTimeoutSec: transport.turnTimeoutSec?.summarizer ?? 600,
      pauseCeilingSecs: Math.min(transport.pauseCeilingSecs?.lineage ?? 600, 600),
    }
  }
  throw new TypeError(`specFor: unknown role ${JSON.stringify(p.role)}`)
}

/**
 * Journaled wrapper around RoleContext (SPEC §12.5).
 * `specFn(phase, { sandboxOff })` → RoleSpec (async allowed); options `{ model, role, run }`, plus
 * `onContextLost(message) → string|null` (cc-rsi addition: a Curriculum whose transcript was lost
 * at a completed wave boundary restarts with the charter + phase1RecoveryNotice) and `trackCost`
 * (default true; false when an enclosing op records the cost).
 */
export class EngineContext {
  #j
  #key
  #specFn
  #model
  #role
  #run
  #phase = 'work'
  #onContextLost
  #trackCost

  constructor(j, key, specFn, { model = null, role, run, onContextLost, trackCost = true } = {}) {
    this.#j = j
    this.#key = key
    this.#specFn = specFn
    this.#model = model
    this.#role = role
    this.#run = run ?? null
    this.#onContextLost = typeof onContextLost === 'function' ? onContextLost : null
    this.#trackCost = trackCost !== false
  }

  get key() {
    return this.#key
  }

  get role() {
    return this.#role
  }

  get model() {
    return this.#model
  }

  /** The context's invocation log directory (`<lineageDir>/ctx/<safeName(key)>`). */
  get logDir() {
    return join(this.#run.lineageDir, 'ctx', safeName(this.#key))
  }

  /** op `${key}/open` → {sessionId: uuid()}; event ROLE_CONTEXT_STARTED. Idempotent. */
  async open() {
    const r = await this.#j.op(`${this.#key}/open`, 'open', { role: this.#role, model: this.#model }, () => ({ sessionId: uuid(), role: this.#role, model: this.#model }))
    await this.#event(`${this.#key}/ev:started`, 'ROLE_CONTEXT_STARTED', { ctx: this.#key, role: this.#role, sessionId: r.sessionId, model: this.#model })
    return r
  }

  async #event(key, type, data) {
    if (this.#run?.event) return this.#run.event(key, type, data)
    return this.#j.event(key, type, data)
  }

  /** The open result's session id, then the latest done `${key}/restart:<n>` result. */
  get sessionId() {
    let id = this.#j.result(`${this.#key}/open`)?.sessionId ?? null
    for (const key of this.#restartKeys()) id = this.#j.result(key)?.sessionId ?? id
    return id
  }

  #restartKeys() {
    return this.#j.keysWithPrefix(`${this.#key}/restart:`)
      .filter(key => /\/restart:\d+$/.test(key) && this.#j.isDone(key))
      .sort((a, b) => Number(a.slice(a.lastIndexOf(':') + 1)) - Number(b.slice(b.lastIndexOf(':') + 1)))
  }

  get phase() {
    return this.#phase
  }

  /**
   * Replaces the context-loss handler: `fn(message) → string|null`. A Verifier whose established
   * transcript is gone restarts with its charter re-rendered with its own prior reports (SPEC
   * §10.9: "Verifier → a fresh context seeded with its prior reports").
   */
  setContextLost(fn) {
    this.#onContextLost = typeof fn === 'function' ? fn : null
  }

  setPhase(phase) {
    if (phase !== 'work' && phase !== 'learn') throw new TypeError(`EngineContext.setPhase: ${phase}`)
    this.#phase = phase
  }

  async #roleContext(sessionId) {
    const run = this.#run
    const spec = await this.#specFn(this.#phase, { sandboxOff: run?.sandboxDegraded === true })
    const onDegrade = async () => {
      if (run) run.sandboxDegraded = true
      return { spec: await this.#specFn(this.#phase, { sandboxOff: true }) }
    }
    return new RoleContext(spec, {
      sessionId,
      logger: run?.logger,
      onRuntimeEvent: (type, data) => run?.runtimeEvent?.(type, data),
      signal: run?.signal,
      onDegrade,
      parentEnv: run?.env,
    })
  }

  async #deliver(sessionId, message, recovering) {
    // The plugin code must still be the lineage's baseline before any role child starts (security-4).
    await this.#run?.checkPlugin?.()
    const ctx = await this.#roleContext(sessionId)
    return ctx.send(message, { recovering })
  }

  async #restart(oldSessionId, reason) {
    const n = this.#restartKeys().length + 1
    const r = await this.#j.op(`${this.#key}/restart:${n}`, 'restart', { from: oldSessionId }, () => ({ sessionId: uuid() }))
    await this.#event(`${this.#key}/restart:${n}/ev`, 'ROLE_CONTEXT_RESTARTED', {
      ctx: this.#key, oldSessionId, newSessionId: r.sessionId, reason,
    })
    return r.sessionId
  }

  /**
   * One journaled message: op(opKey, 'send', {ctx, msgSha, phase}) → RoleContext.send. A first
   * message that never established a session (R3, established:false) restarts the context with a
   * new uuid and the original message, once; an established context whose transcript is gone is
   * InfraError('context_lost'); every other error is rethrown with extra.opKey.
   */
  async send(opKey, message) {
    const args = { ctx: this.#key, msgSha: sha256Hex(message), phase: this.#phase }
    const reply = await this.#j.op(opKey, 'send', args, async ({ recovering }) => {
      if (!this.#j.isDone(`${this.#key}/open`)) await this.open()
      const sessionId = this.sessionId
      try {
        return await this.#deliver(sessionId, message, recovering)
      } catch (error) {
        if (!(error instanceof InfraError) || error.cls !== 'session_missing') {
          if (error instanceof InfraError && error.extra && error.extra.opKey === undefined) error.extra.opKey = opKey
          throw error
        }
        if (error.extra?.established === false) {
          const fresh = await this.#restart(sessionId, 'first message never established a session (R3)')
          return this.#deliver(fresh, message, false)
        }
        const replacement = this.#onContextLost ? await this.#onContextLost(message) : null
        if (typeof replacement === 'string' && replacement !== '') {
          const fresh = await this.#restart(sessionId, 'the established transcript is gone; restarted at a completed boundary')
          return this.#deliver(fresh, replacement, false)
        }
        throw new InfraError('context_lost', `the ${this.#role} context ${this.#key} (session ${sessionId}) lost its transcript: ${error.detail}`, { opKey, sessionId })
      }
    })
    // Recorded replies are re-counted on replay (SPEC §12.1 rule 5); a context nested inside an
    // enclosing op (the summarizer) leaves the counting to that op's recorded result.
    if (this.#trackCost) this.#run?.addCost?.(reply?.costUsdDelta)
    return reply
  }
}

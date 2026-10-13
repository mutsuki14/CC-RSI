// Role contexts in lineages (SPEC §12.5, §10.6 per-role table, §4.3 hidden roots, §10.12).
//
// One EngineContext is one persistent Claude Code session of one role identity (dsh-rsi
// RoleConversation; RSIAgent keeps one conversation per role). Its uuid comes from a journal op,
// so a resumed engine continues the very same session with `--resume`. Every message is a
// journaled `send` op; a recovering send re-sends through RoleContext with the recovery note
// (R1/F4), and a context whose first message never established a session restarts with a NEW
// uuid (R4 forbids reusing the id; SPEC §10.9).

import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256Hex } from '../core/digest.mjs'
import { uuid } from '../core/ids.mjs'
import { safeName } from '../core/paths.mjs'
import {
  curriculumSystem, engineSystem, memoryRevisit, strategyReviewSystem, summarizerSystem, taskPin, verifierSystem,
} from '../prompts/roles.mjs'
import { RoleContext } from '../runtime/context.mjs'
import { InfraError } from '../runtime/errors.mjs'
import { claudeConfigDir } from '../runtime/models.mjs'
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

/**
 * Hidden roots shared by every lineage role (SPEC §4.3 "all roles"), computed from the dirs that
 * exist at spawn time. The lineage Verifier's scratch is under <W>/verify-scratch, so all of
 * `<home>/vscratch` (the interactive Verifiers' scratch) is hidden from every lineage role.
 */
async function commonHidden({ home, W, env }) {
  const userHome = env.HOME || process.env.HOME || ''
  const hidden = [join(home, 'projects'), join(home, 'run'), join(home, 'bin'), join(home, 'config.json'), join(home, 'vscratch')]
  if (userHome) hidden.push(join(userHome, '.claude', 'projects'), join(userHome, '.claude', '.credentials.json'))
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '') hidden.push(join(claudeConfigDir(env), 'projects'))
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

const COMMON_TOKENS = ['/.cc-rsi/projects', '/.cc-rsi/run', '.claude/projects', '.claude/.credentials']

function modelFor(models, role) {
  return models?.[role] ?? null
}

/**
 * The RoleSpec of one lineage role message (SPEC §12.5 spec rules and the §10.6 table).
 * `p` = { role: 'actor'|'verifier'|'curriculum'|'summarizer', phase, kind, ep, W, home, pluginRoot,
 *        config, model, isolation, logDir, env, ... } with per-role fields:
 *  - actor: kind 'practice'|'target'|'frozen', root (cwd), memoryDir, target (pin text for target/frozen);
 *  - verifier: kind 'practice'|'target', root (cwd: candidate copy or live root), scratch, original?,
 *    allowUnverified;
 *  - curriculum: cwd, memoryDir (null when access none);
 *  - summarizer: cwd, review (strategy review system text).
 * `sandboxOff` forces the unsandboxed variant (degrade).
 */
export async function specFor(p) {
  const config = p.config ?? {}
  const transport = config.transport ?? {}
  const exploration = config.exploration ?? {}
  const isolationCfg = config.isolation ?? {}
  const env = p.env ?? process.env
  const sandboxed = p.isolation?.mode === 'sandbox' && p.sandboxOff !== true
  const common = await commonHidden({ home: p.home, W: p.W, env })
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
      addDirs: [memdir],
      tools,
      allow,
      deny,
      readRoots: [root, memdir],
      writeRoots: learn ? [root, memdir] : [root],
      readOnlyRoots: learn ? [] : [memdir],
      hidden,
      hiddenTokens: [...base.hiddenTokens, 'curriculum-private', 'verify-scratch', '/verify/'],
      sandbox: sandboxed
        ? { allowWrite: learn ? [root, memdir] : [root], denyWrite: learn ? [] : [memdir], denyRead: [], network: isolationCfg.actorNetwork ?? [] }
        : null,
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
    const ownVerify = p.kind === 'practice' ? resolve(root, '..') : null
    const hidden = [...common, join(W, 'curriculum-private'), join(W, 'actor-private'), join(W, 'summarizer')]
    for (const dir of await childDirs(join(W, 'projects'))) if (!(p.kind === 'target' && same(dir, root))) hidden.push(dir)
    for (const dir of await childDirs(join(W, 'verify'))) if (!(ownVerify && same(dir, ownVerify))) hidden.push(dir)
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
      systemText: verifierSystem({ location: p.kind === 'practice' ? 'replay' : 'live', sandbox: sandboxed, allowUnverified: p.allowUnverified === true }),
      lossless: (transport.compaction?.verifier ?? 'off') === 'off',
      scratch,
      extraEnv: { VERIFIER_SCRATCH: scratch, TMPDIR: join(scratch, 'tmp') },
    }
  }
  if (p.role === 'curriculum') {
    const cwd = p.cwd
    const memory = join(cwd, 'memory')
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

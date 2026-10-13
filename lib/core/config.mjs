// Configuration: defaults, layered loading, global-only and tighten-only rules, validation
// (SPEC §5.2, §14). Synchronous so hooks can load it on their hot path. Never throws for
// missing or malformed files: every problem becomes a warning.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './digest.mjs'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** SPEC §14.2, dotted keys nested. Deep-frozen; `loadConfig` returns fresh mutable copies. */
export const DEFAULTS = deepFreeze({
  mode: 'learn',
  models: { actor: '', verifier: '', curriculum: '', summarizer: '', escalation: '' },
  effort: { actor: '', verifier: '', curriculum: '', summarizer: '' },
  interactive: {
    enabled: true,
    taskMessages: 3,
    waitSeconds: 100,
    allowUnverified: true,
    verifierIdleHours: 24,
    stopPolicy: 'nudge',
    stopGateMax: 3,
    baseline: true,
    rewake: true,
    checkpointMaxBytes: 268435456,
    checkpointMaxFiles: 20000,
  },
  isolation: {
    sandbox: 'auto',
    allowUnconfined: false,
    verifierNetwork: [],
    actorNetwork: [],
    foreignMessageGuard: true,
    verifierBashDeny: true,
  },
  transport: {
    actionlessLimit: 3,
    ceiling: 24,
    pauseSecs: 30,
    pauseMaxSecs: 300,
    pauseCeilingSecs: { interactive: 1800, lineage: 21600 },
    retryWatchdog: true,
    watchdogMaxWaitMs: { interactive: 1800000, lineage: 21600000 },
    turnTimeoutSec: { actor: 14400, verifier: 14400, interactiveVerifier: 7200, curriculum: 14400, summarizer: 600 },
    maxTurns: { actor: 2000, verifier: 2000, curriculum: 2000, summarizer: 1 },
    maxBudgetUsdPerMessage: 0,
    compaction: { practiceActor: 'off', targetActor: 'auto', verifier: 'off', curriculum: 'off' },
    livenessNotes: true,
  },
  exploration: {
    waveConcurrency: 2,
    waveCeiling: 16,
    broadProjectBudget: 12,
    deepPracticeBudget: 6,
    targetCycleBudget: 6,
    unverifiedRounds: 3,
    targetResumes: 1,
    branchRetries: 1,
    frozenRepairRounds: 8,
    stopPolicy: 'curriculum_review',
    curriculumMemoryAccess: 'read_only',
    escalationHandoverReports: false,
    synthesizeWorklog: true,
    webTools: false,
    maxCostUsd: 0,
    modelMayStart: false,
  },
  memory: { dir: '', maxFiles: 400, maxTotalBytes: 4194304, maxFileBytes: 65536, keepHistory: true, promptInventory: 40 },
  audit: { sealedTextFiles: [], shingleWords: 8 },
  evaluation: { command: [], timeoutSec: 900, retries: 2, identicalErrorLimit: 3 },
  children: { claudeBin: '', envPassthrough: [], keepStreams: true },
})

/** Keys (or key prefixes) honoured only from `<home>/config.json` or the CLI (**G** in §14.2). */
export const GLOBAL_ONLY = Object.freeze([
  'isolation.allowUnconfined',
  'isolation.foreignMessageGuard',
  'isolation.verifierBashDeny',
  'exploration.modelMayStart',
  'memory.dir',
  'audit.sealedTextFiles',
  'evaluation',
  'children.claudeBin',
  'children.envPassthrough',
])

/**
 * Keys the project file may only tighten (**T** in §14.2). `order` lists values from loosest
 * to strictest; `intersect` means the project list may only remove entries.
 */
export const TIGHTEN_ONLY = Object.freeze({
  'isolation.sandbox': Object.freeze({ order: Object.freeze(['off', 'auto', 'require']) }),
  'isolation.verifierNetwork': Object.freeze({ intersect: true }),
  'isolation.actorNetwork': Object.freeze({ intersect: true }),
  'exploration.webTools': Object.freeze({ order: Object.freeze([true, false]) }),
})

/** Plugin userConfig keys → config keys (§5.2 step 3). */
export const USERCONFIG_MAP = Object.freeze({
  verifier_model: 'models.verifier',
  stop_policy: 'interactive.stopPolicy',
  sandbox: 'isolation.sandbox',
})

const int = (min, max = Number.MAX_SAFE_INTEGER) => ({ int: true, min, max })
const num = (min, max = Number.MAX_VALUE) => ({ min, max })
const oneOf = (...values) => ({ enum: values })

/** Range and enum rules beyond "same type as the default". */
const RULES = {
  mode: oneOf('learn', 'frozen'),
  'interactive.taskMessages': int(1, 16),
  'interactive.waitSeconds': int(10, 110),
  'interactive.verifierIdleHours': num(0),
  'interactive.stopPolicy': oneOf('off', 'nudge', 'gate'),
  'interactive.stopGateMax': int(0, 8),
  'interactive.checkpointMaxBytes': int(0),
  'interactive.checkpointMaxFiles': int(0),
  'isolation.sandbox': oneOf('off', 'auto', 'require'),
  'transport.actionlessLimit': int(1),
  'transport.ceiling': int(1),
  'transport.pauseSecs': num(0),
  'transport.pauseMaxSecs': num(0),
  'transport.pauseCeilingSecs.interactive': num(0),
  'transport.pauseCeilingSecs.lineage': num(0),
  'transport.watchdogMaxWaitMs.interactive': int(0),
  'transport.watchdogMaxWaitMs.lineage': int(0),
  'transport.turnTimeoutSec.actor': num(1),
  'transport.turnTimeoutSec.verifier': num(1),
  'transport.turnTimeoutSec.interactiveVerifier': num(1),
  'transport.turnTimeoutSec.curriculum': num(1),
  'transport.turnTimeoutSec.summarizer': num(1),
  'transport.maxTurns.actor': int(1),
  'transport.maxTurns.verifier': int(1),
  'transport.maxTurns.curriculum': int(1),
  'transport.maxTurns.summarizer': int(1),
  'transport.maxBudgetUsdPerMessage': num(0),
  'transport.compaction.practiceActor': oneOf('off', 'auto'),
  'transport.compaction.targetActor': oneOf('off', 'auto'),
  'transport.compaction.verifier': oneOf('off', 'auto'),
  'transport.compaction.curriculum': oneOf('off', 'auto'),
  'exploration.waveConcurrency': int(1, 8),
  'exploration.waveCeiling': int(1),
  'exploration.broadProjectBudget': int(0),
  'exploration.deepPracticeBudget': int(0),
  'exploration.targetCycleBudget': int(0),
  'exploration.unverifiedRounds': int(0),
  'exploration.targetResumes': int(0),
  'exploration.branchRetries': int(0),
  'exploration.frozenRepairRounds': int(0),
  'exploration.stopPolicy': oneOf('curriculum_review', 'verifier_pass'),
  'exploration.curriculumMemoryAccess': oneOf('read_only', 'none'),
  'exploration.maxCostUsd': num(0),
  'memory.maxFiles': int(1),
  'memory.maxTotalBytes': int(1),
  'memory.maxFileBytes': int(1),
  'memory.promptInventory': int(0),
  'audit.shingleWords': int(3),
  'evaluation.timeoutSec': num(1),
  'evaluation.retries': int(0),
  'evaluation.identicalErrorLimit': int(1),
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Value at a dotted key, or undefined. */
export function getKey(config, dotted) {
  let cursor = config
  for (const part of String(dotted).split('.')) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

function setKey(target, dotted, value) {
  const parts = dotted.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
}

/** `configSha(config)` = sha256(canonicalJson(config)). */
export function configSha(config) {
  return sha256Hex(canonicalJson(config))
}

function isGlobalOnly(dotted) {
  return GLOBAL_ONLY.some(prefix => dotted === prefix || dotted.startsWith(`${prefix}.`))
}

/**
 * Flattens one layer into `[dotted, value]` leaves following the DEFAULTS shape. Accepts
 * nested objects and dotted keys alike. Unknown keys and invalid values become warnings.
 */
function leavesOf(layer, label, warnings) {
  const out = []
  const visit = (value, prefix) => {
    for (const [key, raw] of Object.entries(value)) {
      const dotted = prefix ? `${prefix}.${key}` : key
      if (key.includes('.')) {
        // A dotted key inside a layer ({"models.verifier": "opus"}) is expanded.
        const nested = {}
        setKey(nested, key, raw)
        visit(nested, prefix)
        continue
      }
      const def = getKey(DEFAULTS, dotted)
      if (def === undefined) {
        warnings.push(`config: unknown key "${dotted}" in ${label} (ignored)`)
        continue
      }
      if (isPlainObject(def)) {
        if (!isPlainObject(raw)) {
          warnings.push(`config: "${dotted}" in ${label} must be an object (ignored)`)
          continue
        }
        visit(raw, dotted)
        continue
      }
      const problem = validate(dotted, raw, def)
      if (problem) {
        warnings.push(`config: "${dotted}" in ${label} ${problem}; using the default or a lower layer`)
        continue
      }
      out.push([dotted, clone(raw)])
    }
  }
  if (isPlainObject(layer)) visit(layer, '')
  else if (layer !== undefined && layer !== null) warnings.push(`config: ${label} is not a JSON object (ignored)`)
  return out
}

/** Problem text for an invalid leaf value, or null. */
function validate(dotted, value, def) {
  if (Array.isArray(def)) {
    if (!Array.isArray(value)) return 'must be an array'
    if (!value.every(item => typeof item === 'string')) return 'must be an array of strings'
    return null
  }
  if (typeof value !== typeof def) return `must be a ${typeof def}`
  const rule = RULES[dotted]
  if (typeof def === 'number') {
    if (!Number.isFinite(value)) return 'must be a finite number'
    if (rule?.int && !Number.isInteger(value)) return 'must be an integer'
    if (rule && (value < rule.min || value > rule.max)) {
      return `must be between ${rule.min} and ${rule.max === Number.MAX_SAFE_INTEGER || rule.max === Number.MAX_VALUE ? 'unbounded' : rule.max}`
    }
    if (!rule && value < 0) return 'must not be negative'
  }
  if (rule?.enum && !rule.enum.includes(value)) return `must be one of ${rule.enum.map(v => JSON.stringify(v)).join(', ')}`
  return null
}

function readLayer(path, label, warnings) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') warnings.push(`config: cannot read ${label} ${path}: ${error.message}`)
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) {
      warnings.push(`config: ${label} ${path} is not a JSON object (ignored)`)
      return undefined
    }
    return parsed
  } catch (error) {
    warnings.push(`config: malformed ${label} ${path}: ${error.message} (ignored)`)
    return undefined
  }
}

function stricter(rule, candidate, current) {
  if (rule.order) {
    const a = rule.order.indexOf(candidate)
    const b = rule.order.indexOf(current)
    return a > b
  }
  return false
}

/**
 * Loads the effective configuration (SPEC §5.2):
 * DEFAULTS < `<home>/config.json` < `<projectRoot>/.claude/cc-rsi.json` (GLOBAL_ONLY keys
 * dropped, TIGHTEN_ONLY keys applied only when stricter) < non-empty `userConfig` < `cli`.
 * Returns `{ config, warnings, sources }`; `sources[dotted]` names the layer that supplied each
 * leaf ('default' | 'global' | 'project' | 'userConfig' | 'cli').
 */
export function loadConfig({ home, projectRoot, userConfig = {}, cli = {} } = {}) {
  const warnings = []
  const config = clone(DEFAULTS)
  const sources = {}
  const visitDefaults = (value, prefix) => {
    for (const [key, v] of Object.entries(value)) {
      const dotted = prefix ? `${prefix}.${key}` : key
      if (isPlainObject(v)) visitDefaults(v, dotted)
      else sources[dotted] = 'default'
    }
  }
  visitDefaults(DEFAULTS, '')
  const apply = (leaves, source) => {
    for (const [dotted, value] of leaves) {
      setKey(config, dotted, value)
      sources[dotted] = source
    }
  }

  // 1. global file
  if (home) {
    const globalPath = join(home, 'config.json')
    const layer = readLayer(globalPath, 'global config', warnings)
    if (layer) apply(leavesOf(layer, globalPath, warnings), 'global')
  }

  // 2. project file: GLOBAL_ONLY dropped, TIGHTEN_ONLY held back for step 5
  const held = []
  if (projectRoot) {
    const projectPath = join(projectRoot, '.claude', 'cc-rsi.json')
    const layer = readLayer(projectPath, 'project config', warnings)
    if (layer) {
      const leaves = []
      for (const [dotted, value] of leavesOf(layer, projectPath, warnings)) {
        if (isGlobalOnly(dotted)) {
          warnings.push(`config: "${dotted}" is honoured only in ~/.cc-rsi/config.json; ignored from ${projectPath}`)
        } else if (TIGHTEN_ONLY[dotted]) {
          held.push([dotted, value, projectPath])
        } else {
          leaves.push([dotted, value])
        }
      }
      apply(leaves, 'project')
    }
  }

  // 3. non-empty userConfig values
  const mapped = {}
  for (const [key, value] of Object.entries(isPlainObject(userConfig) ? userConfig : {})) {
    if (value === undefined || value === null || value === '') continue
    const dotted = USERCONFIG_MAP[key] ?? key
    setKey(mapped, dotted, value)
  }
  apply(leavesOf(mapped, 'plugin userConfig', warnings), 'userConfig')

  // 4. CLI
  apply(leavesOf(isPlainObject(cli) ? cli : {}, 'command-line options', warnings), 'cli')

  // 5. tighten-only project values
  for (const [dotted, value, projectPath] of held) {
    const rule = TIGHTEN_ONLY[dotted]
    const current = getKey(config, dotted)
    if (rule.intersect) {
      const allowed = new Set(value)
      const next = current.filter(item => allowed.has(item))
      const dropped = value.filter(item => !current.includes(item))
      if (dropped.length > 0) {
        warnings.push(`config: "${dotted}" in ${projectPath} may only remove entries; ignored additions ${dropped.map(v => JSON.stringify(v)).join(', ')}`)
      }
      if (next.length !== current.length) {
        setKey(config, dotted, next)
        sources[dotted] = 'project'
      }
    } else if (stricter(rule, value, current)) {
      setKey(config, dotted, value)
      sources[dotted] = 'project'
    } else if (value !== current) {
      warnings.push(`config: "${dotted}" = ${JSON.stringify(value)} in ${projectPath} would loosen ${JSON.stringify(current)}; ignored (tighten-only)`)
    }
  }

  return { config, warnings, sources }
}

/**
 * Reads the plugin userConfig from the environment: `${prefix}VERIFIER_MODEL`,
 * `${prefix}STOP_POLICY`, `${prefix}SANDBOX` (prefix 'CLAUDE_PLUGIN_OPTION_' for hooks,
 * 'CC_RSI_OPT_' for the MCP server). Only variables that are present are returned; an
 * unsubstituted `${user_config.…}` placeholder is treated as absent.
 */
export function userConfigFromEnv(env = process.env, prefix = 'CLAUDE_PLUGIN_OPTION_') {
  const out = {}
  for (const key of Object.keys(USERCONFIG_MAP)) {
    const value = env?.[`${prefix}${key.toUpperCase()}`]
    if (typeof value !== 'string') continue
    if (/^\$\{[^}]*\}$/.test(value.trim())) continue
    out[key] = value.trim()
  }
  return out
}

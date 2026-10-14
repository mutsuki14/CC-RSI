// Per-invocation --settings file for a role child (SPEC §10.6 `settings.mjs`).
//
// Everything that scopes a role lives here rather than in argv (variadic flags would swallow the
// prompt; claude-code-experiments.md f3): permissions with `additionalDirectories` (working dirs
// under --restricted, proposal-fidelity F5), the fail-closed role guard hooks (settings-file hooks
// fire under --restricted, F1), the sandbox block only when the sandbox is in use (keys honoured,
// `failIfUnavailable` exits before any model call, EXP f2), and forwarded auth/provider settings
// (J2-2; --restricted ignores the user settings file).

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ensureDir, writeFileAtomic } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { FORWARDED_KEYS } from './auth-settings.mjs'

/**
 * `${tool}(/${absDir}/**)`: a Claude Code permission rule for everything below an absolute
 * directory (the `//` prefix marks an absolute path; EXP E4/E11). `absRule('Edit', '/home/u/x')`
 * → `Edit(//home/u/x/**)`. Throws TypeError for a relative path.
 */
export function absRule(tool, absDir) {
  if (typeof tool !== 'string' || tool === '') throw new TypeError('absRule: tool is required')
  if (typeof absDir !== 'string' || !absDir.startsWith('/')) throw new TypeError(`absRule: ${JSON.stringify(absDir)} is not an absolute path`)
  const dir = resolve(absDir)
  return dir === '/' ? `${tool}(//**)` : `${tool}(/${dir}/**)`
}

function uniq(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function hookCommand(nodePath, pluginRoot, mode, { block }) {
  const hook = { type: 'command', command: nodePath, args: [join(pluginRoot, 'hooks', 'role-guard.mjs'), mode], timeout: 10 }
  if (block) hook.onFailure = 'block'
  return hook
}

/** Whether `child` lies strictly below `parent` (lexical, both resolved). */
function strictlyUnder(child, parent) {
  return child !== parent && (parent === '/' ? child.startsWith('/') : child.startsWith(`${parent}/`))
}

/** A Claude Code Read rule for exactly one absolute file. */
const fileRule = absFile => `Read(/${absFile})`

/**
 * The narrower denial of a hidden root `h` that contains some of the role's own paths
 * (r3-interactive-2): Claude Code applies deny rules before allow rules (and checks the paths a Bash
 * command reads against them), so a `Read(//h/**)` would also refuse the role its own persisted tool
 * results (`<config>/projects/<slug>/<own session id>/tool-results/…`). Instead, at every directory
 * from `h` down to an own path, every entry that exists now and is not on the way to an own path is
 * denied (a directory, or a link, with everything below it), and transcripts that appear later are
 * denied by a `*.jsonl` pattern at any depth below `h` (the sandbox takes paths only). The role
 * guard, which honours `ownPaths`, stays the authoritative per-session hiding. Returns
 * `{ rules, paths }`.
 */
function carveOut(h, own) {
  const onTheWay = new Map()
  for (const o of own) {
    let dir = h
    for (const name of relative(h, o).split(sep)) {
      if (!onTheWay.has(dir)) onTheWay.set(dir, new Set())
      onTheWay.get(dir).add(name)
      dir = join(dir, name)
    }
  }
  const rules = [h === '/' ? 'Read(//**/*.jsonl)' : `Read(/${h}/**/*.jsonl)`]
  const paths = []
  for (const [dir, keep] of onTheWay) {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // not created yet: only the pattern applies there
    }
    for (const entry of entries) {
      if (keep.has(entry.name)) continue
      const full = join(dir, entry.name)
      paths.push(full)
      if (!entry.isDirectory()) rules.push(fileRule(full))
      if (entry.isDirectory() || entry.isSymbolicLink()) rules.push(absRule('Read', full))
    }
  }
  return { rules, paths }
}

/**
 * The Read deny rules and sandbox denyRead paths of a role's hidden roots: `Read(//h/**)` and `h`
 * for every hidden root, except that a root containing one of `ownPaths` is narrowed (`carveOut`) and
 * a root that IS an own path is not denied at all (r3-interactive-2). Returns `{ rules, paths }`.
 */
export function hiddenDenials(hidden, ownPaths = []) {
  const roots = uniq((hidden ?? []).filter(h => typeof h === 'string' && isAbsolute(h)).map(h => resolve(h)))
  const own = uniq((ownPaths ?? []).filter(o => typeof o === 'string' && isAbsolute(o)).map(o => resolve(o)))
  const rules = []
  const paths = []
  for (const h of roots) {
    const inside = own.filter(o => o === h || strictlyUnder(o, h))
    if (inside.length === 0) {
      rules.push(absRule('Read', h))
      paths.push(h)
    } else if (!inside.includes(h)) {
      const cut = carveOut(h, inside)
      rules.push(...cut.rules)
      paths.push(...cut.paths)
    }
  }
  return { rules: uniq(rules), paths: uniq(paths) }
}

/** The pin file a role context uses (an explicit `spec.pinFile`, else `<logDir>/pin.md` when `pinText` is set). */
export function pinFileFor(spec) {
  if (typeof spec?.pinFile === 'string' && spec.pinFile !== '') return spec.pinFile
  if (typeof spec?.pinText === 'string' && spec.pinText !== '' && typeof spec.logDir === 'string') return join(spec.logDir, 'pin.md')
  return null
}

/** Whether the role's PostToolUse liveness hook is installed (spec.liveness, unless `transport.livenessNotes` is off). */
export function livenessFor(spec) {
  return spec?.liveness === true && spec?.config?.transport?.livenessNotes !== false
}

/**
 * The settings object of one role invocation (SPEC §10.6 "Settings shape"):
 * `permissions` {defaultMode:'dontAsk', allow, deny (+ `Read(//hidden/**)` per hidden root, narrowed
 * around the role's own `ownPaths`: `hiddenDenials`), additionalDirectories}; `hooks` (UserPromptSubmit and PreToolUse always, `onFailure:"block"`;
 * PostToolUse `Bash|Read` only with liveness; SessionStart `compact` only with a pin file);
 * `sandbox` only when `spec.sandbox` is set; then the forwarded `apiKeyHelper`-style keys and
 * provider `env`. The role guard never answers `allow` (F5), so dontAsk plus `allow` decide.
 */
export function buildSettings(spec, { pluginRoot, nodePath = process.execPath, forwarded = {} } = {}) {
  const root = pluginRoot ?? spec?.pluginRoot
  if (typeof root !== 'string' || root === '') throw new TypeError('buildSettings: pluginRoot is required')
  const hidden = hiddenDenials((spec.hidden ?? []).map(h => resolve(h)), spec.ownPaths ?? [])
  const permissions = {
    defaultMode: 'dontAsk',
    allow: uniq(spec.allow ?? []),
    deny: uniq([...(spec.deny ?? []), ...hidden.rules]),
    additionalDirectories: uniq((spec.addDirs ?? []).map(d => resolve(d))),
  }
  const hooks = {
    UserPromptSubmit: [{ hooks: [hookCommand(nodePath, root, 'prompt', { block: true })] }],
    PreToolUse: [{ matcher: '*', hooks: [hookCommand(nodePath, root, 'tool', { block: true })] }],
  }
  if (livenessFor(spec)) hooks.PostToolUse = [{ matcher: 'Bash|Read', hooks: [hookCommand(nodePath, root, 'post', { block: false })] }]
  if (pinFileFor(spec) !== null) hooks.SessionStart = [{ matcher: 'compact', hooks: [hookCommand(nodePath, root, 'pin', { block: false })] }]
  const settings = { permissions, hooks }
  if (spec.sandbox) {
    const sb = spec.sandbox
    settings.sandbox = {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: uniq((sb.allowWrite ?? []).map(p => resolve(p))),
        denyWrite: uniq((sb.denyWrite ?? []).map(p => resolve(p))),
        denyRead: uniq([...(sb.denyRead ?? []).map(p => resolve(p)), ...hidden.paths]),
      },
      network: { allowedDomains: uniq(sb.network ?? []) },
    }
  }
  for (const key of FORWARDED_KEYS) {
    if (forwarded && forwarded[key] !== undefined) settings[key] = forwarded[key]
  }
  if (forwarded && forwarded.env && typeof forwarded.env === 'object' && Object.keys(forwarded.env).length > 0) {
    settings.env = { ...forwarded.env }
  }
  return settings
}

/**
 * Writes `content` to `<dir>/<sha256(content)><ext>` atomically (mode 0600, dir 0700) unless an
 * identical file is already there. Returns the path. Content addressing makes the file usable
 * by concurrent invocations and records exactly what a child ran with.
 */
export async function writeContentAddressed(dir, content, ext) {
  const sha = sha256Hex(content)
  const path = join(dir, `${sha}${ext}`)
  try {
    const existing = await readFile(path)
    if (sha256Hex(existing) === sha) return path
  } catch {
    // Missing (or unreadable): (re)write below.
  }
  await ensureDir(dir)
  await writeFileAtomic(path, content, { mode: 0o600 })
  return path
}

/** `<home>/run/settings/<sha>.json` (content-addressed; SPEC §4.1). */
export async function writeSettings(home, settings) {
  return writeContentAddressed(join(home, 'run', 'settings'), `${JSON.stringify(settings, null, 2)}\n`, '.json')
}

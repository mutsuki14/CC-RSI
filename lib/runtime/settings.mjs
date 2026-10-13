// Per-invocation --settings file for a role child (SPEC §10.6 `settings.mjs`).
//
// Everything that scopes a role lives here rather than in argv (variadic flags would swallow the
// prompt; claude-code-experiments.md f3): permissions with `additionalDirectories` (working dirs
// under --restricted, proposal-fidelity F5), the fail-closed role guard hooks (settings-file hooks
// fire under --restricted, F1), the sandbox block only when the sandbox is in use (keys honoured,
// `failIfUnavailable` exits before any model call, EXP f2), and forwarded auth/provider settings
// (J2-2; --restricted ignores the user settings file).

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
 * `permissions` {defaultMode:'dontAsk', allow, deny (+ `Read(//hidden/**)` per hidden root),
 * additionalDirectories}; `hooks` (UserPromptSubmit and PreToolUse always, `onFailure:"block"`;
 * PostToolUse `Bash|Read` only with liveness; SessionStart `compact` only with a pin file);
 * `sandbox` only when `spec.sandbox` is set; then the forwarded `apiKeyHelper`-style keys and
 * provider `env`. The role guard never answers `allow` (F5), so dontAsk plus `allow` decide.
 */
export function buildSettings(spec, { pluginRoot, nodePath = process.execPath, forwarded = {} } = {}) {
  const root = pluginRoot ?? spec?.pluginRoot
  if (typeof root !== 'string' || root === '') throw new TypeError('buildSettings: pluginRoot is required')
  const hidden = uniq((spec.hidden ?? []).map(h => resolve(h)))
  const permissions = {
    defaultMode: 'dontAsk',
    allow: uniq(spec.allow ?? []),
    deny: uniq([...(spec.deny ?? []), ...hidden.map(h => absRule('Read', h))]),
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
        denyRead: uniq([...(sb.denyRead ?? []).map(p => resolve(p)), ...hidden]),
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

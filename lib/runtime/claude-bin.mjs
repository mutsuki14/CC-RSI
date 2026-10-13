// The `claude` binary role children run (SPEC §10.1).

import { basename } from 'node:path'
import { captureClaude } from './child.mjs'

/** Flags every role invocation relies on; `doctor` and `explore start` refuse when one is missing (SPEC §10.1). */
export const REQUIRED_FLAGS = Object.freeze(['--restricted', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--session-id', '--resume',
  '--append-system-prompt', '--tools', '--settings', '--permission-mode', '--output-format', '--verbose', '--disable-slash-commands',
  '--include-hook-events', '--no-session-persistence'])

/**
 * `config.children.claudeBin` (global-only) || `env.CC_RSI_CLAUDE_BIN` (tests) ||
 * `env.CLAUDE_CODE_EXECPATH` when its basename starts with 'claude' (the parent's own binary, so
 * children run the same version) || 'claude' (PATH lookup).
 */
export function resolveClaudeBin({ config, env = process.env } = {}) {
  const configured = config?.children?.claudeBin
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const forTests = env?.CC_RSI_CLAUDE_BIN
  if (typeof forTests === 'string' && forTests.trim() !== '') return forTests.trim()
  const execPath = env?.CLAUDE_CODE_EXECPATH
  if (typeof execPath === 'string' && execPath !== '' && basename(execPath).startsWith('claude')) return execPath
  return 'claude'
}

const versionCache = new Map()

/** `<bin> --version` → '2.1.296' (first x.y.z in the output), or null on failure. Cached per process and binary. */
export async function claudeVersion(bin) {
  if (versionCache.has(bin)) return versionCache.get(bin)
  const pending = (async () => {
    const r = await captureClaude(bin, ['--version'], { timeoutMs: 15000 })
    if (r.code !== 0) return null
    const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`)
    return m ? m[1] : null
  })()
  versionCache.set(bin, pending)
  const value = await pending
  if (value === null) versionCache.delete(bin) // do not cache failures (the binary may be installed later)
  return value
}

/** REQUIRED_FLAGS absent from `<bin> --help` (all of them when the help text cannot be read). */
export async function missingFlags(bin) {
  const r = await captureClaude(bin, ['--help'], { timeoutMs: 15000 })
  const text = `${r.stdout}\n${r.stderr}`
  if (r.code !== 0 && r.stdout.trim() === '') return [...REQUIRED_FLAGS]
  return REQUIRED_FLAGS.filter(flag => !new RegExp(`(^|[\\s,\\[])${flag.replace(/[-]/g, '\\-')}(?![A-Za-z0-9-])`).test(text))
}

/** Compares dotted versions numerically: <0, 0, >0. Unparseable parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = String(b ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Clears the version cache (tests). */
export function clearClaudeBinCache() {
  versionCache.clear()
}

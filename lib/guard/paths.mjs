// Physical path resolution and file-tool path extraction for the role guard (SPEC §10.6).
//
// Port of dsh-rsi src/host/isolation.ts:54-108 (`physicalPath`, `canonical`, `within`,
// PATH_ARGUMENTS) with Claude Code tool names. Imports only node:* so hooks/role-guard.mjs stays
// fast (SPEC §18 WP4: start < 80 ms).

import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Expands a leading `~` / `~/` with `userHome` (Claude Code file tools accept both spellings). */
function expandTilde(p, userHome) {
  if (!userHome) return p
  if (p === '~') return userHome
  if (p.startsWith('~/')) return join(userHome, p.slice(2))
  return p
}

/**
 * Resolves `p` the way the filesystem does (dsh isolation.ts:54-74): `..` after a symbolic link
 * means the parent of the link's target, so the deepest existing prefix of the unnormalized
 * spelling is realpath'd before the missing tail is re-appended (the tail cannot contain links,
 * since it does not exist). Relative paths are taken against `cwd`. Never throws.
 */
export function physicalPath(p, cwd) {
  const raw = typeof p === 'string' && p.trim() !== '' ? p : '.'
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  const spelled = isAbsolute(raw) ? raw : `${base}${sep}${raw}`
  const segments = spelled.split(sep)
  for (let keep = segments.length; keep > 0; keep--) {
    const prefix = segments.slice(0, keep).join(sep) || sep
    try {
      const real = realpathSync.native(prefix)
      const rest = segments.slice(keep).filter(segment => segment !== '')
      return rest.length === 0 ? real : resolve(real, ...rest)
    } catch {
      // Missing or unreadable: try a shorter prefix.
    }
  }
  return resolve(spelled)
}

/**
 * Whether `child` is `parent` or lies below it, after `path.resolve` of both (dsh `within`,
 * isolation.ts:95-98). A child segment such as `..foo` is correctly treated as inside.
 */
export function isUnder(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || child === '' || parent === '') return false
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

const GLOB_CHARS = /[*?[\]{}]/

/** The literal directory prefix of a glob pattern (segments before the first glob metacharacter). */
function staticPrefix(pattern) {
  const parts = pattern.split('/')
  const out = []
  for (const part of parts) {
    if (GLOB_CHARS.test(part) || part.startsWith('!')) break
    out.push(part)
  }
  if (out.length === parts.length) out.pop() // a pattern without glob chars names a file: keep its directory
  const joined = out.join('/')
  if (joined === '' && pattern.startsWith('/')) return '/'
  return joined
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const FILE_FIELD = { Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path', NotebookRead: 'notebook_path' }
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS'])

/** Whether `toolName` is a file tool the guard inspects (SPEC §10.6 `tool` mode step 2). */
export function isFileTool(toolName) {
  return Object.prototype.hasOwnProperty.call(FILE_FIELD, toolName) || SEARCH_TOOLS.has(toolName)
}

/**
 * The physical paths a file tool call touches (SPEC §10.6). Read/Write/Edit/MultiEdit:
 * `file_path`; NotebookEdit: `notebook_path`; Glob/Grep: `path` (default `cwd`) — and, because
 * a Glob `pattern` (or a Grep `glob`) may itself be absolute or climb with `..`, the literal
 * prefix of the pattern resolved against the search root is reported as a second search root.
 * `invalid` is set when a required path argument is missing (the guard fails closed).
 * Returns `{ paths, search, write, invalid }` (the first three are SPEC §10.6; `invalid` is extra).
 */
export function toolPathArgs(toolName, input, cwd, { userHome } = {}) {
  const args = input && typeof input === 'object' ? input : {}
  const field = FILE_FIELD[toolName]
  if (field !== undefined) {
    const raw = args[field]
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { paths: [], search: false, write: WRITE_TOOLS.has(toolName), invalid: `${toolName} call without a ${field}` }
    }
    return { paths: [physicalPath(expandTilde(raw, userHome), cwd)], search: false, write: WRITE_TOOLS.has(toolName), invalid: null }
  }
  if (SEARCH_TOOLS.has(toolName)) {
    const rawRoot = typeof args.path === 'string' && args.path.trim() !== '' ? expandTilde(args.path, userHome) : '.'
    const root = physicalPath(rawRoot, cwd)
    const paths = [root]
    const pattern = toolName === 'Glob' ? args.pattern : toolName === 'Grep' ? args.glob : undefined
    if (typeof pattern === 'string' && pattern !== '') {
      const prefix = staticPrefix(expandTilde(pattern, userHome))
      if (prefix !== '' && prefix !== '.') {
        const extra = physicalPath(prefix, root)
        if (extra !== root) paths.push(extra)
      }
    }
    return { paths, search: true, write: false, invalid: null }
  }
  return { paths: [], search: false, write: false, invalid: null }
}

/**
 * The first hidden root that lies at or below `searchRoot`, or null. A search starting above a
 * hidden root would enumerate it (dsh isolation.ts:136: `searches && within(root, target)`).
 */
export function searchCoversHidden(searchRoot, hidden) {
  for (const root of hidden ?? []) {
    if (typeof root === 'string' && root !== '' && isUnder(root, searchRoot)) return root
  }
  return null
}

/** Physical form of a configured root (deepest existing ancestor realpath'd, dsh `canonical`). */
export function canonicalRoot(root) {
  return physicalPath(resolve(root), '/')
}

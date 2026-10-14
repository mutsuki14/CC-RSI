// Role policy for hooks/role-guard.mjs (SPEC §10.6 `policy.mjs`).
//
// The guard runs in a separate process per hook event and imports only lib/core and lib/guard
// (SPEC §3), so everything it needs is precomputed here into one content-addressed JSON file whose
// path reaches the guard as CC_RSI_POLICY.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalJson } from '../core/digest.mjs'
import { repeatWarning } from '../prompts/roles.mjs'
import { MUTATION_BASH_DENY } from '../guard/bash.mjs'
import { livenessFor, pinFileFor, writeContentAddressed } from './settings.mjs'

export { MUTATION_BASH_DENY }

function uniqPaths(list) {
  const out = []
  const seen = new Set()
  for (const p of list ?? []) {
    if (typeof p !== 'string' || p === '') continue
    const r = resolve(p)
    if (seen.has(r)) continue
    seen.add(r)
    out.push(r)
  }
  return out
}

function uniqStrings(list) {
  return [...new Set((list ?? []).filter(s => typeof s === 'string' && s !== ''))]
}

/** `bashDeny` entries as `{source, flags, reason}` (RegExps are converted; invalid entries throw). */
function normalizeBashDeny(list) {
  const out = []
  for (const entry of list ?? []) {
    if (entry instanceof RegExp) out.push({ source: entry.source, flags: entry.flags.replace(/[gy]/g, ''), reason: `cc-rsi: refused by the role policy (${entry.source})` })
    else if (entry && typeof entry.source === 'string') {
      new RegExp(entry.source, entry.flags ?? '') // validate now: a bad pattern is a caller bug
      out.push({ source: entry.source, flags: typeof entry.flags === 'string' ? entry.flags.replace(/[gy]/g, '') : '', reason: typeof entry.reason === 'string' ? entry.reason : `cc-rsi: refused by the role policy (${entry.source})` })
    } else throw new TypeError(`buildPolicy: invalid bashDeny entry ${JSON.stringify(entry)}`)
  }
  return out
}

/** The Verifier scratch directory of a spec: `spec.scratch`, else `extraEnv.VERIFIER_SCRATCH`, else null. */
export function scratchOf(spec) {
  if (typeof spec?.scratch === 'string' && spec.scratch !== '') return resolve(spec.scratch)
  const fromEnv = spec?.extraEnv?.VERIFIER_SCRATCH
  return typeof fromEnv === 'string' && fromEnv !== '' ? resolve(fromEnv) : null
}

/**
 * Policy = {v:1, role, ctxKey, tools, cwd, home, userHome, readRoots, writeRoots, readOnlyRoots, hidden,
 * hiddenTokens, allowedPaths:[cwd, ...addDirs, scratch, ...ownPaths], bashDeny:[{source, flags, reason}], recursionGuard:true,
 * foreignMessageGuard, liveness, pinFile, stagnationRevisit, repeatWarning} (SPEC §10.6; `repeatWarning` is
 * added so the guard can print RSIAgent's REPEAT note without importing lib/prompts).
 * `readRoots` defaults to the role's own directories (cwd, addDirs, scratch); `--restricted` confines
 * file tools to the same set (F5).
 */
export function buildPolicy(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('buildPolicy: spec is required')
  if (typeof spec.cwd !== 'string' || !spec.cwd.startsWith('/')) throw new TypeError('buildPolicy: spec.cwd must be absolute')
  const cwd = resolve(spec.cwd)
  const addDirs = uniqPaths(spec.addDirs)
  const scratch = scratchOf(spec)
  // `ownPaths`: further directories of the role's own that lie under a hidden root (its Claude Code
  // session dir with persisted tool results, r2-interactive-5): readable and exempt from hiding, but
  // never added as working dirs and never used to drop a hidden root.
  const ownPaths = uniqPaths(spec.ownPaths)
  const own = uniqPaths([cwd, ...addDirs, ...(scratch ? [scratch] : []), ...ownPaths])
  const readRoots = Array.isArray(spec.readRoots) && spec.readRoots.length > 0 ? uniqPaths([...spec.readRoots, ...ownPaths]) : own
  const liveness = livenessFor(spec)
  return {
    v: 1,
    role: String(spec.role ?? ''),
    ctxKey: String(spec.key ?? ''),
    tools: uniqStrings(spec.tools),
    cwd,
    home: typeof spec.home === 'string' ? resolve(spec.home) : null,
    userHome: typeof spec.userHome === 'string' && spec.userHome !== '' ? resolve(spec.userHome) : resolve(process.env.HOME || homedir()),
    readRoots,
    writeRoots: uniqPaths(spec.writeRoots),
    readOnlyRoots: uniqPaths(spec.readOnlyRoots),
    hidden: uniqPaths(spec.hidden),
    hiddenTokens: uniqStrings(spec.hiddenTokens),
    allowedPaths: own,
    bashDeny: normalizeBashDeny(spec.bashDeny),
    recursionGuard: true,
    foreignMessageGuard: spec?.config?.isolation?.foreignMessageGuard !== false,
    liveness,
    pinFile: pinFileFor(spec),
    stagnationRevisit: typeof spec.stagnationRevisit === 'string' && spec.stagnationRevisit !== '' ? spec.stagnationRevisit : null,
    repeatWarning: liveness ? repeatWarning() : null,
  }
}

/** `<home>/run/policies/<sha>.json` (content-addressed; SPEC §4.1). Returns the path. */
export async function writePolicy(home, policy) {
  return writeContentAddressed(join(home, 'run', 'policies'), `${canonicalJson(policy)}\n`, '.json')
}

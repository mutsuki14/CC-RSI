// Memory inventory listing (SPEC §6.7): names and sizes only, never file bodies, and no
// privileged index file (RSIAgent explore/charter.py:10-36 `memory_preamble`; dsh-rsi
// src/roles/actor.ts:9-24 `formatInventory`/`memoryPreamble`).

import { compareUtf8 } from '../core/digest.mjs'

/**
 * Formats `[{path, bytes}]` as `'  <bytes>  <path>'` lines sorted by UTF-8 bytes, at most
 * `limit` lines. Names containing '{' or '}' are never listed (dsh actor.ts:21: a host that
 * interpolates prompt text must never see a template variable in an Actor-authored name).
 * When anything is not listed, a final `… N more files` line is added.
 * Returns `{ lines, omitted }` (`omitted` counts brace names and truncated entries).
 */
export function formatInventory(files, limit = 40) {
  const all = Array.isArray(files) ? files : []
  const safe = all
    .filter(entry => entry && typeof entry.path === 'string' && !/[{}]/.test(entry.path))
    .sort((a, b) => compareUtf8(a.path, b.path))
  const max = Number.isInteger(limit) && limit >= 0 ? limit : 40
  const listed = safe.slice(0, max)
  const omitted = all.length - listed.length
  const lines = listed.map(entry => `  ${entry.bytes}  ${entry.path}`)
  if (omitted > 0) lines.push(`… ${omitted} more files`)
  return { lines, omitted }
}

// Safe memory paths (SPEC §6.7): a port of dsh-rsi src/memory/paths.ts:1-18
// (`safeRelativePath`). Memory never escapes its root: no absolute paths, parent segments,
// drive letters, NUL bytes, or empty names.

import { posix } from 'node:path'
import { UnsafeMemoryPathError } from './errors.mjs'

/** Maximum normalized length (dsh paths.ts:15). */
export const MAX_MEMORY_PATH = 240

/**
 * Normalizes a model-supplied memory path to a safe POSIX relative path, or throws
 * UnsafeMemoryPathError: trims, maps '\\' to '/', rejects '', NUL, absolute paths, drive
 * letters and '..' segments, collapses '.' and empty segments, and caps the result at 240 chars.
 */
export function safeRelativePath(p) {
  if (typeof p !== 'string') throw new UnsafeMemoryPathError({ path: String(p), reason: 'not a string' })
  const raw = p.trim().replace(/\\/g, '/')
  if (raw === '' || raw.includes('\0')) throw new UnsafeMemoryPathError({ path: p, reason: 'memory path must be a non-empty relative path' })
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new UnsafeMemoryPathError({ path: p, reason: 'memory path must be relative' })
  const segments = raw.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0) throw new UnsafeMemoryPathError({ path: p, reason: 'memory path must name a file' })
  if (segments.includes('..')) throw new UnsafeMemoryPathError({ path: p, reason: 'memory path must not contain ".."' })
  const normalized = posix.join(...segments)
  if (normalized.length > MAX_MEMORY_PATH) throw new UnsafeMemoryPathError({ path: p, reason: `memory path is too long (max ${MAX_MEMORY_PATH} characters)` })
  return normalized
}

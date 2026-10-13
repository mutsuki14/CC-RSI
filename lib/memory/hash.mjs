// Memory tree digests, byte-compatible with RSIAgent (SPEC §6.1; analysis/memory-learning.md §6).
//
// treeSha256 ports RSIAgent explore/memory_hash.py:19-53 (`_canonical_bytes`,
// `canonical_sha256`, `tree_sha256`): sha256 of
// json.dumps(sorted {relpath: sha256hex}, sort_keys=True, separators=(",", ":"),
// ensure_ascii=False, allow_nan=False).encode("utf-8").
// Keys sort by UTF-8 bytes (= Python code-point order), never JS UTF-16 order: dsh-rsi
// src/memory/hash.ts:16 sorted with `a < b`, which diverges for astral vs U+E000-U+FFFF keys.
//
// manifestSha256 ports the other RSIAgent digest, `memory_manifest_sha256`
// (explore/practice_loop.py:1250-1254, explore/task.py:128-129): json.dumps(manifest,
// sort_keys=True, separators=(",", ":")) with the default ensure_ascii=True.

import { canonicalJson as coreCanonicalJson, sha256Hex, sortUtf8 } from '../core/digest.mjs'
import { MemoryStateError } from './errors.mjs'

export { MemoryStateError }

/** tree_sha256({}) = sha256('{}'). */
export const EMPTY_TREE_SHA256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'

const SHA256_RE = /^[0-9a-f]{64}$/
/** An unpaired UTF-16 surrogate: Python cannot encode it as UTF-8 (UnicodeEncodeError). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Whether `text` is well-formed UTF-16 (encodable as UTF-8 without replacement). */
export function isWellFormedUnicode(text) {
  return !LONE_SURROGATE.test(text)
}

/**
 * Python `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
 * allow_nan=False)`: keys sorted by UTF-8 bytes, JSON.stringify string escaping.
 * Throws MemoryStateError for data that is not canonical JSON (NaN, Infinity, BigInt, cycles).
 */
export function canonicalJson(value) {
  try {
    return coreCanonicalJson(value)
  } catch (error) {
    throw new MemoryStateError(error?.message ?? 'state is not canonical JSON data')
  }
}

/** Escapes every UTF-16 code unit outside U+0020..U+007E that JSON.stringify left raw (Python ensure_ascii=True). */
function asciiEscape(json) {
  // JSON.stringify already escaped '"', '\\' and U+0000..U+001F exactly as Python does; what remains
  // non-ASCII (and U+007F) becomes \uXXXX with lowercase hex; astral characters become surrogate pairs.
  return json.replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Python `json.dumps(value, sort_keys=True, separators=(",", ":"))` (ensure_ascii=True). */
export function asciiCanonicalJson(value) {
  return asciiEscape(canonicalJson(value))
}

/**
 * RSIAgent `tree_sha256(hashes)`: validates every entry (key non-empty, no leading '/', no '..'
 * segment, well-formed Unicode; value 64 lowercase hex) and hashes the canonical JSON of the
 * sorted mapping. Throws MemoryStateError('invalid tree-hash mapping') otherwise.
 */
export function treeSha256(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new MemoryStateError('invalid tree-hash mapping')
  const normalized = {}
  for (const rel of sortUtf8(Object.keys(map))) {
    const digest = map[rel]
    if (
      rel === ''
      || rel.startsWith('/')
      || rel.split('/').includes('..')
      || !isWellFormedUnicode(rel)
      || typeof digest !== 'string'
      || !SHA256_RE.test(digest)
    ) {
      throw new MemoryStateError('invalid tree-hash mapping', { path: rel })
    }
    normalized[rel] = digest
  }
  return sha256Hex(Buffer.from(canonicalJson(normalized), 'utf8'))
}

/** tree_sha256 of a manifest `{rel: {bytes, sha256}}` (RSIAgent `tree_sha256({k: v["sha256"]})`). */
export function treeSha256FromManifest(manifest) {
  const hashes = {}
  for (const [rel, entry] of Object.entries(manifest ?? {})) hashes[rel] = entry?.sha256
  return treeSha256(hashes)
}

/**
 * RSIAgent `memory_manifest_sha256`: sha256 of json.dumps(manifest, sort_keys=True,
 * separators=(",", ":")) with ensure_ascii=True, so non-ASCII names appear as lowercase
 * \uXXXX escapes (astral characters as surrogate pairs). Equals treeSha256 only for `{}`.
 */
export function manifestSha256(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new MemoryStateError('state is not canonical JSON data: a manifest must be an object')
  }
  return sha256Hex(Buffer.from(asciiCanonicalJson(manifest), 'utf8'))
}

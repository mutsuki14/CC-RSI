// sha256 helpers and canonical JSON (SPEC §5.3; §0 "Hashes are lowercase hex sha256").
//
// `canonicalJson` lives here (not only in lib/memory/hash.mjs) because lib/core may import
// only node:* (SPEC §3 import boundaries) and `configSha` needs it. lib/memory/hash.mjs
// wraps it with RSIAgent's MemoryStateError semantics.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { CcRsiError } from './errors.mjs'

/** Lowercase hex sha256 of a string (UTF-8) or a Buffer/Uint8Array. */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Lowercase hex sha256 of a file's bytes (streamed). Rejects with the fs error (e.g. ENOENT). */
export async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

/** Orders strings by their UTF-8 bytes, which equals Python's code-point `str` ordering. */
export function compareUtf8(a, b) {
  if (a === b) return 0
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Sorts a copy of `strings` by UTF-8 bytes (never the JS default UTF-16 order). */
export function sortUtf8(strings) {
  return [...strings].sort(compareUtf8)
}

/**
 * Canonical JSON, equal to Python
 * `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)`
 * (RSIAgent explore/memory_hash.py:19-30) for JSON data: object keys sorted by UTF-8 bytes,
 * no insignificant whitespace, JSON.stringify string escaping (which matches ensure_ascii=False),
 * and NaN/Infinity refused. Like JSON.stringify, `toJSON` is honoured, undefined/function/symbol
 * members are skipped in objects and become null in arrays.
 *
 * Non-integral numbers use JavaScript's shortest round-trip form, which can differ from Python's
 * `repr` for exponents (1e-7 vs 1e-07); every hash input cc-rsi produces uses integers and strings.
 *
 * Throws CcRsiError('json_not_canonical') for NaN, ±Infinity, BigInt and cycles.
 */
export function canonicalJson(value) {
  const stack = new Set()
  const render = (input, inArray) => {
    let v = input
    if (v !== null && (typeof v === 'object' || typeof v === 'bigint') && typeof v.toJSON === 'function') v = v.toJSON()
    if (v === null) return 'null'
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v)
      case 'boolean':
        return v ? 'true' : 'false'
      case 'number':
        if (!Number.isFinite(v)) throw new CcRsiError('json_not_canonical', `state is not canonical JSON data: ${v} is not allowed`)
        return JSON.stringify(v)
      case 'bigint':
        throw new CcRsiError('json_not_canonical', 'state is not canonical JSON data: BigInt is not serializable')
      case 'undefined':
      case 'function':
      case 'symbol':
        return inArray ? 'null' : undefined
      default:
        break
    }
    if (stack.has(v)) throw new CcRsiError('json_not_canonical', 'state is not canonical JSON data: circular reference')
    stack.add(v)
    try {
      if (Array.isArray(v)) return `[${v.map(item => render(item, true)).join(',')}]`
      const parts = []
      for (const key of sortUtf8(Object.keys(v))) {
        const rendered = render(v[key], false)
        if (rendered !== undefined) parts.push(`${JSON.stringify(key)}:${rendered}`)
      }
      return `{${parts.join(',')}}`
    } finally {
      stack.delete(v)
    }
  }
  const out = render(value, false)
  if (out === undefined) throw new CcRsiError('json_not_canonical', `state is not canonical JSON data: ${typeof value}`)
  return out
}

/** sha256 of the UTF-8 bytes of `canonicalJson(value)` (RSIAgent `canonical_sha256`). */
export function canonicalSha256(value) {
  return sha256Hex(canonicalJson(value))
}

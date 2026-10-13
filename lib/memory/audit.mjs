// Leakage tripwire (SPEC §6.7): a port of dsh-rsi src/memory/audit.ts:1-45, which ports
// RSIAgent's silent audit (explore/commit.py:157-169 `_shingles`, :227-268 `audit_memory`):
// memory must not carry verbatim fragments of material the deployment marks as sealed (held-out
// task texts, grader sources). Word shingles are compared; any overlap quarantines the whole
// candidate. The reason never reaches an agent.
//
// Word splitting follows dsh (`[^\p{L}\p{N}]+`, Unicode-aware) rather than RSIAgent's ASCII
// `[a-z0-9]+`, so non-English sealed texts are covered too.

import { readFile } from 'node:fs/promises'
import { CcRsiError } from '../core/errors.mjs'

/** Lowercased word tokens (dsh audit.ts:7-9). */
export function words(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function clampN(n) {
  const value = Number.isInteger(n) ? n : 8
  return Math.max(3, value)
}

function shingles(text, n) {
  const tokens = words(text)
  const out = new Set()
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '))
  return out
}

/** The n-word shingles (joined by ' ') of every text; n is clamped to ≥ 3 (RSIAgent _N = 8). */
export function buildCorpus(texts, n = 8) {
  const size = clampN(n)
  const corpus = new Set()
  for (const text of texts ?? []) for (const shingle of shingles(text, size)) corpus.add(shingle)
  return corpus
}

/** Whether `text` shares any n-word shingle with `corpus`. */
export function hits(corpus, text, n = 8) {
  if (!corpus || corpus.size === 0) return false
  const size = clampN(n)
  const tokens = words(text)
  for (let i = 0; i + size <= tokens.length; i++) {
    if (corpus.has(tokens.slice(i, i + size).join(' '))) return true
  }
  return false
}

/**
 * Builds the sealed corpus from files (configured `audit.sealedTextFiles`). Returns null when
 * no files are configured or they yield no shingle. An unreadable configured file throws
 * CcRsiError('sealed_corpus_unreadable'): the audit fails closed, like RSIAgent's
 * `require_corpus=True`, instead of silently disabling the tripwire.
 */
export async function loadSealedCorpus(files, n = 8) {
  if (!Array.isArray(files) || files.length === 0) return null
  const texts = []
  for (const file of files) {
    try {
      texts.push(await readFile(file, 'utf8'))
    } catch (error) {
      throw new CcRsiError('sealed_corpus_unreadable', `audit.sealedTextFiles: cannot read ${file}: ${error?.code ?? error?.message}`, { file })
    }
  }
  const corpus = buildCorpus(texts, n)
  return corpus.size === 0 ? null : corpus
}

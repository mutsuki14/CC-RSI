// Shingle audit (SPEC §6.7; dsh-rsi src/memory/audit.ts, RSIAgent commit.py:157-169).

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CcRsiError } from '../../lib/core/errors.mjs'
import { buildCorpus, hits, loadSealedCorpus, words } from '../../lib/memory/audit.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const SEALED = 'the held out task asks for exactly seven red widgets on the second sheet'

describe('audit', () => {
  it('splits words on non-letters/digits, lowercased, Unicode-aware', () => {
    assert.deepEqual(words('Hello, World! 42x  科学-notes'), ['hello', 'world', '42x', '科学', 'notes'])
    assert.deepEqual(words(''), [])
  })

  it('builds n-word shingles (n clamped to at least 3)', () => {
    assert.deepEqual([...buildCorpus(['a b c d'], 3)], ['a b c', 'b c d'])
    assert.deepEqual([...buildCorpus(['a b c d'], 1)], ['a b c', 'b c d'])
    assert.equal(buildCorpus(['too short'], 8).size, 0)
  })

  it('detects an 8-word overlap regardless of case and punctuation (dsh quarantine case)', () => {
    const corpus = buildCorpus([SEALED], 8)
    assert.equal(hits(corpus, 'Remember: the held out task asks for exactly seven red widgets!', 8), true)
    assert.equal(hits(corpus, 'the held out task asks for exactly six red widgets', 8), false)
    assert.equal(hits(new Set(), 'anything at all', 8), false)
    assert.equal(hits(null, 'anything', 8), false)
  })

  it('loadSealedCorpus: null without files or shingles; unreadable files fail closed', async () => {
    const dir = await tmpDir()
    assert.equal(await loadSealedCorpus([], 8), null)
    assert.equal(await loadSealedCorpus(undefined, 8), null)
    await writeFile(join(dir, 'short.txt'), 'two words')
    assert.equal(await loadSealedCorpus([join(dir, 'short.txt')], 8), null)
    await writeFile(join(dir, 'task.txt'), SEALED)
    const corpus = await loadSealedCorpus([join(dir, 'task.txt'), join(dir, 'short.txt')], 8)
    assert.equal(corpus.size, 7)
    await assert.rejects(loadSealedCorpus([join(dir, 'missing.txt')], 8), err => err instanceof CcRsiError && err.code === 'sealed_corpus_unreadable')
  })
})

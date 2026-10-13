// SPEC §6.1 vectors (computed with RSIAgent explore/memory_hash.py; see
// analysis/memory-learning.md §6.3) and the dsh vector (dsh-rsi test/memory.test.ts:13-18).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sha256Hex } from '../../lib/core/digest.mjs'
import {
  EMPTY_TREE_SHA256, MemoryStateError, asciiCanonicalJson, canonicalJson, manifestSha256, treeSha256, treeSha256FromManifest,
} from '../../lib/memory/hash.mjs'
import { MemoryError } from '../../lib/memory/errors.mjs'
import { CcRsiError } from '../../lib/core/errors.mjs'

const hashesOf = files => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256Hex(Buffer.from(v, 'utf8'))]))
const manifestOf = files => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { bytes: Buffer.byteLength(v), sha256: sha256Hex(Buffer.from(v, 'utf8')) }]))

const UNICODE = { '！.md': 'x', '\u{1F600}.md': 'y', 'Z.md': 'z', 'a.md': 'w', 'é.md': 'e' }

describe('treeSha256 (RSIAgent tree_sha256, byte for byte)', () => {
  it('empty tree', () => {
    assert.equal(EMPTY_TREE_SHA256, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
    assert.equal(treeSha256({}), EMPTY_TREE_SHA256)
    assert.equal(sha256Hex('{}'), EMPTY_TREE_SHA256)
  })

  it('one file', () => {
    assert.equal(treeSha256(hashesOf({ 'a.md': 'hello\n' })), 'baf97b40a6e87d94d244e1d0a69c822e5005af35e6c14630d1d63728a436cfd8')
    assert.equal(canonicalJson(hashesOf({ 'a.md': 'hello\n' })), '{"a.md":"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"}')
  })

  it('the 4-file tree', () => {
    const files = {
      'procedures/x.md': 'step 1\n',
      'INDEX.md': '# index\n',
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
      'lessons/fail-01.md': "FAIL: don't\n",
    }
    const hashes = hashesOf(files)
    assert.equal(hashes['INDEX.md'], '359e0c96faeb829366c9724b68a85a032096a7a690bb8503451da83bb75afe58')
    assert.equal(hashes['lessons/fail-01.md'], '7064b0db452c17a9de07136338e03b4ad6898647cb35c1e45d28d405d0927cd4')
    assert.equal(hashes['procedures/x.md'], 'b7126ac71c7f87a2146297b1bd0f53a934b2a189fd3d2995e1ff1358715560c4')
    assert.equal(hashes['scripts/run.sh'], '299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba')
    assert.equal(treeSha256(hashes), '6d2d3f9653a4aae670941251bfca459f9e775c75a6ee14e7e1a7aa89d6d68a1e')
  })

  it('sorts keys by UTF-8 bytes (code points), never the JS default UTF-16 order', () => {
    const hashes = hashesOf(UNICODE)
    const digest = treeSha256(hashes)
    assert.equal(digest, '20b3f2cc25d1e9dc7b864f7de5ac9c69b167c0fabb801f8b4d868e8c0cca746f')
    // What a JS default .sort() would produce: MUST NOT be produced.
    const wrongKeys = Object.keys(hashes).sort()
    const wrong = sha256Hex(`{${wrongKeys.map(k => `${JSON.stringify(k)}:${JSON.stringify(hashes[k])}`).join(',')}}`)
    assert.equal(wrong.slice(0, 8), 'f4d20f37')
    assert.notEqual(digest, wrong)
    // Insertion order never matters.
    const reversed = Object.fromEntries(Object.entries(hashes).reverse())
    assert.equal(treeSha256(reversed), digest)
    assert.ok(canonicalJson(hashes).indexOf('"Z.md"') < canonicalJson(hashes).indexOf('"a.md"'))
    assert.ok(canonicalJson(hashes).indexOf('"！.md"') < canonicalJson(hashes).indexOf('"\u{1F600}.md"'))
  })

  it('the .hidden / B-x.md / B.md / B/c.md / B/sub/d.md tree', () => {
    const hashes = hashesOf({ '.hidden': 'h', 'B.md': '1', 'B/c.md': '2', 'B-x.md': '3', 'B/sub/d.md': '4' })
    assert.equal(treeSha256(hashes), '61d58dd6fdff98dd37bbae563d3b8322b25de998ab12b7be66a59a6e06efaf75')
  })

  it('the dsh vector', () => {
    assert.equal(
      treeSha256({ 'b/lesson.md': sha256Hex('fail fast'), 'a.md': sha256Hex('科学 notes') }),
      'c9cedc356c2e9259636f2e7a9b8ce36819a10fbf2e8e889fd1a011dbf9386a9e',
    )
  })

  it('escapes like Python ensure_ascii=False (control chars, quotes, DEL, U+2028 raw)', () => {
    const files = { 'a"b.md': '1', 'back\\slash.md': '2', 'ctl\u0001.md': '3', 'del\u007f.md': '4', 'nl\n.md': '5', 'tab\t.md': '6', 'ls\u2028.md': '7' }
    assert.equal(treeSha256(hashesOf(files)), 'c80a007ee2fefe02aa12b6921f43e869a2978dac731b08ec933173582737fea2')
    const pua = { '\uE000.md': 'p', '\uFFFD.md': 'r', '\u{1D11E}.md': 'g', '\u{10FFFF}x': 'm' }
    assert.equal(treeSha256(hashesOf(pua)), 'f955ce2cecb121b7028d6b2cc2c60bf685ddbacf4240d259cc9cce64a600c51b')
  })

  it('rejects invalid entries with MemoryStateError', () => {
    const good = sha256Hex('')
    for (const bad of [{ '': good }, { '/abs': good }, { '../x': good }, { 'a/../b': good }, { 'a/..': good }, { a: 'nothex' },
      { a: good.toUpperCase() }, { a: `${good}\n` }, { a: 42 }, { 'x\uD800': good }]) {
      assert.throws(() => treeSha256(bad), err => err instanceof MemoryStateError && err instanceof MemoryError && err instanceof CcRsiError)
    }
    assert.throws(() => treeSha256(null), MemoryStateError)
    assert.throws(() => treeSha256([]), MemoryStateError)
    // '..' as part of a name is fine; RSIAgent only rejects a '..' path part.
    assert.match(treeSha256({ 'a..b': good, '...': good }), /^[0-9a-f]{64}$/)
  })

  it('treeSha256FromManifest uses the sha256 fields', () => {
    assert.equal(treeSha256FromManifest(manifestOf(UNICODE)), '20b3f2cc25d1e9dc7b864f7de5ac9c69b167c0fabb801f8b4d868e8c0cca746f')
    assert.equal(treeSha256FromManifest({}), EMPTY_TREE_SHA256)
  })
})

describe('canonicalJson', () => {
  it('sorts nested keys, uses compact separators and refuses NaN/Infinity', () => {
    assert.equal(canonicalJson({ b: [1, { d: 1, c: null }], a: 'x', e: true }), '{"a":"x","b":[1,{"c":null,"d":1}],"e":true}')
    assert.throws(() => canonicalJson({ a: Number.NaN }), MemoryStateError)
    assert.throws(() => canonicalJson([Number.POSITIVE_INFINITY]), MemoryStateError)
    assert.throws(() => canonicalJson({ a: 1n }), MemoryStateError)
    const cyclic = {}
    cyclic.self = cyclic
    assert.throws(() => canonicalJson(cyclic), MemoryStateError)
    // JSON.stringify conventions for non-JSON members.
    assert.equal(canonicalJson({ a: undefined, b: () => 1, c: [undefined] }), '{"c":[null]}')
    assert.equal(canonicalJson('é\u{1F600}'), '"é\u{1F600}"')
  })
})

describe('manifestSha256 (RSIAgent memory_manifest_sha256, ensure_ascii=True)', () => {
  it('equals the empty tree hash only for {}', () => {
    assert.equal(manifestSha256({}), EMPTY_TREE_SHA256)
  })

  it('ASCII names', () => {
    assert.equal(manifestSha256(manifestOf({ 'a.md': 'hello\n' })), '630cb5110f064e92066eefa0e26546078822acf62ed277e478e8c8dbf7e1e133')
    assert.equal(asciiCanonicalJson({ 'a.md': { sha256: 'x', bytes: 6 } }), '{"a.md":{"bytes":6,"sha256":"x"}}')
  })

  it('non-ASCII names become lowercase \\uXXXX escapes', () => {
    assert.equal(manifestSha256(manifestOf({ 'b/lesson.md': 'fail fast', 'a.md': '科学 notes' })),
      '1fffce5b7a4b718f224401d75d840d9d38853fe6bf091e068d5ff1083202d889')
    assert.equal(asciiCanonicalJson({ 'é\u007f': 1 }), '{"\\u00e9\\u007f":1}')
  })

  it('astral names become surrogate pairs', () => {
    assert.equal(manifestSha256(manifestOf(UNICODE)), '5b31bab1c864ba89d5908ee043a43233028b722f11532153b4add1bac636445c')
    assert.equal(asciiCanonicalJson({ '\u{1F600}': 1 }), '{"\\ud83d\\ude00":1}')
    const files = { 'a"b.md': '1', 'back\\slash.md': '2', 'ctl\u0001.md': '3', 'del\u007f.md': '4', 'nl\n.md': '5', 'tab\t.md': '6', 'ls\u2028.md': '7' }
    assert.equal(manifestSha256(manifestOf(files)), '8b3c48fe5d3aac4ab76469f3bdc72eddfb8cfaee013638135e1ea7794ea99d97')
    const pua = { '\uE000.md': 'p', '\uFFFD.md': 'r', '\u{1D11E}.md': 'g', '\u{10FFFF}x': 'm' }
    assert.equal(manifestSha256(manifestOf(pua)), 'ad2b325605aa882cd31fe6446172a0a7cc82068504498cfe77aa33f03e94b0b0')
  })

  it('refuses non-objects', () => {
    assert.throws(() => manifestSha256(null), MemoryStateError)
    assert.throws(() => manifestSha256([]), MemoryStateError)
  })
})

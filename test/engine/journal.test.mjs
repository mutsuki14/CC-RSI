// OpJournal (SPEC §12.1, §15.3 WP6 journal row): replay returns recorded results, divergence
// throws, recovering flag, overrides, nested ops, blobs, concurrent prefixes, events, torn tails.

import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BLOB_THRESHOLD, OpJournal, parseFault, ReplayDivergence } from '../../lib/engine/journal.mjs'
import { InfraError } from '../../lib/runtime/errors.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

function records(dir) {
  return readFileSync(join(dir, 'ops.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

describe('OpJournal', () => {
  it('runs an op once and replays its recorded result after reopening', async () => {
    const dir = await tmpDir()
    let calls = 0
    const j1 = await OpJournal.open(dir)
    const first = await j1.op('a/b', 'work', { x: 1 }, () => {
      calls++
      return { value: 42, list: [1, 'two'], missing: undefined }
    })
    assert.deepEqual(first, { value: 42, list: [1, 'two'] })
    assert.equal(j1.isDone('a/b'), true)
    const j2 = await OpJournal.open(dir)
    const again = await j2.op('a/b', 'work', { x: 1 }, () => {
      calls++
      return { value: 0 }
    })
    assert.deepEqual(again, first)
    assert.equal(calls, 1)
    assert.deepEqual(j2.result('a/b'), first)
    const recs = records(dir)
    assert.deepEqual(recs.map(r => [r.seq, r.key, r.status]), [[1, 'a/b', 'start'], [2, 'a/b', 'done']])
    assert.match(recs[0].argsSha, /^[0-9a-f]{64}$/)
  })

  it('throws ReplayDivergence when a recorded op is replayed with another kind or other arguments', async () => {
    const dir = await tmpDir()
    const j = await OpJournal.open(dir)
    await j.op('k', 'send', { msgSha: 'aa' }, () => 1)
    await assert.rejects(j.op('k', 'send', { msgSha: 'bb' }, () => 2), error => error instanceof ReplayDivergence && error.cls === 'replay_divergence' && error instanceof InfraError)
    await assert.rejects(j.op('k', 'parse', { msgSha: 'aa' }, () => 2), ReplayDivergence)
    // Argument key order does not matter (canonical JSON).
    await j.op('k2', 'x', { b: 1, a: 2 }, () => 'v')
    assert.equal(await j.op('k2', 'x', { a: 2, b: 1 }, () => 'other'), 'v')
  })

  it('re-runs a started op in recovering mode and records nothing for a throwing fn', async () => {
    const dir = await tmpDir()
    const j1 = await OpJournal.open(dir)
    await assert.rejects(j1.op('s', 'effect', {}, () => { throw new Error('crash inside') }), /crash inside/)
    assert.equal(j1.isDone('s'), false)
    assert.equal(j1.hasStart('s'), true)
    const j2 = await OpJournal.open(dir)
    let seen = null
    const out = await j2.op('s', 'effect', {}, ctx => {
      seen = ctx
      return 'ok'
    })
    assert.equal(out, 'ok')
    assert.deepEqual(seen, { recovering: true, key: 's' })
    // Only one start record was written for the key.
    assert.equal(records(dir).filter(r => r.key === 's' && r.status === 'start').length, 1)
  })

  it('attaches the op key to an InfraError thrown inside an op', async () => {
    const dir = await tmpDir()
    const j = await OpJournal.open(dir)
    await assert.rejects(j.op('w001/b:x/a1/work/m1', 'send', {}, () => { throw new InfraError('crash', 'child died') }), error => error.extra.opKey === 'w001/b:x/a1/work/m1')
    const inner = new InfraError('timeout', 'slow', { opKey: 'inner/key' })
    await assert.rejects(j.op('outer', 'send', {}, () => { throw inner }), error => error.extra.opKey === 'inner/key')
  })

  it('records overrides durably and idempotently', async () => {
    const dir = await tmpDir()
    const j1 = await OpJournal.open(dir)
    assert.equal(j1.hasOverride('w001/cur/liveness@4'), false)
    await j1.addOverride('w001/cur/liveness@4', { by: 'cli' })
    await j1.addOverride('w001/cur/liveness@4', { by: 'cli' })
    const j2 = await OpJournal.open(dir)
    assert.equal(j2.hasOverride('w001/cur/liveness@4'), true)
    assert.equal(records(dir).filter(r => r.status === 'override').length, 1)
    assert.equal(records(dir)[0].kind, 'override')
  })

  it('supports nested ops; a replayed outer op never re-runs its inner ops', async () => {
    const dir = await tmpDir()
    const j1 = await OpJournal.open(dir)
    let inner = 0
    const outer = () => j1.op('outer', 'o', {}, async () => {
      const v = await j1.op('outer/inner', 'i', {}, () => {
        inner++
        return 5
      })
      return v * 2
    })
    assert.equal(await outer(), 10)
    const j2 = await OpJournal.open(dir)
    assert.equal(await j2.op('outer', 'o', {}, () => { throw new Error('must not run') }), 10)
    assert.equal(inner, 1)
    assert.deepEqual(j2.keysWithPrefix('outer'), ['outer', 'outer/inner'])
  })

  it('stores large results as content-addressed blobs and detects an altered blob', async () => {
    const dir = await tmpDir()
    const big = { text: 'x'.repeat(BLOB_THRESHOLD + 10) }
    const j1 = await OpJournal.open(dir)
    assert.deepEqual(await j1.op('big', 'send', {}, () => big), big)
    const done = records(dir).find(r => r.status === 'done')
    assert.match(done.blob, /^[0-9a-f]{64}$/)
    assert.equal(done.result, undefined)
    assert.deepEqual(readdirSync(join(dir, 'blobs')), [`${done.blob}.json`])
    const j2 = await OpJournal.open(dir)
    assert.deepEqual(j2.result('big'), big)
    writeFileSync(join(dir, 'blobs', `${done.blob}.json`), JSON.stringify({ text: 'tampered' }))
    const j3 = await OpJournal.open(dir)
    assert.throws(() => j3.result('big'), error => error.cls === 'journal_corrupt')
  })

  it('runs disjoint keys concurrently and refuses the same key twice at once', async () => {
    const dir = await tmpDir()
    const j = await OpJournal.open(dir)
    const slow = (key, ms) => j.op(key, 'k', {}, () => new Promise(r => setTimeout(() => r(key), ms)))
    const results = await Promise.all([slow('w001/b:a/x', 30), slow('w001/b:b/x', 5), slow('w001/b:c/x', 15)])
    assert.deepEqual(results, ['w001/b:a/x', 'w001/b:b/x', 'w001/b:c/x'])
    const seqs = records(dir).map(r => r.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
    assert.equal(new Set(seqs).size, seqs.length)
    const p = slow('same', 20)
    await assert.rejects(j.op('same', 'k', {}, () => 1), /already running/)
    await p
  })

  it('tolerates a torn tail and keeps appending parseable records', async () => {
    const dir = await tmpDir()
    const j1 = await OpJournal.open(dir)
    await j1.op('a', 'k', {}, () => 1)
    appendFileSync(join(dir, 'ops.jsonl'), '{"seq":3,"key":"b","kind":"k","sta')
    const j2 = await OpJournal.open(dir)
    assert.equal(j2.isDone('a'), true)
    assert.equal(j2.hasStart('b'), false)
    await j2.op('b', 'k', {}, () => 2)
    const j3 = await OpJournal.open(dir)
    assert.equal(j3.result('b'), 2)
  })

  it('writes each protocol event once, also across replays and recovering re-runs', async () => {
    const dir = await tmpDir()
    const seen = []
    const j1 = await OpJournal.open(dir, { lineage: 'l1', onEvent: e => seen.push(e.type) })
    await j1.event('w001/ev:authored', 'WAVE_AUTHORED', { wave: 1, ids: ['a'] })
    await j1.event('w001/ev:authored', 'WAVE_AUTHORED', { wave: 1, ids: ['a'] })
    const j2 = await OpJournal.open(dir, { lineage: 'l1' })
    await j2.event('w001/ev:authored', 'WAVE_AUTHORED', { wave: 1, ids: ['a'] })
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'WAVE_AUTHORED')
    assert.equal(events[0].lineage, 'l1')
    assert.equal(events[0].op, 'w001/ev:authored')
    assert.deepEqual(events[0].ids, ['a'])
    assert.deepEqual(seen, ['WAVE_AUTHORED'])
    // A crash between the event append and its done record: the recovering event op does not repeat it.
    appendFileSync(join(dir, 'ops.jsonl'), `${JSON.stringify({ seq: 99, key: 'x/ev', kind: 'event', argsSha: records(dir)[0].argsSha, status: 'start', ts: 't' })}\n`)
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ ts: 't', type: 'WAVE_AUTHORED', lineage: 'l1', op: 'x/ev' })}\n`)
    const j3 = await OpJournal.open(dir, { lineage: 'l1' })
    await j3.event('x/ev', 'WAVE_AUTHORED', {})
    const after = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
    assert.equal(after.length, 2)
  })

  it('injects a fault before a chosen record (crash-matrix hook)', async () => {
    assert.deepEqual(parseFault('7:throw'), { atSeq: 7, mode: 'throw', when: 'before' })
    assert.deepEqual(parseFault('3:kill:after'), { atSeq: 3, mode: 'kill', when: 'after' })
    assert.equal(parseFault('nonsense'), null)
    assert.equal(parseFault(''), null)
    const dir = await tmpDir()
    const j = await OpJournal.open(dir, { fault: { atSeq: 3, mode: 'throw' } })
    await j.op('one', 'k', {}, () => 1) // seq 1, 2
    let ran = false
    await assert.rejects(j.op('two', 'k', {}, () => { ran = true }), /injected fault before op record 3/)
    assert.equal(ran, false)
    // The fault fires once; the next attempt proceeds.
    assert.equal(await j.op('two', 'k', {}, () => 2), 2)
  })
})

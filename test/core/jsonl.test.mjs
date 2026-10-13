// fsync'd JSONL with a torn tail (SPEC §5.3; dsh store.ts:300-326, 717-730).

import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { appendJsonl, appendJsonlSync, readJsonl, readJsonlSync } from '../../lib/core/jsonl.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

describe('jsonl', () => {
  it('appends one line per record, creating the file (0600) and its parents', async () => {
    const root = await tmpDir()
    const path = join(root, 'a', 'j.jsonl')
    await appendJsonl(path, { n: 1 })
    await appendJsonl(path, { n: 2 }, { fsync: false })
    appendJsonlSync(path, { n: 3 })
    assert.equal(await readFile(path, 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await readJsonl(path), [{ n: 1 }, { n: 2 }, { n: 3 }])
    assert.deepEqual(readJsonlSync(path), [{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('skips a torn tail and keeps a record appended after it', async () => {
    const root = await tmpDir()
    const path = join(root, 'j.jsonl')
    await writeFile(path, '{"episode":"a"}\n{"episode":"tor')
    assert.deepEqual(await readJsonl(path), [{ episode: 'a' }])
    await appendJsonl(path, { episode: 'b' })
    assert.equal(await readFile(path, 'utf8'), '{"episode":"a"}\n{"episode":"tor\n{"episode":"b"}\n')
    assert.deepEqual(await readJsonl(path), [{ episode: 'a' }, { episode: 'b' }])
    await writeFile(path, 'garbage')
    appendJsonlSync(path, { episode: 'c' })
    assert.deepEqual(readJsonlSync(path), [{ episode: 'c' }])
  })

  it('a missing file reads as []; blank lines are ignored', async () => {
    const root = await tmpDir()
    assert.deepEqual(await readJsonl(join(root, 'none.jsonl')), [])
    assert.deepEqual(readJsonlSync(join(root, 'none.jsonl')), [])
    await writeFile(join(root, 'b.jsonl'), '\n\n{"x":1}\n   \n')
    assert.deepEqual(await readJsonl(join(root, 'b.jsonl')), [{ x: 1 }])
  })

  it('concurrent appends never interleave', async () => {
    const root = await tmpDir()
    const path = join(root, 'c.jsonl')
    await Promise.all(Array.from({ length: 50 }, (_, i) => appendJsonl(path, { i, pad: 'x'.repeat(500) })))
    const records = await readJsonl(path)
    assert.equal(records.length, 50)
    assert.deepEqual(records.map(r => r.i).sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i))
  })
})

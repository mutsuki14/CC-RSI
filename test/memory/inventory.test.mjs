// formatInventory (SPEC §6.7; dsh-rsi src/roles/actor.ts:9-24).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatInventory } from '../../lib/memory/inventory.mjs'

describe('formatInventory', () => {
  it('lists sizes and names sorted by UTF-8 bytes', () => {
    const { lines, omitted } = formatInventory([{ path: 'é.md', bytes: 3 }, { path: 'Z.md', bytes: 10 }, { path: 'a/b.md', bytes: 7 }])
    assert.deepEqual(lines, ['  10  Z.md', '  7  a/b.md', '  3  é.md'])
    assert.equal(omitted, 0)
  })

  it('omits names containing braces and counts them', () => {
    const { lines, omitted } = formatInventory([{ path: '{{TARGET}}.md', bytes: 1 }, { path: 'x}.md', bytes: 1 }, { path: 'ok.md', bytes: 2 }])
    assert.deepEqual(lines, ['  2  ok.md', '… 2 more files'])
    assert.equal(omitted, 2)
  })

  it('truncates at the limit with a "more files" line', () => {
    const files = Array.from({ length: 45 }, (_, i) => ({ path: `f${String(i).padStart(2, '0')}.md`, bytes: i }))
    const { lines, omitted } = formatInventory(files)
    assert.equal(lines.length, 41)
    assert.equal(lines[0], '  0  f00.md')
    assert.equal(lines[39], '  39  f39.md')
    assert.equal(lines[40], '… 5 more files')
    assert.equal(omitted, 5)
    assert.deepEqual(formatInventory(files, 2).lines, ['  0  f00.md', '  1  f01.md', '… 43 more files'])
  })

  it('handles an empty inventory', () => {
    assert.deepEqual(formatInventory([]), { lines: [], omitted: 0 })
  })
})

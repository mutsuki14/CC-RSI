// dsh-rsi test/memory.test.ts:25-31 plus the remaining safeRelativePath rules (SPEC §6.7).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UnsafeMemoryPathError } from '../../lib/memory/errors.mjs'
import { safeRelativePath } from '../../lib/memory/safe-path.mjs'

describe('safeRelativePath', () => {
  it('normalizes and confines paths (dsh cases)', () => {
    assert.equal(safeRelativePath('./notes//build.md'), 'notes/build.md')
    assert.equal(safeRelativePath('scripts\\run.sh'), 'scripts/run.sh')
    for (const bad of ['', '/etc/passwd', '../escape', 'a/../../b', 'C:/x']) {
      assert.throws(() => safeRelativePath(bad), UnsafeMemoryPathError, bad)
    }
  })

  it('trims, collapses dot segments and rejects NUL, drive letters, empty names and overlong paths', () => {
    assert.equal(safeRelativePath('  lessons/./a.md  '), 'lessons/a.md')
    assert.equal(safeRelativePath('a/b/'), 'a/b')
    for (const bad of ['   ', '.', './', '//', 'a\0b', 'c:relative', '\\\\server\\share', 'a/..', '..', `${'x'.repeat(241)}`]) {
      assert.throws(() => safeRelativePath(bad), UnsafeMemoryPathError, JSON.stringify(bad))
    }
    assert.equal(safeRelativePath('x'.repeat(240)), 'x'.repeat(240))
    assert.throws(() => safeRelativePath(42), UnsafeMemoryPathError)
  })

  it('keeps names that merely contain dots', () => {
    assert.equal(safeRelativePath('a..b/.hidden'), 'a..b/.hidden')
  })
})

// materializeView / viewTreeHash (SPEC §6.7, §11.10).

import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { rmrf } from '../../lib/core/atomic.mjs'
import { UnsafeMemoryPathError } from '../../lib/memory/errors.mjs'
import { EMPTY_TREE_SHA256 } from '../../lib/memory/hash.mjs'
import { scanTree } from '../../lib/memory/tree.mjs'
import { materializeView, viewTreeHash } from '../../lib/memory/view.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

async function source() {
  const root = await tmpDir()
  const src = join(root, 'src')
  await mkdir(join(src, 'lessons'), { recursive: true })
  await writeFile(join(src, 'INDEX.md'), '# index\n')
  await writeFile(join(src, 'lessons', 'fail-01.md'), "FAIL: don't\n")
  await writeFile(join(src, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  return { root, src }
}

describe('materializeView', () => {
  it('creates a read-only copy (files 0444, dirs 0555) with the source tree hash', async () => {
    const { root, src } = await source()
    const dest = join(root, 'views', 's1', 'memory')
    const { treeSha256 } = await materializeView(src, dest)
    assert.equal(treeSha256, (await scanTree(src)).treeSha256)
    assert.equal(await viewTreeHash(dest), treeSha256)
    assert.equal((await stat(join(dest, 'INDEX.md'))).mode & 0o777, 0o444)
    assert.equal((await stat(join(dest, 'run.sh'))).mode & 0o777, 0o444)
    assert.equal((await stat(dest)).mode & 0o777, 0o555)
    assert.equal((await stat(join(dest, 'lessons'))).mode & 0o777, 0o555)
    assert.equal(await readFile(join(dest, 'lessons', 'fail-01.md'), 'utf8'), "FAIL: don't\n")
    assert.deepEqual((await readdir(join(root, 'views', 's1'))).sort(), ['memory'])
  })

  it('a refresh discards edits made to the view and replaces a symlinked view without following it', async () => {
    const { root, src } = await source()
    const dest = join(root, 'view')
    const first = await materializeView(src, dest)
    // Simulate a Bash edit to the view (as the owner can after chmod).
    await rmrf(dest)
    await mkdir(dest)
    await writeFile(join(dest, 'injected.md'), 'not from canonical')
    assert.notEqual(await viewTreeHash(dest), first.treeSha256)
    assert.equal((await materializeView(src, dest)).treeSha256, first.treeSha256)
    assert.equal(await viewTreeHash(dest), first.treeSha256)

    const victim = join(root, 'victim')
    await mkdir(victim)
    await writeFile(join(victim, 'keep.txt'), 'keep')
    await rmrf(dest)
    await symlink(victim, dest)
    await materializeView(src, dest)
    assert.equal((await lstat(dest)).isDirectory(), true)
    assert.equal(await readFile(join(victim, 'keep.txt'), 'utf8'), 'keep')
  })

  it('writable copies keep the owner exec bit', async () => {
    const { root, src } = await source()
    const dest = join(root, 'draft')
    await materializeView(src, dest, { readOnly: false })
    assert.equal((await stat(join(dest, 'run.sh'))).mode & 0o777, 0o700)
    assert.equal((await stat(join(dest, 'INDEX.md'))).mode & 0o777, 0o600)
    await writeFile(join(dest, 'INDEX.md'), 'editable')
  })

  it('a missing source gives an empty view; a source with a symlink is refused', async () => {
    const root = await tmpDir()
    const dest = join(root, 'v')
    assert.equal((await materializeView(join(root, 'none'), dest)).treeSha256, EMPTY_TREE_SHA256)
    assert.equal(await viewTreeHash(dest), EMPTY_TREE_SHA256)
    assert.equal(await viewTreeHash(join(root, 'missing')), null)
    const bad = join(root, 'bad')
    await mkdir(bad)
    await symlink('/etc/hostname', join(bad, 'link'))
    await assert.rejects(materializeView(bad, join(root, 'v2')), UnsafeMemoryPathError)
    assert.equal(await viewTreeHash(bad), null)
  })
})

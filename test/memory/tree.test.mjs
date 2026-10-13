// scanTree / pullTree / diffManifests (SPEC §6.4 step 5, §6.7).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { sha256Hex } from '../../lib/core/digest.mjs'
import { UnsafeMemoryPathError } from '../../lib/memory/errors.mjs'
import { EMPTY_TREE_SHA256 } from '../../lib/memory/hash.mjs'
import { DEFAULT_DROP, diffManifests, listTree, pullTree, scanTree, writeTree } from '../../lib/memory/tree.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

async function put(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

describe('scanTree', () => {
  it('a missing root is the empty tree', async () => {
    const root = await tmpDir()
    assert.deepEqual(await scanTree(join(root, 'absent')), { files: {}, treeSha256: EMPTY_TREE_SHA256 })
    assert.deepEqual(await pullTree(join(root, 'absent')), {})
  })

  it('hashes a real directory exactly like RSIAgent _read_memory_tree (dotfiles, nested dirs, empty dirs ignored)', async () => {
    const root = await tmpDir()
    await put(root, { '.hidden': 'h', 'B.md': '1', 'B/c.md': '2', 'B-x.md': '3', 'B/sub/d.md': '4' })
    await mkdir(join(root, 'empty', 'deeper'), { recursive: true })
    const scan = await scanTree(root)
    assert.equal(scan.treeSha256, '61d58dd6fdff98dd37bbae563d3b8322b25de998ab12b7be66a59a6e06efaf75')
    assert.deepEqual(Object.keys(scan.files), ['.hidden', 'B-x.md', 'B.md', 'B/c.md', 'B/sub/d.md'])
    assert.deepEqual(scan.files['B/c.md'], { bytes: 1, sha256: sha256Hex('2'), mode: scan.files['B/c.md'].mode })
    const unicode = await tmpDir()
    await put(unicode, { '！.md': 'x', '\u{1F600}.md': 'y', 'Z.md': 'z', 'a.md': 'w', 'é.md': 'e' })
    assert.equal((await scanTree(unicode)).treeSha256, '20b3f2cc25d1e9dc7b864f7de5ac9c69b167c0fabb801f8b4d868e8c0cca746f')
  })

  it('drops __pycache__, *.pyc and *.pyo', async () => {
    const root = await tmpDir()
    await put(root, { 'tool.py': 'print(1)', '__pycache__/tool.cpython-312.pyc': 'x', 'lib/__pycache__/m.pyc': 'y', 'lib/old.pyo': 'z', 'lib/m.py': 'm' })
    assert.deepEqual(Object.keys(await pullTree(root)), ['lib/m.py', 'tool.py'])
    assert.equal(DEFAULT_DROP('a/__pycache__/b'), true)
    assert.equal(DEFAULT_DROP('pycache/b.py'), false)
  })

  it('refuses symlinks anywhere, special files and a symlinked root', async () => {
    const root = await tmpDir()
    await put(root, { 'a.md': 'a' })
    await mkdir(join(root, 'deep', 'er'), { recursive: true })
    await symlink('/etc/hostname', join(root, 'deep', 'er', 'link'))
    await assert.rejects(scanTree(root), err => err instanceof UnsafeMemoryPathError && /symlink/.test(err.message))
    await assert.rejects(pullTree(root), UnsafeMemoryPathError)

    const dirLink = await tmpDir()
    await symlink(root, join(dirLink, 'memory'))
    await assert.rejects(scanTree(join(dirLink, 'memory')), UnsafeMemoryPathError)

    const fifo = await tmpDir()
    execFileSync('mkfifo', [join(fifo, 'pipe')])
    await assert.rejects(scanTree(fifo), err => err instanceof UnsafeMemoryPathError && /special/.test(err.message))
  })

  it('refuses names that are not valid UTF-8', async () => {
    const root = await tmpDir()
    await writeFile(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x66, 0xff, 0x2e, 0x6d, 0x64])]), 'x')
    await assert.rejects(scanTree(root), err => err instanceof UnsafeMemoryPathError && /UTF-8/.test(err.message))
  })

  it('refuses unsafe names', async () => {
    const root = await tmpDir()
    await writeFile(join(root, 'C:evil'), 'x')
    await assert.rejects(scanTree(root), UnsafeMemoryPathError)
  })

  it('listTree reports sizes without reading', async () => {
    const root = await tmpDir()
    await put(root, { 'b.md': 'bbb', 'a/x.md': 'x' })
    const listed = await listTree(root)
    assert.deepEqual(listed.map(e => [e.rel, e.bytes]), [['a/x.md', 1], ['b.md', 3]])
  })
})

describe('writeTree', () => {
  it('writes a new tree with exact modes and refuses to overwrite', async () => {
    const root = await tmpDir()
    const dest = join(root, 'out')
    await writeTree(dest, { 'a/b.md': 'b', 'c.sh': 'c' }, { fileMode: rel => (rel.endsWith('.sh') ? 0o700 : 0o600), fsync: true })
    const scan = await scanTree(dest)
    assert.equal(scan.files['c.sh'].mode, 0o700)
    assert.equal(scan.files['a/b.md'].mode, 0o600)
    await assert.rejects(writeTree(dest, {}), /EEXIST/)
  })
})

describe('diffManifests', () => {
  it('classifies and sorts by UTF-8 bytes', () => {
    const e = s => ({ sha256: sha256Hex(s), bytes: s.length })
    const before = { 'keep.md': e('k'), 'mod.md': e('1'), 'gone.md': e('g'), '\u{1F600}.md': e('x') }
    const after = { 'keep.md': e('k'), 'mod.md': e('2'), 'é.md': e('n'), '！.md': e('m'), 'Z.md': e('z') }
    assert.deepEqual(diffManifests(before, after), {
      created: ['Z.md', 'é.md', '！.md'],
      modified: ['mod.md'],
      deleted: ['gone.md', '\u{1F600}.md'],
      unchanged: ['keep.md'],
    })
  })
})

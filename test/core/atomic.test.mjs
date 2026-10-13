// Atomic file primitives (SPEC §0 "Files", §5.3).

import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ensureDir, exists, fsyncDir, readJson, readJsonSafe, readJsonSafeSync, rmrf, writeFileAtomic, writeJsonAtomic, writeJsonAtomicSync,
} from '../../lib/core/atomic.mjs'
import { CcRsiError } from '../../lib/core/errors.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

describe('atomic', () => {
  it('ensureDir creates nested dirs with mode 0700', async () => {
    const root = await tmpDir()
    const dir = join(root, 'a', 'b')
    assert.equal(await ensureDir(dir), dir)
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    await ensureDir(dir)
  })

  it('writeFileAtomic replaces content, creates parents, applies the mode and leaves no tmp files', async () => {
    const root = await tmpDir()
    const path = join(root, 'deep', 'f.txt')
    await writeFileAtomic(path, 'one')
    assert.equal(await readFile(path, 'utf8'), 'one')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    await writeFileAtomic(path, Buffer.from('two'), { mode: 0o644 })
    assert.equal(await readFile(path, 'utf8'), 'two')
    assert.equal((await stat(path)).mode & 0o777, 0o644)
    assert.deepEqual(await readdir(join(root, 'deep')), ['f.txt'])
  })

  it('a failed write leaves the destination untouched and no tmp file', async () => {
    const root = await tmpDir()
    const path = join(root, 'f.txt')
    await writeFileAtomic(path, 'keep')
    await mkdir(join(root, 'dir-dest'))
    await assert.rejects(writeFileAtomic(join(root, 'dir-dest'), 'x'))
    assert.deepEqual((await readdir(root)).sort(), ['dir-dest', 'f.txt'])
    assert.equal(await readFile(path, 'utf8'), 'keep')
  })

  it('writeJsonAtomic / readJson round-trip with the documented format', async () => {
    const root = await tmpDir()
    const path = join(root, 'v.json')
    await writeJsonAtomic(path, { b: 1, a: [true] })
    assert.equal(await readFile(path, 'utf8'), '{\n  "b": 1,\n  "a": [\n    true\n  ]\n}\n')
    assert.deepEqual(await readJson(path), { b: 1, a: [true] })
    writeJsonAtomicSync(join(root, 'sync', 's.json'), { x: 1 })
    assert.deepEqual(readJsonSafeSync(join(root, 'sync', 's.json'), null), { x: 1 })
  })

  it('readJson: ENOENT → fallback; malformed → json_malformed; readJsonSafe never throws', async () => {
    const root = await tmpDir()
    assert.equal(await readJson(join(root, 'missing.json'), 'fb'), 'fb')
    assert.equal(await readJson(join(root, 'missing.json')), undefined)
    await writeFile(join(root, 'bad.json'), '{"torn":')
    await assert.rejects(readJson(join(root, 'bad.json'), null), err => err instanceof CcRsiError && err.code === 'json_malformed')
    assert.equal(await readJsonSafe(join(root, 'bad.json'), 7), 7)
    assert.equal(await readJsonSafe(join(root, 'missing.json'), 8), 8)
    assert.equal(readJsonSafeSync(join(root, 'bad.json'), 9), 9)
  })

  it('rmrf removes trees (including read-only views), tolerates missing paths and never follows symlinks', async () => {
    const root = await tmpDir()
    const view = join(root, 'view')
    await mkdir(join(view, 'sub'), { recursive: true })
    await writeFile(join(view, 'sub', 'f'), 'x')
    await chmod(join(view, 'sub', 'f'), 0o444)
    await chmod(join(view, 'sub'), 0o555)
    await chmod(view, 0o555)
    await rmrf(view)
    assert.equal(await exists(view), false)
    await rmrf(join(root, 'never-existed'))
    const target = join(root, 'target')
    await mkdir(target)
    await writeFile(join(target, 'keep'), 'k')
    await symlink(target, join(root, 'link'))
    await rmrf(join(root, 'link'))
    assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'k')
    assert.equal(await exists(join(root, 'link')), false)
  })

  it('exists uses lstat (a dangling symlink exists); fsyncDir tolerates odd targets', async () => {
    const root = await tmpDir()
    await symlink(join(root, 'nowhere'), join(root, 'dangling'))
    assert.equal(await exists(join(root, 'dangling')), true)
    assert.equal(await exists(join(root, 'nope')), false)
    assert.equal(await exists(join(root, 'nope', 'deeper')), false)
    await fsyncDir(root)
    await fsyncDir(join(root, 'missing'))
  })
})

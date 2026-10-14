// copy.mjs (SPEC §9.1): lstat-based copy with verbatim links, modes and times; removal of
// read-only trees; move-aside numbering; write-bit helpers. Ports dsh fixtures.ts:104-139 behaviour.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir, unprivilegedSkip } from '../_helpers/tmp.mjs'
import { copyTree, listTree, makeReadOnly, makeWritable, moveAside, removeTree, sortPaths } from '../../lib/workspace/copy.mjs'

async function sampleTree() {
  const base = await tmpDir()
  const src = join(base, 'src')
  await mkdir(join(src, 'bin'), { recursive: true })
  await mkdir(join(src, 'empty'))
  await mkdir(join(src, 'locked'))
  await writeFile(join(src, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n')
  await chmod(join(src, 'bin', 'run.sh'), 0o750)
  await writeFile(join(src, 'locked', 'ro.txt'), 'read only')
  await chmod(join(src, 'locked', 'ro.txt'), 0o444)
  await chmod(join(src, 'locked'), 0o555)
  await writeFile(join(src, 'data.txt'), 'data')
  await utimes(join(src, 'data.txt'), new Date('2020-01-02T03:04:05.678Z'), new Date('2021-02-03T04:05:06.789Z'))
  await symlink('data.txt', join(src, 'rel-link'))
  await symlink('/etc/passwd', join(src, 'abs-link'))
  execFileSync('mkfifo', [join(src, 'pipe')])
  return { base, src }
}

test('copyTree keeps modes, times and links verbatim, skips special files, never follows links', async () => {
  const { base, src } = await sampleTree()
  const dest = join(base, 'nested', 'dest')
  const a = await stat(join(src, 'data.txt'), { bigint: true }) // before the copy reads it (atime)
  const report = await copyTree(src, dest)
  assert.deepEqual(report.skipped, [{ path: 'pipe', kind: 'special' }])
  assert.equal(report.files, 3)
  assert.equal(report.links, 2)
  assert.equal(report.dirs, 4)
  assert.equal((await stat(join(dest, 'bin', 'run.sh'))).mode & 0o7777, 0o750)
  assert.equal((await stat(join(dest, 'locked'))).mode & 0o7777, 0o555)
  assert.equal((await stat(join(dest, 'locked', 'ro.txt'))).mode & 0o7777, 0o444)
  assert.equal(await readlink(join(dest, 'rel-link')), 'data.txt')
  assert.equal(await readlink(join(dest, 'abs-link')), '/etc/passwd')
  assert.equal((await lstat(join(dest, 'abs-link'))).isSymbolicLink(), true)
  assert.equal(existsSync(join(dest, 'pipe')), false)
  assert.deepEqual(await readdir(join(dest, 'empty')), [])
  const b = await stat(join(dest, 'data.txt'), { bigint: true })
  assert.equal(b.mtimeNs / 1000n, a.mtimeNs / 1000n)
  assert.equal(b.atimeNs / 1000n, a.atimeNs / 1000n)
  assert.equal(await readFile(join(dest, 'locked', 'ro.txt'), 'utf8'), 'read only')
})

test('copyTree options: filter, verbatimSymlinks:false, preserveMode:false; destination rules', async () => {
  const { base, src } = await sampleTree()
  const filtered = await copyTree(src, join(base, 'filtered'), { filter: rel => rel !== 'locked' && rel !== 'pipe', verbatimSymlinks: false })
  assert.deepEqual(filtered.skipped, [{ path: 'abs-link', kind: 'symlink' }, { path: 'rel-link', kind: 'symlink' }])
  assert.deepEqual((await readdir(join(base, 'filtered'))).sort(), ['bin', 'data.txt', 'empty'])
  const writable = join(base, 'writable')
  await copyTree(join(src, 'locked'), writable, { preserveMode: false })
  assert.equal((await stat(writable)).mode & 0o777, 0o755)
  assert.equal((await stat(join(writable, 'ro.txt'))).mode & 0o777, 0o644)
  // An existing empty directory may be filled; anything else is refused.
  const empty = join(base, 'empty-dest')
  await mkdir(empty)
  await copyTree(join(src, 'bin'), empty)
  assert.ok(existsSync(join(empty, 'run.sh')))
  await assert.rejects(copyTree(join(src, 'bin'), empty), { code: 'copy_dest_exists' })
  await assert.rejects(copyTree(join(base, 'missing'), join(base, 'x')), { code: 'copy_source_missing' })
  await assert.rejects(copyTree(src, join(src, 'bin', 'inside')), { code: 'copy_into_self' })
  // A single file or link copies too.
  await copyTree(join(src, 'data.txt'), join(base, 'single.txt'))
  assert.equal(await readFile(join(base, 'single.txt'), 'utf8'), 'data')
  await copyTree(join(src, 'abs-link'), join(base, 'single-link'))
  assert.equal(await readlink(join(base, 'single-link')), '/etc/passwd')
})

test('removeTree removes read-only trees, never follows links, refuses dangerous paths', async () => {
  const { base, src } = await sampleTree()
  const outside = join(base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await symlink(outside, join(src, 'link-to-outside'))
  await makeReadOnly(src)
  await removeTree(src)
  assert.equal(existsSync(src), false)
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
  await symlink(outside, join(base, 'top-link'))
  await removeTree(join(base, 'top-link'))
  assert.equal(existsSync(join(base, 'top-link')), false)
  assert.equal(existsSync(join(outside, 'keep.txt')), true)
  await removeTree(join(base, 'never-existed'))
  await assert.rejects(removeTree('/'), { code: 'unsafe_remove' })
  await assert.rejects(removeTree(''), { code: 'unsafe_remove' })
})

test('removeTree as an unprivileged user clears restrictive modes first', { skip: process.getuid?.() === 0 ? unprivilegedSkip() : 'covered in-process when not root' }, async () => {
  const base = await tmpDir()
  execFileSync('chown', ['65534:65534', base])
  const script = `
    import { mkdir, writeFile, chmod } from 'node:fs/promises'
    import { existsSync } from 'node:fs'
    import { join } from 'node:path'
    import { removeTree, makeReadOnly } from ${JSON.stringify(new URL('../../lib/workspace/copy.mjs', import.meta.url).href)}
    const root = join(process.env.BASE, 'view')
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    await writeFile(join(root, 'a', 'b', 'f'), 'x')
    await makeReadOnly(root)
    await chmod(join(root, 'a'), 0o500)
    await removeTree(root)
    process.stdout.write(String(existsSync(root)))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, BASE: base }, uid: 65534, gid: 65534,
  }).toString()
  assert.equal(out, 'false')
})

test('moveAside numbers attempts, reserves slots, and returns null for a missing source', async () => {
  const base = await tmpDir()
  const into = join(base, 'infra_attempts')
  for (const name of ['p1', 'p2']) {
    await mkdir(join(base, name, 'sub'), { recursive: true })
    await writeFile(join(base, name, 'sub', 'f.txt'), name)
  }
  assert.equal(await moveAside(join(base, 'p1'), into), join(into, 'attempt_001'))
  assert.equal(await moveAside(join(base, 'p2'), into), join(into, 'attempt_002'))
  assert.equal(await readFile(join(into, 'attempt_002', 'sub', 'f.txt'), 'utf8'), 'p2')
  assert.equal(existsSync(join(base, 'p1')), false)
  assert.equal(await moveAside(join(base, 'p1'), into), null)
  await writeFile(join(base, 'loose.txt'), 'file')
  assert.equal(await moveAside(join(base, 'loose.txt'), into, 'leftover_'), join(into, 'leftover_001'))
  assert.equal(await readFile(join(into, 'leftover_001'), 'utf8'), 'file')
  // Concurrent callers never share a slot.
  for (let i = 0; i < 6; i++) await mkdir(join(base, `c${i}`))
  const targets = await Promise.all([0, 1, 2, 3, 4, 5].map(i => moveAside(join(base, `c${i}`), into)))
  assert.equal(new Set(targets).size, 6)
  assert.deepEqual((await readdir(into)).filter(n => n.startsWith('attempt_')).length, 8)
})

test('makeReadOnly clears every write bit (directories after children); makeWritable restores owner write', async () => {
  const base = await tmpDir()
  const view = join(base, 'view')
  await mkdir(join(view, 'd'), { recursive: true })
  await writeFile(join(view, 'd', 'f.txt'), 'x')
  await chmod(join(view, 'd', 'f.txt'), 0o664)
  await symlink('d/f.txt', join(view, 'link'))
  await makeReadOnly(view)
  assert.equal((await stat(view)).mode & 0o777, 0o555)
  assert.equal((await stat(join(view, 'd'))).mode & 0o777, 0o555)
  assert.equal((await stat(join(view, 'd', 'f.txt'))).mode & 0o777, 0o444)
  await makeWritable(view)
  assert.equal((await stat(view)).mode & 0o777, 0o755)
  assert.equal((await stat(join(view, 'd', 'f.txt'))).mode & 0o777, 0o644)
  await makeReadOnly(join(base, 'missing'))
  await makeWritable(join(base, 'missing'))
})

test('listTree with a limit walks in byte order and stops after `limit` files (portability-11)', async () => {
  const base = await tmpDir()
  const files = ['a.txt', 'a/x', 'a/y', 'a0', 'b/deep/z', 'c.txt', 'c/q']
  for (const rel of files) {
    await mkdir(join(base, rel, '..'), { recursive: true })
    await writeFile(join(base, rel), rel)
  }
  await symlink('a.txt', join(base, 'a.link'))
  const full = await listTree(base)
  assert.equal(full.truncated, false)
  assert.deepEqual(full.files, sortPaths(files))
  // The prefix of the byte-ordered listing: 'a.txt' < 'a/x' because '.' < '/'.
  const limited = await listTree(base, { limit: 3 })
  assert.equal(limited.truncated, true)
  assert.deepEqual(limited.files, ['a.txt', 'a/x', 'a/y'])
  assert.deepEqual(limited.links, ['a.link'])
  assert.deepEqual(limited.dirs, ['a'], 'directories after the cutoff are never entered')
  const exact = await listTree(base, { limit: files.length })
  assert.equal(exact.truncated, false)
  assert.deepEqual(exact.files, full.files)
  assert.equal((await listTree(base, { limit: 0 })).files.length, 0)
})

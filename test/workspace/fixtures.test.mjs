// fixtures.mjs (SPEC §9.5): shape gate details; capture/replay of the exact set; read-only views.
// Ports dsh engine/fixtures.ts behaviour and RSIAgent target_learning.py:126-143 (shape gate).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../_helpers/tmp.mjs'
import {
  captureTree, removeView, replayTree, shapeGate, stageReadOnlyView, verifyTree,
} from '../../lib/workspace/fixtures.mjs'

async function project(base, name = 'project') {
  const root = join(base, name)
  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  await mkdir(join(root, 'empty-dir'))
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await writeFile(join(root, 'src', 'main.py'), 'print("hi")\n')
  await writeFile(join(root, 'src', 'deep', 'data.csv'), 'a,b\n1,2\n')
  await writeFile(join(root, 'run.sh'), '#!/bin/sh\n')
  await chmod(join(root, 'run.sh'), 0o755)
  return root
}

test('shapeGate details (RSIAgent _require_owned_project_shape)', async () => {
  const base = await tmpDir()
  const root = await project(base)
  assert.equal(await shapeGate(root), null)
  assert.equal(await shapeGate(join(base, 'missing')), `${join(base, 'missing')} does not exist`)
  await writeFile(join(base, 'file'), 'x')
  assert.equal(await shapeGate(join(base, 'file')), `${join(base, 'file')} is not a plain directory`)
  await symlink(root, join(base, 'linked-root'))
  assert.equal(await shapeGate(join(base, 'linked-root')), `${join(base, 'linked-root')} is not a plain directory`)
  await mkdir(join(base, 'empty', 'sub'), { recursive: true })
  assert.equal(await shapeGate(join(base, 'empty')), `${join(base, 'empty')} contains no regular file`)

  await symlink('../README.md', join(root, 'src', 'readme-link'))
  assert.equal(await shapeGate(root), 'src/readme-link is a symbolic link')
  assert.equal(await shapeGate(root, { allowInternalSymlinks: true }), null)
  await symlink('../../outside', join(root, 'src', 'escape'))
  assert.equal(await shapeGate(root, { allowInternalSymlinks: true }), 'src/escape is a symbolic link that leaves the tree')
  await rm(join(root, 'src', 'escape'))
  await symlink('/etc/passwd', join(root, 'abs'))
  assert.equal(await shapeGate(root, { allowInternalSymlinks: true }), 'abs is a symbolic link that leaves the tree')
  await rm(join(root, 'abs'))
  await rm(join(root, 'src', 'readme-link'))
  execFileSync('mkfifo', [join(root, 'src', 'fifo')])
  assert.equal(await shapeGate(root), 'src/fifo is not a regular file or directory')
})

test('captureTree / replayTree reproduce the exact set (files, contents, modes, empty dirs)', async () => {
  const base = await tmpDir()
  const root = await project(base)
  const capture = join(base, 'priv', 'w001', 'csv', 'fixtures')
  const manifest = await captureTree(root, capture)
  assert.deepEqual(Object.keys(manifest.files), ['README.md', 'run.sh', 'src/deep/data.csv', 'src/main.py'])
  assert.deepEqual(manifest.dirs, ['empty-dir', 'src', 'src/deep'])
  assert.deepEqual(manifest.links, {})
  assert.equal(manifest.files['README.md'].bytes, 10)
  assert.match(manifest.files['README.md'].sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(JSON.parse(await readFile(join(capture, 'manifest.json'), 'utf8')), JSON.parse(JSON.stringify(manifest)))
  assert.deepEqual((await readdir(capture)).sort(), ['manifest.json', 'tree'])

  // Replay replaces whatever was at the destination.
  const replay = join(base, 'work', 'projects', 'w001-csv')
  await mkdir(replay, { recursive: true })
  await writeFile(join(replay, 'stale.txt'), 'stale')
  await replayTree(capture, replay)
  assert.equal(existsSync(join(replay, 'stale.txt')), false)
  assert.equal(await readFile(join(replay, 'src', 'deep', 'data.csv'), 'utf8'), 'a,b\n1,2\n')
  assert.equal((await stat(join(replay, 'run.sh'))).mode & 0o777, 0o755)
  assert.deepEqual(await readdir(join(replay, 'empty-dir')), [])
  assert.equal(await verifyTree(capture, replay), true)

  // verifyTree: exact file set, contents and directories.
  await writeFile(join(replay, 'extra.txt'), 'x')
  assert.equal(await verifyTree(capture, replay), false)
  await rm(join(replay, 'extra.txt'))
  await writeFile(join(replay, 'README.md'), '# fixturE\n')
  assert.equal(await verifyTree(capture, replay), false)
  await writeFile(join(replay, 'README.md'), '# fixture\n')
  assert.equal(await verifyTree(capture, replay), true)
  await mkdir(join(replay, 'new-empty'))
  assert.equal(await verifyTree(capture, replay), false)
  await rm(join(replay, 'new-empty'), { recursive: true })
  await rm(join(replay, 'src', 'main.py'))
  assert.equal(await verifyTree(capture, replay), false)
  await symlink('README.md', join(replay, 'src', 'main.py'))
  assert.equal(await verifyTree(capture, replay), false)
  assert.equal(await verifyTree(capture, join(base, 'nowhere')), false)

  // A capture of a faithful replay has the same manifest.
  await rm(join(replay, 'src', 'main.py'))
  await writeFile(join(replay, 'src', 'main.py'), 'print("hi")\n')
  const again = await captureTree(replay, join(base, 'recapture'))
  assert.deepEqual(again, manifest)
})

test('captureTree refuses links and special files unless allowed, and leaves nothing behind', async () => {
  const base = await tmpDir()
  const root = await project(base)
  await symlink('src/main.py', join(root, 'main-link'))
  const dest = join(base, 'capture')
  await assert.rejects(captureTree(root, dest), err => err.code === 'capture_unsafe' && /main-link is a symbolic link/.test(err.message))
  assert.equal(existsSync(dest), false)
  const manifest = await captureTree(root, dest, { allowInternalSymlinks: true })
  assert.deepEqual(manifest.links, { 'main-link': 'src/main.py' })
  const replay = join(base, 'replay')
  await replayTree(dest, replay)
  assert.equal(await readlink(join(replay, 'main-link')), 'src/main.py')
  await symlink('/etc/hostname', join(root, 'outside-link'))
  await assert.rejects(captureTree(root, dest, { allowInternalSymlinks: true }), { code: 'capture_unsafe' })
  assert.equal(existsSync(dest), false)
  await rm(join(root, 'outside-link'))
  execFileSync('mkfifo', [join(root, 'fifo')])
  await assert.rejects(captureTree(root, dest, { allowInternalSymlinks: true }), err => /fifo is not a regular file/.test(err.message))
  await assert.rejects(captureTree(join(base, 'missing'), dest), { code: 'capture_source_missing' })
})

test('replayTree throws replay_mismatch for a damaged capture; missing captures are typed', async () => {
  const base = await tmpDir()
  const root = await project(base)
  const capture = join(base, 'capture')
  await captureTree(root, capture)
  await writeFile(join(capture, 'tree', 'README.md'), 'tampered after capture\n')
  await assert.rejects(replayTree(capture, join(base, 'replay')), { code: 'replay_mismatch' })
  await assert.rejects(replayTree(join(base, 'none'), join(base, 'replay2')), { code: 'capture_missing' })
  await assert.rejects(verifyTree(join(base, 'none'), root), { code: 'capture_missing' })
  await assert.rejects(stageReadOnlyView(join(base, 'none'), join(base, 'view')), { code: 'capture_missing' })
  // Argument mix-ups never destroy the source.
  await assert.rejects(captureTree(root, join(root, 'capture')), { code: 'capture_overlap' })
  await assert.rejects(replayTree(capture, base), { code: 'replay_overlap' })
  await assert.rejects(stageReadOnlyView(capture, join(capture, 'tree')), { code: 'view_overlap' })
  assert.equal(existsSync(join(capture, 'manifest.json')), true)
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# fixture\n')
})

test('stageReadOnlyView makes a read-only comparison view; removeView removes it', async () => {
  const base = await tmpDir()
  const root = await project(base)
  const capture = join(base, 'capture')
  await captureTree(root, capture)
  const view = join(base, 'verify', 'p001', 'original')
  await stageReadOnlyView(capture, view)
  assert.equal(await verifyTree(capture, view), true)
  assert.equal((await stat(view)).mode & 0o222, 0)
  assert.equal((await stat(join(view, 'src', 'deep'))).mode & 0o222, 0)
  assert.equal((await stat(join(view, 'README.md'))).mode & 0o222, 0)
  assert.equal((await stat(join(view, 'run.sh'))).mode & 0o777, 0o555)
  // Re-staging replaces a previous (possibly modified) view.
  await stageReadOnlyView(capture, view)
  assert.equal(await verifyTree(capture, view), true)
  await removeView(view)
  assert.equal(existsSync(view), false)
  await removeView(view)
})

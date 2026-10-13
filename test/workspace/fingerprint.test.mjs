// fingerprint.mjs (SPEC §9.4): treeFingerprint covers .git, modes and link targets; manifests,
// deltas and the FILE-CHANGE EVIDENCE text. Ports dsh engine/workspace.ts behaviour.

import assert from 'node:assert/strict'
import { chmod, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../_helpers/tmp.mjs'
import { copyTree } from '../../lib/workspace/copy.mjs'
import { captureTree } from '../../lib/workspace/fixtures.mjs'
import {
  contentDelta, describeDelta, manifestDelta, projectManifest, treeFingerprint,
} from '../../lib/workspace/fingerprint.mjs'

async function tree(base) {
  const root = join(base, 'root')
  await mkdir(join(root, '.git', 'refs'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(root, 'src', 'a.txt'), 'alpha\n')
  await writeFile(join(root, 'b.txt'), 'beta\n')
  await symlink('src/a.txt', join(root, 'link'))
  return root
}

test('treeFingerprint covers .git, dependency trees, modes, link targets and empty dirs', async () => {
  const base = await tmpDir()
  const root = await tree(base)
  const fp = await treeFingerprint(root)
  assert.match(fp, /^[0-9a-f]{64}$/)
  assert.equal(await treeFingerprint(root), fp)
  // A faithful copy (modes kept) has the same fingerprint.
  await copyTree(root, join(base, 'copy'))
  assert.equal(await treeFingerprint(join(base, 'copy')), fp)

  const changes = [
    async () => writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/evil\n'),
    async () => writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 2\n'),
    async () => chmod(join(root, 'b.txt'), 0o600),
    async () => chmod(join(root, 'src'), 0o700),
    async () => { await rm(join(root, 'link')); await symlink('b.txt', join(root, 'link')) },
    async () => mkdir(join(root, 'new-empty-dir')),
    async () => writeFile(join(root, 'src', 'a.txt'), 'ALPHA\n'), // same size, different bytes
  ]
  let previous = fp
  for (const change of changes) {
    await change()
    const next = await treeFingerprint(root)
    assert.notEqual(next, previous)
    previous = next
  }
  // mtime alone is not part of the integrity digest.
  await utimes(join(root, 'b.txt'), new Date(), new Date(Date.now() + 10000))
  assert.equal(await treeFingerprint(root), previous)
  // A missing root is distinguishable from an empty one.
  await mkdir(join(base, 'empty'))
  assert.notEqual(await treeFingerprint(join(base, 'missing')), await treeFingerprint(join(base, 'empty')))
})

test('projectManifest ignores VCS and dependency trees, lists links, truncates deterministically', async () => {
  const base = await tmpDir()
  const root = await tree(base)
  await mkdir(join(root, '__pycache__'))
  await writeFile(join(root, '__pycache__', 'x.pyc'), 'c')
  await mkdir(join(root, '.venv', 'bin'), { recursive: true })
  await writeFile(join(root, '.venv', 'bin', 'python'), 'p')
  const manifest = await projectManifest(root)
  assert.equal(manifest.truncated, false)
  assert.deepEqual(Object.keys(manifest.files), ['b.txt', 'link', 'src/a.txt'])
  assert.equal(manifest.files['b.txt'].size, 5)
  assert.equal(typeof manifest.files['b.txt'].mtimeMs, 'number')
  assert.equal(manifest.files.link.link, 'src/a.txt')
  const limited = await projectManifest(root, { limit: 2 })
  assert.equal(limited.truncated, true)
  assert.deepEqual(Object.keys(limited.files), ['b.txt', 'link'])
  assert.deepEqual(await projectManifest(join(base, 'missing')), { files: {}, truncated: false })
  // Copies keep times at the microsecond, so a copied tree has an equal manifest.
  await copyTree(root, join(base, 'copy'))
  assert.deepEqual(await projectManifest(join(base, 'copy')), manifest)
})

test('manifestDelta between project manifests, capture manifests and bare maps', async () => {
  const base = await tmpDir()
  const root = await tree(base)
  const before = await projectManifest(root)
  await writeFile(join(root, 'new.txt'), 'n')
  await rm(join(root, 'b.txt'))
  await writeFile(join(root, 'src', 'a.txt'), 'changed alpha\n')
  const after = await projectManifest(root)
  assert.deepEqual(manifestDelta(before, after), { created: ['new.txt'], modified: ['src/a.txt'], deleted: ['b.txt'] })
  assert.deepEqual(manifestDelta(before.files, after.files), { created: ['new.txt'], modified: ['src/a.txt'], deleted: ['b.txt'] })
  assert.deepEqual(manifestDelta(after, after), { created: [], modified: [], deleted: [] })

  // Capture manifests compare by content: a touched but identical file is not modified.
  const fixtures = await captureTree(join(root, 'src'), join(base, 'cap-fixtures'))
  await utimes(join(root, 'src', 'a.txt'), new Date(), new Date(Date.now() + 5000))
  await writeFile(join(root, 'src', 'second.txt'), '2')
  const candidate = await captureTree(join(root, 'src'), join(base, 'cap-candidate'))
  assert.deepEqual(manifestDelta(fixtures, candidate), { created: ['second.txt'], modified: [], deleted: [] })

  // A file literally named "files" is never mistaken for a manifest wrapper.
  const bare = { files: { size: 1, mtimeMs: 1 }, other: { size: 2, mtimeMs: 2 } }
  assert.deepEqual(manifestDelta(bare, { other: { size: 3, mtimeMs: 2 } }), { created: [], modified: ['other'], deleted: ['files'] })

  // Truncated listings are compared only up to the last path both covered.
  const big = { files: { a: { size: 1, mtimeMs: 1 }, b: { size: 1, mtimeMs: 1 } }, truncated: true }
  const bigAfter = { files: { a: { size: 2, mtimeMs: 1 }, aa: { size: 1, mtimeMs: 1 }, c: { size: 1, mtimeMs: 1 } }, truncated: false }
  assert.deepEqual(manifestDelta(big, bigAfter), { created: ['aa'], modified: ['a'], deleted: ['b'], truncated: true })
})

test('contentDelta between checkpoint-style manifests (CHANGED SINCE YOUR LAST INSPECTION)', () => {
  const prev = {
    'a.txt': { size: 1, mode: 420, sha256: 'aa', mtimeMs: 1 },
    'b.txt': { size: 1, mode: 420, sha256: 'bb', mtimeMs: 1 },
    'big.bin': { size: 9, mode: 420, sha256: null, mtimeMs: 5 },
    'mode.sh': { size: 3, mode: 420, sha256: 'mm', mtimeMs: 1 },
  }
  const cur = {
    'a.txt': { size: 1, mode: 420, sha256: 'aa', mtimeMs: 99 },
    'big.bin': { size: 9, mode: 420, sha256: null, mtimeMs: 6 },
    'c.txt': { size: 2, mode: 420, sha256: 'cc', mtimeMs: 1 },
    'mode.sh': { size: 3, mode: 493, sha256: 'mm', mtimeMs: 1 },
  }
  assert.deepEqual(contentDelta(prev, cur), { created: ['c.txt'], modified: ['big.bin', 'mode.sh'], deleted: ['b.txt'] })
  assert.deepEqual(contentDelta(null, { 'x': { size: 1, sha256: 'x' } }), { created: ['x'], modified: [], deleted: [] })
})

test('describeDelta renders FILE-CHANGE EVIDENCE with a line cap', () => {
  const delta = { created: ['a.txt', 'b/c.txt'], modified: ['m.py'], deleted: ['old.md'] }
  assert.equal(describeDelta(delta, { header: 'since this target attempt began' }), [
    'FILE-CHANGE EVIDENCE since this target attempt began:',
    'CREATED (2):', '  a.txt', '  b/c.txt',
    'MODIFIED (1):', '  m.py',
    'DELETED (1):', '  old.md',
  ].join('\n'))
  assert.equal(describeDelta({ created: [], modified: [], deleted: [] }, { header: 'since this target attempt began' }),
    'No file changes detected since this target attempt began.')
  assert.equal(describeDelta({ created: [], modified: [], deleted: [] }), 'No file changes detected.')
  const many = { created: Array.from({ length: 5 }, (_, i) => `c${i}`), modified: ['m0', 'm1'], deleted: ['d0'] }
  assert.equal(describeDelta(many, { maxLines: 3 }), [
    'FILE-CHANGE EVIDENCE:',
    'CREATED (5):', '  c0', '  c1', '  c2', '  … 2 more',
    'MODIFIED (2):', '  … 2 more',
    'DELETED (1):', '  … 1 more',
  ].join('\n'))
  assert.match(describeDelta({ created: ['x'], modified: [], deleted: [], truncated: true }), /truncated/)
})

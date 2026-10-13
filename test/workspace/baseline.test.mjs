// baseline.mjs (SPEC §9.6, PF §4.4): S0 baseline take, FILE-CHANGE EVIDENCE since the task began,
// and the detached CLI entry.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runNode } from '../_helpers/spawn.mjs'
import { gitRepo, tmpDir } from '../_helpers/tmp.mjs'
import { baselineDelta, takeBaseline } from '../../lib/workspace/baseline.mjs'

process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[name]

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/workspace/baseline.mjs')

test('takeBaseline records the candidate files of a git project', async () => {
  const root = await gitRepo({ '.gitignore': 'build/\n', 'a.txt': 'alpha\n', 'src/b.py': 'print(1)\n' })
  await mkdir(join(root, 'build'))
  await writeFile(join(root, 'build', 'out.o'), 'obj')
  await writeFile(join(root, 'untracked.txt'), 'u')
  const baseline = await takeBaseline(root)
  assert.equal(baseline.v, 1)
  assert.equal(baseline.root, root)
  assert.equal(baseline.method, 'git')
  assert.equal(baseline.complete, true)
  assert.equal(baseline.truncated, false)
  assert.ok(!Number.isNaN(Date.parse(baseline.takenAt)))
  assert.deepEqual(Object.keys(baseline.files), ['.gitignore', 'a.txt', 'src/b.py', 'untracked.txt'])
  const [size, mtimeMs, digest] = baseline.files['a.txt']
  assert.equal(size, 6)
  assert.equal(typeof mtimeMs, 'number')
  assert.match(digest, /^[0-9a-f]{64}$/)
})

test('baselineDelta reports created, modified and deleted files since the task began', async () => {
  const root = await gitRepo({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'c.txt': 'gamma\n', 'd.txt': 'delta\n' })
  const baseline = { ...(await takeBaseline(root)), capturedAfterMs: 412.4 }
  assert.equal(await baselineDelta(baseline, root),
    'No file changes detected since this task began (baseline captured 412 ms after the task opened).')
  await writeFile(join(root, 'a.txt'), 'ALPHA\n') // same size: decided by the hash
  const c = await stat(join(root, 'c.txt'))
  await utimes(join(root, 'c.txt'), c.atime, new Date(c.mtimeMs + 5000)) // touched, identical content
  await rm(join(root, 'b.txt'))
  await writeFile(join(root, 'new.txt'), 'new\n')
  await writeFile(join(root, 'd.txt'), 'delta delta\n')
  assert.equal(await baselineDelta(baseline, root), [
    'FILE-CHANGE EVIDENCE since this task began (baseline captured 412 ms after the task opened):',
    'CREATED (1):', '  new.txt',
    'MODIFIED (2):', '  a.txt', '  d.txt',
    'DELETED (1):', '  b.txt',
  ].join('\n'))
  assert.equal(await baselineDelta({ ...baseline, capturedAfterMs: undefined }, root, { exclude: ['new.txt', 'a.txt', 'd.txt'] }), [
    'FILE-CHANGE EVIDENCE since this task began:',
    'DELETED (1):', '  b.txt',
  ].join('\n'))
  assert.equal(await baselineDelta({ ...baseline, complete: false }, root), '')
  assert.equal(await baselineDelta(null, root), '')
})

test('files above the hash limit are compared by size and time; truncated baselines stop at their last path', async () => {
  const root = await tmpDir()
  await writeFile(join(root, 'big.bin'), '')
  await truncate(join(root, 'big.bin'), 4096)
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(root, name), name)
  const baseline = await takeBaseline(root, { maxFiles: 3, hashLimitBytes: 1024 })
  assert.equal(baseline.method, 'walk')
  assert.equal(baseline.truncated, true)
  assert.deepEqual(Object.keys(baseline.files), ['a.txt', 'b.txt', 'big.bin'])
  assert.equal(baseline.files['big.bin'][2], null)
  const big = await stat(join(root, 'big.bin'))
  await utimes(join(root, 'big.bin'), big.atime, new Date(big.mtimeMs + 3000))
  await writeFile(join(root, 'e.txt'), 'beyond the cutoff')
  await writeFile(join(root, 'aa.txt'), 'inside the cutoff')
  const text = await baselineDelta(baseline, root)
  assert.equal(text, [
    'FILE-CHANGE EVIDENCE since this task began:',
    'CREATED (1):', '  aa.txt',
    'MODIFIED (1):', '  big.bin',
    '(The file listing was truncated; paths beyond it were not compared.)',
  ].join('\n'))
})

test('CLI: node lib/workspace/baseline.mjs <root> <outFile> <openedAtIso> writes the baseline atomically', async () => {
  const root = await gitRepo({ 'a.txt': 'alpha\n' })
  const out = join(await tmpDir(), 'sessions', 's1', 'baselines', 'b-3.json')
  const openedAt = new Date(Date.now() - 250).toISOString()
  const env = { ...process.env }
  const run = await runNode(CLI, [root, out, openedAt], { env })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.stdout, '')
  const written = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(written.complete, true)
  assert.equal(written.root, root)
  assert.equal(written.openedAt, openedAt)
  assert.ok(written.capturedAfterMs >= 250, String(written.capturedAfterMs))
  assert.deepEqual(Object.keys(written.files), ['a.txt'])
  assert.equal((await stat(out)).mode & 0o777, 0o600)
  assert.deepEqual((await readdir(dirname(out))).filter(name => name.endsWith('.tmp')), [])
  assert.match(await baselineDelta(written, root), /^No file changes detected since this task began \(baseline captured \d+ ms after the task opened\)\.$/)

  const usage = await runNode(CLI, [], { env })
  assert.equal(usage.code, 2)
  assert.match(usage.stderr, /usage: node lib\/workspace\/baseline\.mjs/)
  const missing = join(await tmpDir(), 'b.json')
  const failed = await runNode(CLI, [join(root, 'no-such-dir'), missing, openedAt], { env })
  assert.equal(failed.code, 0) // an absent root is an empty baseline, not an error
  assert.deepEqual(JSON.parse(await readFile(missing, 'utf8')).files, {})
  assert.equal(existsSync(missing), true)
})

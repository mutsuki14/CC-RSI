// Interactive checkpoint (SPEC §9.3, §15.3 WP3): restore never deletes pre-existing, ignored or
// unreadable files; displaced copies are kept; created files are moved, not deleted; detect-only above
// the caps without buffering; a persisted checkpoint is restorable by a new process. Ports dsh
// test/isolation.test.ts:23-80,173-185.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, truncate, utimes, writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runNode } from '../_helpers/spawn.mjs'
import { gitEnv, gitRepo, tmpDir, unprivilegedSkip } from '../_helpers/tmp.mjs'
import { Checkpoint } from '../../lib/workspace/checkpoint.mjs'
import { statusDigest } from '../../lib/workspace/git.mjs'

process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[name]

const here = dirname(fileURLToPath(import.meta.url))
const CHECKPOINT_URL = pathToFileURL(resolve(here, '../../lib/workspace/checkpoint.mjs')).href
const limits = { maxBytes: 1024 * 1024, maxFiles: 100 }

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()
}

async function harness() {
  const base = await tmpDir('cc-rsi-cp-')
  return { dir: join(base, 'checkpoints', 'j-1'), displaced: join(base, 'displaced', 'j-1'), base }
}

const read = path => readFile(path, 'utf8')

test('restores changed files, moves created ones aside and never touches pre-existing ignored files', async () => {
  const root = await gitRepo({ '.gitignore': 'secret.env\n', 'app.txt': 'original' })
  await writeFile(join(root, 'secret.env'), 'TOKEN=1')
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir, ...limits })
  assert.equal(checkpoint.method, 'git')
  assert.equal(checkpoint.detectOnly, false)
  assert.equal(checkpoint.root, root)
  await writeFile(join(root, 'app.txt'), 'mutated')
  await writeFile(join(root, 'stray.tmp'), 'debris')
  // The inspection rewrote .gitignore, so the pre-existing ignored file becomes visible: it must survive.
  await writeFile(join(root, '.gitignore'), '')
  assert.deepEqual(await checkpoint.compare(), { changed: ['.gitignore', 'app.txt'], created: ['secret.env', 'stray.tmp'], deleted: [] })
  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.restored, ['.gitignore', 'app.txt'])
  assert.deepEqual(result.displaced, ['.gitignore', 'app.txt', 'stray.tmp'])
  assert.deepEqual(result.kept, ['secret.env'])
  assert.deepEqual(result.skipped, [])
  assert.equal(await read(join(root, 'app.txt')), 'original')
  assert.equal(await read(join(root, '.gitignore')), 'secret.env\n')
  assert.equal(await read(join(root, 'secret.env')), 'TOKEN=1')
  assert.equal(existsSync(join(root, 'stray.tmp')), false)
  // Displaced copies hold the inspection's versions.
  assert.equal(await read(join(displaced, 'app.txt')), 'mutated')
  assert.equal(await read(join(displaced, 'stray.tmp')), 'debris')
  assert.equal(await read(join(displaced, '.gitignore')), '')
  assert.deepEqual(await checkpoint.compare(), { changed: [], created: [], deleted: [] })
  await checkpoint.dispose()
  assert.equal(existsSync(dir), false)
  await assert.rejects(checkpoint.restore({ displacedDir: displaced }), { code: 'checkpoint_disposed' })
})

test('restores deletions, types, modes and link targets; never writes through a linked parent', async () => {
  const root = await gitRepo({
    'src/a.txt': 'a', 'cfg/b.txt': 'b', 'run.sh': '#!/bin/sh\n', 'lib/x.txt': 'x', 'app.txt': 'app',
  })
  await chmod(join(root, 'run.sh'), 0o755)
  await symlink('app.txt', join(root, 'link'))
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'more')
  const outside = await tmpDir('cc-rsi-outside-')
  await writeFile(join(outside, 'keep.txt'), 'outside')
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir, ...limits })
  const before = await statusDigest(root)

  await rm(join(root, 'src', 'a.txt'))
  await rm(join(root, 'cfg'), { recursive: true })
  await writeFile(join(root, 'cfg'), 'now a file')
  await chmod(join(root, 'run.sh'), 0o644)
  await rm(join(root, 'lib'), { recursive: true })
  await symlink(outside, join(root, 'lib')) // lib/x.txt would land in `outside` if restore followed it
  await rm(join(root, 'link'))
  await symlink('/etc/passwd', join(root, 'link'))

  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.restored, ['cfg/b.txt', 'lib/x.txt', 'link', 'run.sh', 'src/a.txt'])
  assert.equal(await read(join(root, 'src', 'a.txt')), 'a')
  assert.equal(await read(join(root, 'cfg', 'b.txt')), 'b')
  assert.equal((await lstat(join(root, 'lib'))).isDirectory(), true)
  assert.equal(await read(join(root, 'lib', 'x.txt')), 'x')
  assert.deepEqual(await readdir(outside), ['keep.txt'])
  assert.equal((await stat(join(root, 'run.sh'))).mode & 0o777, 0o755)
  assert.equal(await readlink(join(root, 'link')), 'app.txt')
  // Everything that stood in the way was moved, not deleted.
  assert.equal(await read(join(displaced, 'cfg')), 'now a file')
  assert.equal(await readlink(join(displaced, 'lib')), outside)
  assert.equal(await readlink(join(displaced, 'link')), '/etc/passwd')
  assert.equal(await statusDigest(root), before)
  await checkpoint.dispose()
})

test('a fully restored inspection leaves statusDigest unchanged (verdict stays current)', async () => {
  const root = await gitRepo({ 'f.txt': 'committed\n', 'g.txt': 'g\n' })
  // The Actor's uncommitted work: a modified tracked file and an untracked file.
  await writeFile(join(root, 'f.txt'), 'actor work\n')
  await writeFile(join(root, 'new.txt'), 'actor new\n')
  const sd0 = await statusDigest(root)
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir, ...limits })
  await new Promise(r => setTimeout(r, 20))
  // The Verifier: same-size overwrite, a touch, a created file and a created build tree.
  await writeFile(join(root, 'f.txt'), 'ACTOR WORK\n')
  await utimes(join(root, 'new.txt'), new Date(), new Date(Date.now() + 3000))
  await writeFile(join(root, 'extra.txt'), 'scratch')
  await mkdir(join(root, 'build', 'obj'), { recursive: true })
  await writeFile(join(root, 'build', 'obj', 'out.o'), 'obj')
  assert.notEqual(await statusDigest(root), sd0)
  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.restored, ['f.txt'])
  assert.deepEqual(result.retimed, ['new.txt'])
  assert.ok(result.displaced.includes('extra.txt') && result.displaced.includes('build/obj/out.o'))
  assert.equal(await statusDigest(root), sd0)
  assert.equal(await read(join(root, 'f.txt')), 'actor work\n')
  assert.equal(existsSync(join(root, 'build')), false, 'the empty directories the inspection created are moved aside')
  assert.equal(await read(join(displaced, 'build', 'obj', 'out.o')), 'obj')
  assert.deepEqual(result.unstable, [])
  await checkpoint.dispose()
})

test('detect-only above the file cap: nothing is copied, changes are reported as skipped', async () => {
  const root = await tmpDir()
  for (let i = 0; i < 6; i++) await writeFile(join(root, `f${i}.txt`), 'x')
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir, maxBytes: 1024, maxFiles: 3 })
  assert.equal(checkpoint.detectOnly, true)
  assert.equal(checkpoint.method, 'walk')
  assert.deepEqual(await readdir(join(dir, 'files')), [])
  assert.deepEqual(await checkpoint.compare(), { changed: [], created: [], deleted: [] })
  await writeFile(join(root, 'f5.txt'), 'changed!')
  await writeFile(join(root, 'new.txt'), 'n')
  assert.deepEqual(await checkpoint.compare(), { changed: ['f5.txt'], created: ['new.txt'], deleted: [] })
  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.skipped, ['f5.txt', 'new.txt'])
  assert.deepEqual(result.restored, [])
  assert.deepEqual(result.displaced, [])
  assert.equal(await read(join(root, 'f5.txt')), 'changed!')
  assert.equal(existsSync(join(root, 'new.txt')), true)
  const persisted = JSON.parse(await read(join(dir, 'entries.json')))
  assert.equal(persisted.entries['f0.txt'].sha256, null)
})

test('detect-only above the byte cap never reads the large file', async () => {
  const root = await tmpDir()
  await writeFile(join(root, 'small.txt'), 'x')
  await writeFile(join(root, 'huge.bin'), '')
  await truncate(join(root, 'huge.bin'), 3 * 1024 * 1024 * 1024) // sparse: reading it would take seconds
  const { dir } = await harness()
  const started = Date.now()
  const checkpoint = await Checkpoint.take(root, { dir, ...limits })
  assert.equal(checkpoint.detectOnly, true)
  assert.deepEqual(await checkpoint.compare(), { changed: [], created: [], deleted: [] })
  assert.ok(Date.now() - started < 3000, 'detect-only must not read file contents')
  assert.deepEqual(await readdir(join(dir, 'files')), [])
  await checkpoint.dispose()
  await rm(join(root, 'huge.bin'))
})

test('a persisted checkpoint is restorable by a new process', async () => {
  const root = await gitRepo({ 'a.txt': 'one\n', 'b/c.txt': 'two\n' })
  const { dir, displaced } = await harness()
  const env = { ...process.env, CP_ARGS: JSON.stringify({ root, dir, displaced }) }
  const take = await runNode('--input-type=module', ['-e', `
    import { Checkpoint } from ${JSON.stringify(CHECKPOINT_URL)}
    const { root, dir } = JSON.parse(process.env.CP_ARGS)
    const cp = await Checkpoint.take(root, { dir })
    process.stdout.write(JSON.stringify({ fp: cp.fingerprint(), method: cp.method }))
  `], { env })
  assert.equal(take.code, 0, take.stderr)
  const taken = JSON.parse(take.stdout)
  // The process that took it is gone; the inspection changed things.
  await writeFile(join(root, 'a.txt'), 'verifier\n')
  await rm(join(root, 'b'), { recursive: true })
  await writeFile(join(root, 'created.txt'), 'c')
  const restore = await runNode('--input-type=module', ['-e', `
    import { Checkpoint } from ${JSON.stringify(CHECKPOINT_URL)}
    const { dir, displaced } = JSON.parse(process.env.CP_ARGS)
    const cp = await Checkpoint.load(dir)
    const result = await cp.restore({ displacedDir: displaced })
    process.stdout.write(JSON.stringify({ fp: cp.fingerprint(), result }))
    await cp.dispose()
  `], { env })
  assert.equal(restore.code, 0, restore.stderr)
  const { fp, result } = JSON.parse(restore.stdout)
  assert.equal(fp, taken.fp)
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.restored, ['a.txt', 'b/c.txt'])
  assert.deepEqual(result.displaced, ['a.txt', 'created.txt'])
  assert.equal(await read(join(root, 'a.txt')), 'one\n')
  assert.equal(await read(join(root, 'b', 'c.txt')), 'two\n')
  assert.equal(await read(join(displaced, 'created.txt')), 'c')
  assert.equal(existsSync(dir), false)
})

test('entries.json has the specified shape; fingerprint and manifest are stable', async () => {
  const root = await gitRepo({ 'a.txt': 'alpha\n', 'd/b.txt': 'beta\n' })
  const one = await harness()
  const two = await harness()
  const first = await Checkpoint.take(root, { dir: one.dir })
  const second = await Checkpoint.take(root, { dir: two.dir })
  assert.equal(first.fingerprint(), second.fingerprint())
  assert.match(first.fingerprint(), /^[0-9a-f]{64}$/)
  const manifest = first.manifest()
  assert.deepEqual(Object.keys(manifest), ['a.txt', 'd/b.txt'])
  assert.equal(manifest['a.txt'].size, 6)
  assert.equal(manifest['a.txt'].mode, 0o644)
  assert.match(manifest['a.txt'].sha256, /^[0-9a-f]{64}$/)
  const persisted = JSON.parse(await read(join(one.dir, 'entries.json')))
  assert.equal(persisted.v, 1)
  assert.equal(persisted.root, root)
  assert.equal(persisted.method, 'git')
  assert.equal(persisted.detectOnly, false)
  assert.ok(!Number.isNaN(Date.parse(persisted.takenAt)))
  assert.deepEqual(persisted.blocked, [])
  assert.deepEqual(persisted.ignoredDirs, [])
  for (const key of ['size', 'mtimeMs', 'mode', 'sha256']) assert.ok(key in persisted.entries['a.txt'], key)
  assert.equal(await read(join(one.dir, 'files', 'd', 'b.txt')), 'beta\n')
  await writeFile(join(root, 'a.txt'), 'ALPHA\n')
  const third = await Checkpoint.take(root, { dir: (await harness()).dir })
  assert.notEqual(third.fingerprint(), first.fingerprint())
  // A checkpoint is never overwritten; load errors are typed.
  await assert.rejects(Checkpoint.take(root, { dir: one.dir }), { code: 'checkpoint_exists' })
  await assert.rejects(Checkpoint.load(join(one.base, 'nothing-here')), { code: 'checkpoint_missing' })
  const tampered = JSON.parse(await read(join(two.dir, 'entries.json')))
  tampered.entries['../escape.txt'] = tampered.entries['a.txt']
  await writeFile(join(two.dir, 'entries.json'), JSON.stringify(tampered))
  await assert.rejects(Checkpoint.load(two.dir), { code: 'checkpoint_corrupt' })
  await assert.rejects(Checkpoint.take(root, {}), { code: 'checkpoint_dir_required' })
})

test('walk method outside git: dependency dirs and .git are never entered; exclude is honoured', async () => {
  const root = await tmpDir()
  await writeFile(join(root, 'main.py'), 'print(1)\n')
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
  await mkdir(join(root, 'state'))
  await writeFile(join(root, 'state', 'harness.json'), '{}')
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir, exclude: ['state'] })
  assert.equal(checkpoint.method, 'walk')
  assert.deepEqual(Object.keys(checkpoint.manifest()), ['main.py'])
  await writeFile(join(root, 'node_modules', 'pkg', 'new.js'), 'y')
  await writeFile(join(root, 'state', 'harness.json'), '{"changed":true}')
  await writeFile(join(root, 'main.py'), 'print(2)\n')
  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.restored, ['main.py'])
  assert.deepEqual(result.displaced, ['main.py'])
  assert.equal(await read(join(root, 'node_modules', 'pkg', 'new.js')), 'y')
  assert.equal(await read(join(root, 'state', 'harness.json')), '{"changed":true}')
})

test('files under a pre-existing ignored directory are kept even when the inspection un-ignores it', async () => {
  const root = await gitRepo({ '.gitignore': 'cache/\n', 'a.txt': 'a' })
  await mkdir(join(root, 'cache'))
  await writeFile(join(root, 'cache', 'old.bin'), 'old')
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir })
  await writeFile(join(root, 'cache', 'new.bin'), 'new')
  await writeFile(join(root, '.gitignore'), '')
  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.kept, ['cache/new.bin', 'cache/old.bin'])
  assert.equal(await read(join(root, 'cache', 'old.bin')), 'old')
  assert.equal(await read(join(root, 'cache', 'new.bin')), 'new')
})

test('restore is idempotent and never overwrites earlier displaced copies', async () => {
  const root = await gitRepo({ 'a.txt': 'a' })
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir })
  await writeFile(join(root, 'stray.txt'), 'first')
  await checkpoint.restore({ displacedDir: displaced })
  await writeFile(join(root, 'stray.txt'), 'second')
  // A staging leftover of an interrupted restore is moved aside like any other created file.
  await writeFile(join(root, 'a.txt.cc-rsi-restore'), 'leftover')
  const again = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(again.failed, [])
  assert.deepEqual(again.displaced, ['a.txt.cc-rsi-restore', 'stray.txt'])
  assert.equal(await read(join(displaced, 'stray.txt')), 'first')
  assert.equal(await read(join(displaced, '.cc-rsi-1', 'stray.txt')), 'second')
  const third = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(third, { restored: [], displaced: [], failed: [], skipped: [], retimed: [], kept: [], unstable: [] })
})

test('a candidate root replaced by a link is a restore failure (fail closed)', async () => {
  const base = await tmpDir()
  const root = join(base, 'root')
  await mkdir(root)
  await writeFile(join(root, 'a.txt'), 'a')
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir })
  await rm(root, { recursive: true })
  await mkdir(join(base, 'elsewhere'))
  await symlink(join(base, 'elsewhere'), root)
  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.failed.map(f => f.path), ['.'])
  assert.deepEqual(await readdir(join(base, 'elsewhere')), [])
})

test('a symlinked candidate root is checkpointed and restored at its real location', async () => {
  const real = await gitRepo({ 'a.txt': 'a' })
  const base = await tmpDir()
  const linked = join(base, 'project-link')
  await symlink(real, linked)
  const { dir, displaced } = await harness()
  const checkpoint = await Checkpoint.take(linked, { dir, exclude: [join(linked, 'skip.txt')] })
  assert.equal(checkpoint.root, real)
  await writeFile(join(real, 'a.txt'), 'changed')
  await writeFile(join(real, 'skip.txt'), 'excluded by an absolute path under the linked root')
  const result = await checkpoint.restore({ displacedDir: displaced })
  assert.deepEqual(result.restored, ['a.txt'])
  assert.deepEqual(result.displaced, ['a.txt'])
  assert.equal(await read(join(real, 'a.txt')), 'a')
  assert.equal(await read(join(real, 'skip.txt')), 'excluded by an absolute path under the linked root')
})

test('checkpoint and displaced dirs inside the root are never candidates; partial takes are cleared', async () => {
  const root = await tmpDir()
  await writeFile(join(root, 'a.txt'), 'a')
  const dir = join(root, '.harness', 'cp')
  // Leftovers of a take that died before entries.json are cleared, not an error.
  await mkdir(join(dir, 'files'), { recursive: true })
  await writeFile(join(dir, 'files', 'junk'), 'junk')
  const checkpoint = await Checkpoint.take(root, { dir })
  assert.deepEqual(Object.keys(checkpoint.manifest()), ['a.txt'])
  await writeFile(join(root, 'a.txt'), 'changed')
  await writeFile(join(root, 'created.txt'), 'c')
  const result = await checkpoint.restore({ displacedDir: join(root, '.harness', 'displaced') })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.displaced, ['a.txt', 'created.txt'])
  assert.deepEqual(result.unstable, [])
  assert.equal(await read(join(root, 'a.txt')), 'a')
  assert.equal(await read(join(root, '.harness', 'displaced', 'created.txt')), 'c')
  assert.equal(existsSync(join(dir, 'entries.json')), true)
  await Checkpoint.discard(dir)
  assert.equal(existsSync(dir), false)
})

/** Runs an ES module source as an unprivileged user (uid 65534 when we are root). */
function runUnprivileged(source, { env, cwd }) {
  return new Promise((resolvePromise, reject) => {
    const asRoot = process.getuid?.() === 0
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...(asRoot ? { uid: 65534, gid: 65534 } : {}),
    })
    const out = []
    const err = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => resolvePromise({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }))
  })
}

async function unprivilegedBase() {
  const base = await tmpDir('cc-rsi-unpriv-')
  if (process.getuid?.() === 0) await chown(base, 65534, 65534)
  return base
}

test('never deletes or displaces files of a directory it could not read when the checkpoint was taken', { skip: unprivilegedSkip() }, async () => {
  const base = await unprivilegedBase()
  const env = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', BASE: base }
  const run = await runUnprivileged(`
    import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { Checkpoint } from ${JSON.stringify(CHECKPOINT_URL)}
    const base = process.env.BASE
    const root = join(base, 'root')
    await mkdir(join(root, 'vol'), { recursive: true })
    await writeFile(join(root, 'vol', 'data'), 'user data')
    await writeFile(join(root, 'locked.txt'), 'secret')
    await writeFile(join(root, 'plain.txt'), 'plain')
    await chmod(join(root, 'vol'), 0)
    await chmod(join(root, 'locked.txt'), 0)
    const cp = await Checkpoint.take(root, { dir: join(base, 'cp') })
    const compareLocked = await cp.compare()
    await chmod(join(root, 'vol'), 0o755)
    await chmod(join(root, 'locked.txt'), 0o644)
    const result = await cp.restore({ displacedDir: join(base, 'displaced') })
    const data = await readFile(join(root, 'vol', 'data'), 'utf8')
    process.stdout.write(JSON.stringify({ compareLocked, result, data, blocked: JSON.parse(await readFile(join(base, 'cp', 'entries.json'), 'utf8')).blocked }))
  `, { env, cwd: base })
  assert.equal(run.code, 0, run.stderr)
  const { compareLocked, result, data, blocked } = JSON.parse(run.stdout)
  assert.deepEqual(compareLocked, { changed: [], created: [], deleted: [] })
  assert.deepEqual(blocked, ['locked.txt', 'vol/'])
  assert.equal(data, 'user data')
  assert.deepEqual(result.kept, ['vol/data'])
  // locked.txt was tracked without a copy; its mode changed back, which is a change it cannot restore.
  assert.deepEqual(result.failed.map(f => f.path), ['locked.txt'])
  assert.deepEqual(result.displaced, [])
})

test('tolerates ordinary workspace states: a tracked directory replaced by a file, unreadable files', { skip: unprivilegedSkip() }, async () => {
  const base = await unprivilegedBase()
  const env = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', BASE: base }
  const run = await runUnprivileged(`
    import { execFileSync } from 'node:child_process'
    import { mkdir, writeFile, chmod, rm } from 'node:fs/promises'
    import { join } from 'node:path'
    import { Checkpoint } from ${JSON.stringify(CHECKPOINT_URL)}
    const root = join(process.env.BASE, 'repo')
    await mkdir(join(root, 'cfg'), { recursive: true })
    const git = (...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' })
    git('init', '-q')
    await writeFile(join(root, 'cfg', 'a.txt'), 'a')
    git('add', '.')
    git('commit', '-qm', 'init')
    await rm(join(root, 'cfg'), { recursive: true })
    await writeFile(join(root, 'cfg'), 'now a file')
    await writeFile(join(root, 'locked.txt'), 'x')
    await chmod(join(root, 'locked.txt'), 0)
    const cp = await Checkpoint.take(root, { dir: join(process.env.BASE, 'cp') })
    const compare = await cp.compare()
    await cp.dispose()
    await chmod(join(root, 'locked.txt'), 0o644)
    process.stdout.write(JSON.stringify({ compare, method: cp.method }))
  `, { env, cwd: base })
  assert.equal(run.code, 0, run.stderr)
  const { compare, method } = JSON.parse(run.stdout)
  assert.equal(method, 'git')
  assert.deepEqual(compare, { changed: [], created: [], deleted: [] })
})

test('restore never destroys a file something outside the inspection creates while it is put back (memory-crash-6)', async () => {
  const base = await tmpDir('cc-rsi-cp-race-')
  const root = join(base, 'ws')
  await mkdir(root)
  await writeFile(join(root, 'f.txt'), 'ORIGINAL\n')
  const checkpoint = await Checkpoint.take(root, { dir: join(base, 'cp'), ...limits })
  const kept = join(base, 'kept')
  await mkdir(kept)
  const displaced = join(base, 'displaced')
  const log = join(base, 'writes.log')
  const stopFile = join(base, 'stop')
  await writeFile(log, '')
  await rename(join(root, 'f.txt'), join(kept, 'original'))
  // An editor autosave or a dev server: it creates f.txt (never replacing it) whenever it is absent.
  const writer = spawn(process.execPath, ['-e', `
    const fs = require('node:fs')
    const [file, log, stop] = process.argv.slice(1)
    let n = 0
    while (!fs.existsSync(stop)) {
      try {
        const fd = fs.openSync(file, 'wx')
        const id = 'W' + n++
        fs.writeSync(fd, id + '\\n')
        fs.closeSync(fd)
        fs.appendFileSync(log, id + '\\n')
      } catch {}
    }`, join(root, 'f.txt'), log, stopFile], { stdio: 'ignore' })
  const exited = new Promise(resolvePromise => writer.once('exit', resolvePromise))
  try {
    for (let round = 0; round < 60; round++) {
      while (!existsSync(join(root, 'f.txt'))) await new Promise(resolvePromise => setImmediate(resolvePromise))
      await checkpoint.restore({ displacedDir: displaced })
      // The harness moves whatever is now at f.txt aside, so the next round starts from a new write.
      await rename(join(root, 'f.txt'), join(kept, `r${round}`)).catch(() => undefined)
    }
  } finally {
    await writeFile(stopFile, '')
    await exited
  }
  const contents = async dir => {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...await contents(full))
      else out.push((await readFile(full, 'utf8')).trim())
    }
    return out
  }
  const found = new Set([...await contents(kept), ...await contents(displaced), ...await contents(root)])
  const written = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean)
  assert.ok(written.length >= 60)
  assert.deepEqual(written.filter(id => !found.has(id)), [], 'every outside write is in the workspace or the displaced dir')
  assert.equal(found.has('ORIGINAL'), true)
  const leftovers = (await readdir(root)).filter(name => name.includes('cc-rsi-restore'))
  assert.deepEqual(leftovers, [], 'no staging file is left in the workspace')
})

test('a displacement onto another filesystem copies, then removes the unchanged source and no tombstone (memory-crash-6)', async t => {
  const otherFs = '/dev/shm'
  let other = null
  try {
    if (existsSync(otherFs) && (await stat(otherFs)).dev !== (await stat(await tmpDir())).dev) other = otherFs
  } catch {
    other = null
  }
  if (other === null) {
    t.skip('no second filesystem (/dev/shm) to displace onto')
    return
  }
  const root = await tmpDir()
  await writeFile(join(root, 'kept.txt'), 'kept')
  const { dir } = await harness()
  const checkpoint = await Checkpoint.take(root, { dir, ...limits })
  await mkdir(join(root, 'made', 'deep'), { recursive: true })
  await writeFile(join(root, 'made', 'deep', 'new.txt'), 'created by the inspection')
  await writeFile(join(root, 'kept.txt'), 'changed by the inspection')
  const displaced = await mkdtemp(join(other, 'cc-rsi-displaced-'))
  try {
    const result = await checkpoint.restore({ displacedDir: displaced })
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.restored, ['kept.txt'])
    assert.equal(await read(join(root, 'kept.txt')), 'kept')
    assert.equal(await read(join(displaced, 'kept.txt')), 'changed by the inspection')
    assert.equal(await read(join(displaced, 'made', 'deep', 'new.txt')), 'created by the inspection')
    assert.equal(existsSync(join(root, 'made', 'deep', 'new.txt')), false)
    const names = await readdir(root, { recursive: true })
    assert.deepEqual(names.filter(name => name.includes('.cc-rsi-')), [], 'no tombstone or staging file remains')
  } finally {
    await rm(displaced, { recursive: true, force: true })
  }
})

test('outside git the walk refuses the home directory and fails closed above its bound (portability-11)', async () => {
  const root = await tmpDir()
  for (let i = 0; i < 60; i++) await writeFile(join(root, `f${String(i).padStart(2, '0')}.txt`), 'x')
  const { dir } = await harness()
  const started = Date.now()
  await assert.rejects(Checkpoint.take(root, { dir, maxFiles: 10, walkMaxFiles: 20 }), err => {
    assert.equal(err.code, 'checkpoint_failed')
    assert.match(err.message, /more than 20 files outside git/)
    return true
  })
  assert.ok(Date.now() - started < 5000)
  assert.equal(existsSync(join(dir, 'entries.json')), false)
  // Within the bound: detect-only above maxFiles, as before.
  const checkpoint = await Checkpoint.take(root, { dir, maxFiles: 10, walkMaxFiles: 100 })
  assert.equal(checkpoint.detectOnly, true)
  assert.equal(Object.keys(checkpoint.manifest()).length, 60)
  await checkpoint.dispose()
  // A project opened in the home directory itself (not a git repository) is never walked.
  const home = process.env.HOME
  process.env.HOME = root
  try {
    await assert.rejects(Checkpoint.take(root, { dir, ...limits }), err => err.code === 'checkpoint_failed' && /your home directory/.test(err.message))
  } finally {
    if (home === undefined) delete process.env.HOME
    else process.env.HOME = home
  }
})

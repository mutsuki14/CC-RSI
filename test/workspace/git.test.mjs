// Safe git (SPEC §9.2, §15.3 WP3): repository-planted programs never run; system/global settings
// (safe.directory, drivers) are honoured; statusDigest; projectRoot across worktrees; ported from dsh
// test/isolation.test.ts:82-106,148-171.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { gitEnv, gitRepo, tmpDir } from '../_helpers/tmp.mjs'
import { Checkpoint } from '../../lib/workspace/checkpoint.mjs'
import { baselineDelta, takeBaseline } from '../../lib/workspace/baseline.mjs'
import {
  driverOverrides, gitTopLevel, initInertRepo, lsFiles, projectRoot, safeGit, statusDigest, workspaceFacts,
} from '../../lib/workspace/git.mjs'

// Hermetic: the machine's system and global git configuration never reach these tests.
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_SYSTEM']) delete process.env[name]

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()
}

/** Plain git as an unprotected caller would run it (the control that proves a plant is live). */
function plainGit(cwd, ...args) {
  try {
    execFileSync('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })
  } catch {
    // A broken planted filter may make git fail; whether the program ran is what matters.
  }
}

/** Every lib/workspace entry point that runs git, against `repo` (scratch dirs under `scratch`). */
async function exerciseAll(repo, scratch) {
  assert.ok(await safeGit(repo, ['status']))
  // Diff-family commands need --no-ext-diff --no-textconv: without them git tries to run the
  // neutralised (empty) program and fails; it never runs a planted one.
  await safeGit(repo, ['diff', 'HEAD'])
  assert.ok(await safeGit(repo, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']))
  assert.ok(await safeGit(repo, ['diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD']))
  assert.ok(await safeGit(repo, ['log', '--no-ext-diff', '--no-textconv', '-p', '-1']))
  const facts = await workspaceFacts(repo)
  assert.equal(facts.git, true, facts.text)
  assert.match(facts.text, /M a\.txt/)
  assert.equal(typeof (await statusDigest(repo)), 'string')
  assert.ok((await lsFiles(repo)).files.includes('a.txt'))
  assert.equal(await gitTopLevel(repo), repo)
  assert.equal(await projectRoot(repo), repo)
  const checkpoint = await Checkpoint.take(repo, { dir: join(scratch, 'cp') })
  assert.equal(checkpoint.method, 'git')
  await writeFile(join(repo, 'b.txt'), 'verifier edit\n')
  await checkpoint.compare()
  assert.deepEqual((await checkpoint.restore({ displacedDir: join(scratch, 'displaced') })).failed, [])
  await checkpoint.dispose()
  await baselineDelta(await takeBaseline(repo), repo)
  // Index writes: hooks (post-index-change) and clean filters would fire here if not disabled.
  assert.ok(await safeGit(repo, ['add', 'a.txt']))
  await safeGit(repo, ['update-index', '-q', '--refresh'])
}

/**
 * One planted program per vector, each in a fresh repository. `setup` plants it; `control` runs
 * unprotected git that is known to execute it, so every plant is proven live before the check.
 */
const PLANTS = [
  {
    name: 'core.fsmonitor',
    setup: (repo, evil) => git(repo, 'config', 'core.fsmonitor', evil),
    control: repo => plainGit(repo, 'status'),
  },
  {
    name: 'filter clean',
    setup: async (repo, evil) => { git(repo, 'config', 'filter.x.clean', evil); await writeFile(join(repo, '.gitattributes'), '* filter=x\n') },
    control: repo => plainGit(repo, 'diff'),
  },
  {
    name: 'filter process (required)',
    setup: async (repo, evil) => {
      git(repo, 'config', 'filter.x.process', evil)
      git(repo, 'config', 'filter.x.required', 'true')
      await writeFile(join(repo, '.gitattributes'), '* filter=x\n')
    },
    control: repo => plainGit(repo, 'diff'),
  },
  {
    name: 'filter smudge',
    setup: async (repo, evil) => {
      git(repo, 'config', 'filter.x.smudge', evil)
      await mkdir(join(repo, '.git', 'info'), { recursive: true })
      await writeFile(join(repo, '.git', 'info', 'attributes'), '* filter=x\n')
    },
    control: async repo => {
      const keep = await readFile(join(repo, 'a.txt'))
      plainGit(repo, 'checkout', '--', 'a.txt')
      await writeFile(join(repo, 'a.txt'), keep)
    },
  },
  {
    name: 'diff driver command',
    setup: async (repo, evil) => { git(repo, 'config', 'diff.y.command', evil); await writeFile(join(repo, '.gitattributes'), '* diff=y\n') },
    control: repo => plainGit(repo, 'diff'),
  },
  {
    name: 'diff driver textconv',
    setup: async (repo, evil) => { git(repo, 'config', 'diff.y.textconv', evil); await writeFile(join(repo, '.gitattributes'), '* diff=y\n') },
    control: repo => plainGit(repo, 'diff', '--no-ext-diff'),
  },
  {
    name: 'diff.external',
    setup: (repo, evil) => git(repo, 'config', 'diff.external', evil),
    control: repo => plainGit(repo, 'diff'),
  },
  {
    name: 'GIT_EXTERNAL_DIFF in the caller environment',
    setup: (repo, evil) => { process.env.GIT_EXTERNAL_DIFF = evil },
    control: repo => plainGit(repo, 'diff'),
    teardown: () => { delete process.env.GIT_EXTERNAL_DIFF },
  },
  {
    name: 'hooks (.git/hooks and a planted core.hooksPath)',
    setup: async (repo, evil, dir) => {
      await mkdir(join(repo, '.git', 'hooks'), { recursive: true })
      const hooks = join(dir, 'evil-hooks')
      await mkdir(hooks, { recursive: true })
      for (const name of ['post-index-change', 'reference-transaction', 'pre-commit', 'post-checkout', 'pre-auto-gc']) {
        await writeFile(join(hooks, name), `#!/bin/sh\nexec '${evil}' hook-${name}\n`)
        await chmod(join(hooks, name), 0o755)
      }
      await writeFile(join(repo, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\nexec '${evil}' local-hook\n`)
      await chmod(join(repo, '.git', 'hooks', 'post-index-change'), 0o755)
      git(repo, 'config', 'core.hooksPath', hooks)
    },
    control: repo => {
      plainGit(repo, 'add', 'a.txt')
      plainGit(repo, '-c', 'core.hooksPath=/dev/null', 'reset', '-q')
    },
  },
]

for (const plantCase of PLANTS) {
  test(`repository-planted ${plantCase.name} never runs`, async () => {
    const repo = await gitRepo({ 'a.txt': 'hi\n', 'b.txt': 'second\n' })
    const dir = await tmpDir('cc-rsi-plant-')
    const marker = join(dir, 'planted-ran.log')
    const evil = join(dir, 'evil.sh')
    // A filter must echo its input; the marker records every invocation.
    await writeFile(evil, `#!/bin/sh\necho "ran $*" >> '${marker}'\ncat\n`)
    await chmod(evil, 0o755)
    try {
      await plantCase.setup(repo, evil, dir)
      await writeFile(join(repo, 'a.txt'), 'changed content\n')
      await writeFile(join(repo, 'c.txt'), 'untracked\n')
      await plantCase.control(repo)
      assert.equal(existsSync(marker), true, `control: unprotected git must run the planted ${plantCase.name}`)
      await rm(marker, { force: true })
      await writeFile(join(repo, 'a.txt'), 'changed again\n')
      await exerciseAll(repo, dir)
      assert.equal(existsSync(marker), false, `planted program ran: ${existsSync(marker) ? await readFile(marker, 'utf8') : ''}`)
    } finally {
      plantCase.teardown?.()
    }
  })
}

test('a partial clone never lazily fetches through a repository-configured transport', async () => {
  const src = await gitRepo({ 'a.txt': 'one\n' })
  git(src, 'config', 'uploadpack.allowFilter', 'true')
  const parent = await tmpDir('cc-rsi-partial-')
  const clone = join(parent, 'clone')
  git(parent, '-c', 'protocol.file.allow=always', 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${src}`, clone)
  const plantDir = await tmpDir('cc-rsi-plant-')
  const marker = join(plantDir, 'planted-ran.log')
  const evil = join(plantDir, 'evil-ssh.sh')
  await writeFile(evil, `#!/bin/sh\necho "ssh $*" >> '${marker}'\nexit 1\n`)
  await chmod(evil, 0o755)
  git(clone, 'config', 'core.sshCommand', evil)
  git(clone, 'config', 'remote.origin.url', 'ssh://example.invalid/repo.git')
  await writeFile(join(clone, 'a.txt'), 'two\n')
  // Control: unprotected git needs the missing blob and runs the planted ssh command.
  plainGit(clone, 'diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD')
  assert.match(await readFile(marker, 'utf8'), /example\.invalid/)
  await rm(marker, { force: true })
  await workspaceFacts(clone)
  await safeGit(clone, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'])
  await safeGit(clone, ['show', '--no-ext-diff', '--no-textconv', 'HEAD:a.txt'])
  await statusDigest(clone)
  assert.equal(existsSync(marker), false)
})

test('driverOverrides neutralises repository drivers and keeps system and global ones', async () => {
  const repo = await gitRepo({ 'a.txt': 'x\n' })
  const dir = await tmpDir()
  const system = join(dir, 'system.gitconfig')
  const global = join(dir, 'global.gitconfig')
  await writeFile(system, '[filter "sys"]\n\tclean = cat\n[diff "sysdiff"]\n\ttextconv = cat\n')
  await writeFile(global, '[filter "glob"]\n\tprocess = cat\n')
  git(repo, 'config', 'filter.loc.clean', 'cat')
  git(repo, 'config', 'diff.Loc2.textconv', 'cat')
  const saved = { ...process.env }
  delete process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_SYSTEM = system
  process.env.GIT_CONFIG_GLOBAL = global
  try {
    const overrides = await driverOverrides(repo)
    assert.ok(Array.isArray(overrides))
    const pairs = overrides.filter((_, i) => i % 2 === 1)
    assert.ok(overrides.every((item, i) => (i % 2 === 0 ? item === '-c' : true)))
    assert.deepEqual(pairs, [
      'filter.loc.clean=', 'filter.loc.smudge=', 'filter.loc.process=', 'filter.loc.required=false',
      'diff.Loc2.command=', 'diff.Loc2.textconv=',
    ])
  } finally {
    process.env = saved
  }
  assert.deepEqual(await driverOverrides(await gitRepo({ 'b.txt': 'y' })), [])
})

test('git is not run at all when the repository configuration cannot be read or overridden', async () => {
  const broken = await gitRepo({ 'a.txt': 'x\n' })
  await writeFile(join(broken, 'a.txt'), 'y\n')
  await writeFile(join(broken, '.git', 'config'), '[core\n\tbroken')
  assert.equal(await driverOverrides(broken), undefined)
  assert.equal(await safeGit(broken, ['status']), undefined)
  assert.equal((await workspaceFacts(broken)).git, false)
  assert.equal(await statusDigest(broken), null)
  assert.equal(await lsFiles(broken), undefined)

  // A driver name containing '=' cannot be neutralised with -c: fail closed.
  const tricky = await gitRepo({ 'a.txt': 'x\n' })
  await writeFile(join(tricky, '.git', 'config'), `${await readFile(join(tricky, '.git', 'config'), 'utf8')}[filter "a=b"]\n\tclean = cat\n`)
  assert.equal(await driverOverrides(tricky), undefined)
  assert.equal(await safeGit(tricky, ['status']), undefined)
})

test('system-scope safe.directory is honoured (repository owned by another user)', { skip: process.getuid?.() !== 0 ? 'needs root to chown' : false }, async () => {
  const repo = await gitRepo({ 'a.txt': 'x\n' })
  await writeFile(join(repo, 'a.txt'), 'changed\n')
  execFileSync('chown', ['-R', '65534:65534', repo])
  const dir = await tmpDir()
  const system = join(dir, 'system.gitconfig')
  await writeFile(system, '[safe]\n\tdirectory = *\n')
  // Without it git refuses the repository ("dubious ownership"): capture is unavailable.
  assert.equal((await workspaceFacts(repo)).git, false)
  const saved = { ...process.env }
  delete process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_SYSTEM = system
  try {
    const facts = await workspaceFacts(repo)
    assert.equal(facts.git, true)
    assert.match(facts.text, / M a\.txt/)
    assert.equal(typeof (await statusDigest(repo)), 'string')
  } finally {
    process.env = saved
  }
})

test('statusDigest: stable, changes on a same-size edit (mtime), honours exclude, null outside git', async () => {
  const repo = await gitRepo({ 'a.txt': 'aaaa\n', 'sub/b.txt': 'bbbb\n' })
  await writeFile(join(repo, 'a.txt'), 'AAAA\n')
  await writeFile(join(repo, 'new.txt'), 'new\n')
  const first = await statusDigest(repo)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(await statusDigest(repo), first)
  // Same size, same porcelain line: only the content (and its mtime) differ.
  const before = await stat(join(repo, 'a.txt'))
  await writeFile(join(repo, 'a.txt'), 'ZZZZ\n')
  await utimes(join(repo, 'a.txt'), before.atime, new Date(before.mtimeMs + 1500))
  const second = await statusDigest(repo)
  assert.notEqual(second, first)
  // Untracked file mtime is covered as well.
  await utimes(join(repo, 'new.txt'), new Date(), new Date(Date.now() + 5000))
  assert.notEqual(await statusDigest(repo), second)
  // Excluded paths do not count.
  const third = await statusDigest(repo, { exclude: ['new.txt'] })
  await writeFile(join(repo, 'new.txt'), 'newer content\n')
  assert.equal(await statusDigest(repo, { exclude: ['new.txt'] }), third)
  // A sub-directory root: porcelain paths are top-level relative and still resolved correctly.
  const subFirst = await statusDigest(join(repo, 'sub'))
  await writeFile(join(repo, 'sub', 'b.txt'), 'BBBB\n')
  const subSecond = await statusDigest(join(repo, 'sub'))
  assert.notEqual(subSecond, subFirst)
  const b = await stat(join(repo, 'sub', 'b.txt'))
  await utimes(join(repo, 'sub', 'b.txt'), b.atime, new Date(b.mtimeMs + 2000))
  assert.notEqual(await statusDigest(join(repo, 'sub')), subSecond)
  // Outside git, or a missing directory: null.
  assert.equal(await statusDigest(await tmpDir()), null)
  assert.equal(await statusDigest(join(repo, 'does-not-exist')), null)
})

test('projectRoot is shared by worktrees and sub-directories; submodules and non-git dirs fall back', async () => {
  const main = await gitRepo({ 'a.txt': 'x\n', 'src/b.txt': 'y\n' })
  const parent = await tmpDir()
  const wt = join(parent, 'wt')
  git(main, 'worktree', 'add', '-q', wt)
  assert.equal(await projectRoot(main), main)
  assert.equal(await projectRoot(join(main, 'src')), main)
  assert.equal(await projectRoot(wt), main)
  assert.equal(await gitTopLevel(wt), await realpath(wt))
  assert.equal(await gitTopLevel(join(main, 'src')), main)

  const plain = await tmpDir()
  await mkdir(join(plain, 'deep'))
  assert.equal(await projectRoot(join(plain, 'deep')), join(plain, 'deep'))
  assert.equal(await gitTopLevel(plain), null)
  assert.equal(await projectRoot(join(plain, 'missing')), join(plain, 'missing'))

  // A submodule's common dir lives in the superproject's .git/modules: its own top level is the root.
  const lib = await gitRepo({ 'lib.txt': 'lib\n' })
  git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
  assert.equal(await projectRoot(join(main, 'vendor', 'lib')), join(main, 'vendor', 'lib'))
})

test('lsFiles lists tracked and untracked candidates, ignored entries, nested repositories; honours exclude', async () => {
  const repo = await gitRepo({ '.gitignore': 'build/\n*.log\n', 'a.txt': 'x\n', 'keep/b.txt': 'y\n' })
  await mkdir(join(repo, 'build'))
  await writeFile(join(repo, 'build', 'out.o'), 'o')
  await writeFile(join(repo, 'debug.log'), 'l')
  await writeFile(join(repo, 'new.txt'), 'n')
  await mkdir(join(repo, 'harness'))
  await writeFile(join(repo, 'harness', 'state.json'), '{}')
  await mkdir(join(repo, 'nested'))
  git(join(repo, 'nested'), 'init', '-q')
  await writeFile(join(repo, 'nested', 'z.txt'), 'z')
  const listed = await lsFiles(repo, { exclude: ['harness'] })
  assert.deepEqual(listed.files, ['.gitignore', 'a.txt', 'keep/b.txt', 'nested/', 'new.txt'])
  assert.deepEqual(listed.ignoredDirs, ['build/', 'debug.log'])
  assert.deepEqual((await lsFiles(join(repo, 'keep'))).files, ['b.txt'])
  assert.equal(await lsFiles(await tmpDir()), undefined)
})

test('workspaceFacts: the dsh texts, line cap and exclusions', async () => {
  const repo = await gitRepo({ 'a.txt': 'x\n' })
  assert.deepEqual(await workspaceFacts(repo), { text: `Candidate root: ${repo}\nThe working tree has no uncommitted changes.`, git: true })
  for (let i = 0; i < 5; i++) await writeFile(join(repo, `n${i}.txt`), `${i}\n`)
  await writeFile(join(repo, 'a.txt'), 'changed\n')
  const facts = await workspaceFacts(repo, { maxLines: 3 })
  assert.equal(facts.git, true)
  assert.ok(facts.text.startsWith(`Candidate root: ${repo}\nUNCOMMITTED CHANGES (git status --porcelain, 6):\n   M a.txt\n  ?? n0.txt\n  ?? n1.txt\n  … 3 more\n\nDIFF STAT:\n`), facts.text)
  assert.match(facts.text, /a\.txt \| 2 \+-/)
  const excluded = await workspaceFacts(repo, { exclude: ['n0.txt', 'n1.txt', 'n2.txt', 'n3.txt', 'n4.txt'] })
  assert.match(excluded.text, /UNCOMMITTED CHANGES \(git status --porcelain, 1\)/)
  const plain = await tmpDir()
  assert.deepEqual(await workspaceFacts(plain), {
    text: `Candidate root: ${plain}\nNo usable git repository: file-change capture is unavailable; inspect the live state directly.`,
    git: false,
  })
})

test('a GIT_DIR / GIT_WORK_TREE in the caller environment never redirects safe git', async () => {
  const repo = await gitRepo({ 'a.txt': 'x\n' })
  const other = await gitRepo({ 'other.txt': 'o\n' })
  await writeFile(join(repo, 'a.txt'), 'changed\n')
  const saved = { ...process.env }
  process.env.GIT_DIR = join(other, '.git')
  process.env.GIT_WORK_TREE = other
  try {
    const facts = await workspaceFacts(repo)
    assert.match(facts.text, / M a\.txt/)
    assert.equal(await gitTopLevel(repo), repo)
  } finally {
    process.env = saved
  }
})

test('initInertRepo creates an inert repository once, so role git never discovers an enclosing one', async () => {
  const outer = await gitRepo({ 'outer.txt': 'o\n' })
  const work = join(outer, 'home', 'work')
  assert.equal(await initInertRepo(work), true)
  assert.equal(await initInertRepo(work), false)
  assert.equal(await readFile(join(work, '.gitignore'), 'utf8'), '*\n')
  assert.equal(existsSync(join(work, '.git', 'hooks')), false)
  assert.equal(git(work, 'config', '--local', 'core.hooksPath').trim(), '/dev/null')
  await mkdir(join(work, 'key', 'lineage', 'projects'), { recursive: true })
  await writeFile(join(work, 'key', 'lineage', 'projects', 'file.txt'), 'role output\n')
  const inside = join(work, 'key', 'lineage', 'projects')
  assert.equal(git(inside, 'rev-parse', '--show-toplevel').trim(), await realpath(work))
  assert.equal(git(inside, 'status', '--porcelain', '--untracked-files=all').trim(), '')
  // A user-edited .gitignore is kept.
  await writeFile(join(work, '.gitignore'), '*\n!keep\n')
  await initInertRepo(work)
  assert.equal(await readFile(join(work, '.gitignore'), 'utf8'), '*\n!keep\n')
})

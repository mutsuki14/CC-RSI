// `cc-rsi memory …` (SPEC §13.1, §6.6): read-only inspection, tamper detection with the two human
// remedies, freeze/unfreeze ordering, export/import and draft pruning — every change through the
// MemoryStore (memory changes only through commits).

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from '../../lib/cli/main.mjs'
import { projectKey, projectLayout } from '../../lib/core/paths.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

async function hermeticEnv() {
  const { home, env } = await tmpHome()
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_') || name.startsWith('CC_RSI_') || name === 'CLAUDE_CODE_EXECPATH') delete env[name]
  }
  env.CC_RSI_HOME = home
  env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
  return { home, env }
}

async function setup() {
  const { home, env } = await hermeticEnv()
  const repo = await gitRepo({ 'a.txt': 'a\n' })
  const root = await gitProjectRoot(repo)
  const pl = projectLayout(home, projectKey(root))
  const run = async (argv, extraEnv = {}) => {
    const out = []
    const err = []
    const code = await main(argv, { stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => err.push(s) }, env: { ...env, ...extraEnv }, cwd: repo, isTTY: false })
    return { code, stdout: out.join(''), stderr: err.join('') }
  }
  const store = () => MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
  return { home, env, repo, root, pl, run, store }
}

async function commitFile(s, episode, rel, content) {
  const store = await s.store()
  try {
    const draft = await store.openDraft(episode, { owner: { kind: 'engine', pid: process.pid } })
    mkdirSync(join(draft.dir, rel, '..'), { recursive: true })
    writeFileSync(join(draft.dir, rel), content)
    return await store.commit(episode, { kind: 'practice', outcome: 'PASS' })
  } finally {
    await store.close()
  }
}

describe('cc-rsi memory', () => {
  it('shows, lists and logs without changing the store', async () => {
    const s = await setup()
    assert.match((await s.run(['memory', 'inventory'])).stdout, /no memory store for project .* yet/)
    await commitFile(s, 'ep-1', 'procedures/check.md', 'run the tests first\n')
    await commitFile(s, 'ep-2', 'lessons/fail-01.md', 'never trust a single sample\n')
    const inv = await s.run(['memory', 'inventory'])
    assert.equal(inv.code, 0)
    assert.match(inv.stdout, /2 files, \d+ bytes, tree [0-9a-f]{64}/)
    assert.match(inv.stdout, /^ {2}28 {2}lessons\/fail-01\.md$/m)
    const show = await s.run(['memory', 'show', 'procedures/check.md'])
    assert.equal(show.stdout, 'run the tests first\n')
    const dir = await s.run(['memory', 'show', 'lessons'])
    assert.match(dir.stdout, /lessons\/: 1 files/)
    const escape = await s.run(['memory', 'show', '../../../etc/passwd'])
    assert.notEqual(escape.code, 0)
    assert.doesNotMatch(escape.stdout, /root:/)
    const log = await s.run(['memory', 'log', '-n', '1'])
    assert.match(log.stdout, /^#2 {2}\S+ {2}practice PASS {2}ep-2 {2}[0-9a-f]{12}→[0-9a-f]{12} {2}\+1 ~0 -0\n$/)
    const history = await s.run(['memory', 'history'])
    assert.match(history.stdout, /^0001 {2}tree [0-9a-f]{12}/m)
    assert.match(history.stdout, /^0002 {2}tree [0-9a-f]{12}/m)
    assert.equal((await s.run(['memory', 'verify'])).code, 0)
    assert.equal((await s.run(['memory'])).stdout, inv.stdout, 'a bare memory command shows the inventory')
    assert.equal((await s.run(['memory', 'frobnicate'])).code, 2)
    assert.equal((await s.run(['memory', 'log', '--prune'])).code, 2)
  })

  it('detects tamper and applies the human remedies (accept-external, restore)', async () => {
    const s = await setup()
    await commitFile(s, 'ep-1', 'a.md', 'one\n')
    const memoryDir = join(s.pl.store, 'memory')
    chmodSync(memoryDir, 0o700)
    writeFileSync(join(memoryDir, 'planted.md'), 'planted\n')
    const v = await s.run(['memory', 'verify'])
    assert.equal(v.code, 1)
    assert.match(v.stdout, /CHANGED OUTSIDE A COMMIT/)
    assert.match(v.stdout, /differences: created: planted\.md/)
    assert.match(v.stdout, /cc-rsi memory verify --accept-external/)
    // Under CLAUDECODE the remedies refuse (exit 65); the tree is unchanged.
    assert.equal((await s.run(['memory', 'verify', '--accept-external'], { CLAUDECODE: '1' })).code, 65)
    assert.equal((await s.run(['memory', 'restore', '1'], { CLAUDECODE: '1' })).code, 65)
    assert.ok(existsSync(join(memoryDir, 'planted.md')))
    // restore 1 rolls back to the first snapshot as a journaled commit.
    const restored = await s.run(['memory', 'restore', '1'])
    assert.equal(restored.code, 0, restored.stderr)
    assert.match(restored.stdout, /restored history snapshot 1 as commit #2: .*deleted: planted\.md/)
    assert.equal(existsSync(join(memoryDir, 'planted.md')), false)
    assert.equal((await s.run(['memory', 'verify'])).code, 0)
    // accept-external journals an external change.
    chmodSync(memoryDir, 0o700)
    writeFileSync(join(memoryDir, 'kept.md'), 'kept\n')
    const accepted = await s.run(['memory', 'verify', '--accept-external'])
    assert.equal(accepted.code, 0, accepted.stderr)
    assert.match(accepted.stdout, /accepted the external change as commit #3 .*created: kept\.md/)
    assert.equal((await s.run(['memory', 'verify'])).code, 0)
    const store = await s.store()
    try {
      assert.deepEqual((await store.journal()).map(r => r.kind), ['practice', 'restore', 'external'])
    } finally {
      await store.close()
    }
  })

  it('freezes, refuses unfreeze while sealed without --after-sealed, and reopens learning with it', async () => {
    const s = await setup()
    await commitFile(s, 'ep-1', 'a.md', 'one\n')
    const frozen = await s.run(['memory', 'freeze'], { CLAUDECODE: '1' }) // the /cc-rsi:freeze skill path
    assert.equal(frozen.code, 0, frozen.stderr)
    assert.match(frozen.stdout, /memory frozen at tree [0-9a-f]{64}/)
    assert.match((await s.run(['memory', 'freeze'])).stdout, /already frozen/)
    const store = await s.store()
    await store.markSealed({ lineage: 'deep-x', runId: 'r-1' })
    await store.close()
    const refused = await s.run(['memory', 'unfreeze'])
    assert.equal(refused.code, 3)
    assert.match(refused.stderr, /--after-sealed/)
    const reopened = await s.run(['memory', 'unfreeze', '--after-sealed'])
    assert.equal(reopened.code, 0, reopened.stderr)
    assert.match(reopened.stdout, /learning after a sealed evaluation is now open/)
    const check = await s.store()
    try {
      assert.equal(await check.frozen(), null)
      assert.equal((await check.sealed()).learningAfterSealed, true)
    } finally {
      await check.close()
    }
    assert.match((await s.run(['memory', 'unfreeze'])).stdout, /not frozen/)
  })

  it('exports a copy and imports a directory as one commit; refuses unsafe trees and destinations', async () => {
    const s = await setup()
    const src = await tmpDir('cc-rsi-import-')
    mkdirSync(join(src, 'sub'))
    writeFileSync(join(src, 'sub', 'x.md'), 'lesson\n')
    writeFileSync(join(src, 'top.md'), 'top\n')
    const imported = await s.run(['memory', 'import', src])
    assert.equal(imported.code, 0, imported.stderr)
    assert.match(imported.stdout, /imported 2 files .* as commit #1 \(import-\d{14}-[0-9a-f]{6}\)/)
    const dest = join(await tmpDir(), 'export')
    const exported = await s.run(['memory', 'export', dest])
    assert.equal(exported.code, 0, exported.stderr)
    assert.equal(readFileSync(join(dest, 'sub', 'x.md'), 'utf8'), 'lesson\n')
    assert.equal((await s.run(['memory', 'export', dest])).code, 3, 'a non-empty destination is refused')
    assert.equal((await s.run(['memory', 'export', join(s.home, 'leak')])).code, 3, 'the cc-rsi home is refused')
    // No draft is left behind; a symlink in the import source is refused and changes nothing.
    assert.deepEqual(readdirSync(join(s.pl.store, 'drafts')).filter(n => !n.startsWith('.')), [])
    const bad = await tmpDir('cc-rsi-import-bad-')
    writeFileSync(join(bad, 'ok.md'), 'ok\n')
    const { symlinkSync } = await import('node:fs')
    symlinkSync('/etc/passwd', join(bad, 'link.md'))
    const refused = await s.run(['memory', 'import', bad])
    assert.notEqual(refused.code, 0)
    const store = await s.store()
    try {
      assert.equal((await store.journal()).length, 1)
    } finally {
      await store.close()
    }
  })

  it('lists drafts and prunes only drafts no live owner can use', async () => {
    const s = await setup()
    await commitFile(s, 'ep-0', 'a.md', 'one\n')
    const store = await s.store()
    // A session draft whose session has no open learning phase, and one whose session has it open.
    mkdirSync(join(s.pl.sessions, 'sess-idle'), { recursive: true })
    mkdirSync(join(s.pl.sessions, 'sess-open'), { recursive: true })
    writeFileSync(join(s.pl.sessions, 'sess-open', 'task.json'), JSON.stringify({ v: 1, learning: { episode: 'task-open', stage: 'distill' } }))
    writeFileSync(join(s.pl.sessions, 'sess-open', 'session.json'), JSON.stringify({ v: 1, endedAt: null }))
    await store.openDraft('task-idle', { owner: { kind: 'session', sessionId: 'sess-idle' } })
    await store.openDraft('task-open', { owner: { kind: 'session', sessionId: 'sess-open' } })
    await store.openDraft('lineage-ep', { owner: { kind: 'engine', pid: process.pid, lineage: 'deep-1' } })
    await store.close()
    const list = await s.run(['memory', 'drafts'])
    assert.match(list.stdout, /^task-idle {2}session sess-idle {2}live/m)
    assert.equal((await s.run(['memory', 'drafts', '--prune'], { CLAUDECODE: '1' })).code, 65)
    const pruned = await s.run(['memory', 'drafts', '--prune'])
    assert.equal(pruned.code, 0, pruned.stderr)
    assert.match(pruned.stdout, /^pruned task-idle/m)
    assert.match(pruned.stdout, /^task-open .* kept: session sess-open has this learning phase open/m)
    assert.match(pruned.stdout, /^lineage-ep .* kept: lineage deep-1 may resume it/m)
    const after = await s.store()
    try {
      assert.deepEqual((await after.drafts()).map(d => d.episode), ['lineage-ep', 'task-open'])
    } finally {
      await after.close()
    }
  })
})

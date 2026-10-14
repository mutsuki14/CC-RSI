// MemoryStore (SPEC §6.2-§6.6). Ports dsh-rsi test/memory.test.ts (MemoryStore,
// MemoryStore durability) to node:test and the cc-rsi API (the Actor writes draft files
// directly), plus the §15.3 WP1 rows: tamper detection, rebaseDraft, sealed refusal, external
// draft sweep by owner liveness, inventory.json, history.

import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import {
  appendFile, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LockTimeoutError } from '../../lib/core/errors.mjs'
import {
  MemoryConflictError, MemoryDraftMissingError, MemoryError, MemoryFrozenError, MemoryFrozenTamperError, MemoryLimitError,
  MemoryQuarantineError, MemorySealedError, MemoryTamperError, UnsafeMemoryPathError,
} from '../../lib/memory/errors.mjs'
import { EMPTY_TREE_SHA256 } from '../../lib/memory/hash.mjs'
import { MemoryStore, storeIntegrity } from '../../lib/memory/store.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const limits = { maxFileBytes: 1024, maxTotalBytes: 4096, maxFiles: 8 }
const DEAD_PID = 2 ** 22 + 12345
const SEALED = 'the held out task asks for exactly seven red widgets on the second sheet'
const STORE_MODULE = fileURLToPath(new URL('../../lib/memory/store.mjs', import.meta.url))

async function put(dir, rel, content) {
  await mkdir(join(dir, rel, '..'), { recursive: true })
  await writeFile(join(dir, rel), content)
}

async function fresh(options = {}) {
  const base = await tmpDir('cc-rsi-store-')
  const root = join(base, 'store')
  const store = await MemoryStore.open(root, { limits, ...options })
  return { base, root, store }
}

async function learn(store, episode, files, meta = { kind: 'practice', outcome: 'PASS' }, draftOptions = {}) {
  const draft = await store.openDraft(episode, draftOptions)
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) await rm(join(draft.dir, rel), { force: true })
    else await put(draft.dir, rel, content)
  }
  return store.commit(episode, meta)
}

describe('MemoryStore', () => {
  it('promotes a draft atomically and journals the delta', async () => {
    const { root, store } = await fresh()
    assert.equal(await store.treeHash(), EMPTY_TREE_SHA256)
    const draft = await store.openDraft('ep1')
    assert.equal(draft.baseHash, EMPTY_TREE_SHA256)
    await put(draft.dir, 'procedures/build.md', 'Run `make` then `make test`.')
    assert.deepEqual((await store.inventory()).files, [])
    const record = await store.commit('ep1', { kind: 'practice', outcome: 'PASS' })
    assert.deepEqual(record.created, ['procedures/build.md'])
    assert.equal(record.seq, 1)
    assert.equal(record.v, 1)
    assert.equal(record.treeBefore, EMPTY_TREE_SHA256)
    assert.equal(record.treeAfter, await store.treeHash())
    assert.equal(record.files, 1)
    assert.equal(record.bytes, 28)
    assert.deepEqual((await store.inventory()).files, [{ path: 'procedures/build.md', bytes: 28 }])
    assert.equal((await store.inventory()).treeSha256, record.treeAfter)
    assert.match(await readFile(join(store.memoryDir, 'procedures/build.md'), 'utf8'), /make test/)
    assert.equal((await store.journal()).length, 1)
    assert.deepEqual(await readdir(join(root, 'history')), ['0001'])
    assert.equal(await store.getDraft('ep1'), undefined)
    assert.equal(await store.expectedTreeHash(), record.treeAfter)
    await store.assertCanonicalIntact()

    const next = await learn(store, 'ep2', { 'procedures/build.md': null, 'lessons/flaky.md': 'Retry once; a second failure is real.' }, { kind: 'task', outcome: 'FAIL' })
    assert.deepEqual(next.created, ['lessons/flaky.md'])
    assert.deepEqual(next.deleted, ['procedures/build.md'])
    assert.equal(next.treeBefore, record.treeAfter)
    assert.equal(next.seq, 2)
    assert.deepEqual((await store.history()).map(h => h.n), [1, 2])
    assert.equal((await store.history())[1].treeSha256, next.treeAfter)
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.staging-') || name.startsWith('.backup-')), [])
  })

  it('refuses a draft whose base is no longer canonical, keeps it, and rebases with .prev', async () => {
    const { store } = await fresh()
    const a = await store.openDraft('a')
    const b = await store.openDraft('b')
    await put(a.dir, 'x.md', 'a')
    await put(b.dir, 'y.md', 'b')
    const committed = await store.commit('a', { kind: 'practice', outcome: 'PASS' })
    await assert.rejects(store.commit('b', { kind: 'practice', outcome: 'PASS' }), err => {
      assert.ok(err instanceof MemoryConflictError)
      assert.equal(err.baseHash, b.baseHash)
      assert.equal(err.currentHash, committed.treeAfter)
      return true
    })
    assert.ok(await store.getDraft('b'))
    const { prevDir, draft } = await store.rebaseDraft('b')
    assert.equal(prevDir, `${b.dir}.prev`)
    assert.equal(draft.dir, b.dir)
    assert.equal(await readFile(join(prevDir, 'y.md'), 'utf8'), 'b')
    assert.equal(await readFile(join(draft.dir, 'x.md'), 'utf8'), 'a')
    assert.equal(draft.baseHash, await store.treeHash())
    // The same Actor merges its previous draft into the rebased one.
    await put(draft.dir, 'y.md', 'b')
    const record = await store.commit('b', { kind: 'practice', outcome: 'PASS' })
    assert.deepEqual(record.created, ['y.md'])
    await assert.rejects(lstat(prevDir), /ENOENT/)
    // A second rebase before the Actor changed anything (e.g. a re-run after a crash) keeps .prev.
    const c = await store.openDraft('c')
    await put(c.dir, 'z.md', 'old')
    await store.rebaseDraft('c')
    const again = await store.rebaseDraft('c')
    assert.deepEqual((await readdir(again.prevDir)).sort(), ['x.md', 'y.md', 'z.md'])
    assert.equal(again.draft.baseHash, await store.treeHash())
    // A rebase of a changed draft replaces the older .prev.
    await put(again.draft.dir, 'w.md', 'new work')
    const third = await store.rebaseDraft('c')
    assert.deepEqual((await readdir(third.prevDir)).sort(), ['w.md', 'x.md', 'y.md'])
    assert.deepEqual((await readdir(third.draft.dir)).sort(), ['x.md', 'y.md'])
    await assert.rejects(store.rebaseDraft('nope'), MemoryDraftMissingError)
  })

  it('enforces limits at commit and keeps the draft so the same Actor can condense it', async () => {
    const { store } = await fresh()
    const draft = await store.openDraft('big')
    await put(draft.dir, 'big.md', 'x'.repeat(2048))
    await assert.rejects(store.commit('big', { kind: 'practice', outcome: 'PASS' }), err => {
      assert.ok(err instanceof MemoryLimitError)
      assert.equal(err.detail, "'big.md' 2048 bytes > 1024")
      return true
    })
    await rm(join(draft.dir, 'big.md'))
    for (let i = 0; i < 9; i++) await put(draft.dir, `f${i}.md`, 'x')
    await assert.rejects(store.commit('big', { kind: 'practice', outcome: 'PASS' }), err => err instanceof MemoryLimitError && /^9 files > 8$/.test(err.detail))
    await rm(join(draft.dir, 'f8.md'))
    assert.equal((await store.commit('big', { kind: 'practice', outcome: 'PASS' })).files, 8)
  })

  it('lets the Actor condense an over-limit draft in place (limits lowered after memory grew)', async () => {
    const base = await tmpDir()
    const root = join(base, 'store')
    const roomy = await MemoryStore.open(root, { limits: { maxFileBytes: 4096, maxTotalBytes: 10000, maxFiles: 8 }, keepHistory: false })
    await learn(roomy, 'big', { 'a.md': 'a'.repeat(3000), 'b.md': 'b'.repeat(3000) })
    const tight = await MemoryStore.open(root, { limits: { maxFileBytes: 4096, maxTotalBytes: 4000, maxFiles: 8 }, keepHistory: false })
    const draft = await tight.openDraft('trim')
    await put(draft.dir, 'a.md', 'a'.repeat(1500))
    await assert.rejects(tight.commit('trim', { kind: 'practice', outcome: 'PASS' }), /4500 bytes > 4000/)
    await put(draft.dir, 'b.md', 'b'.repeat(1000))
    assert.equal((await tight.commit('trim', { kind: 'practice', outcome: 'PASS' })).bytes, 2500)
  })

  it('freezes memory for test-time reuse and detects mutation', async () => {
    const { store } = await fresh()
    await learn(store, 'e', { 'a.md': 'a' })
    const open = await store.openDraft('pending')
    const { treeHash } = await store.freeze({ by: 'test' })
    assert.equal(treeHash, await store.treeHash())
    assert.deepEqual(await store.freeze({ by: 'again' }), { treeHash })
    assert.equal((await store.frozen()).by, 'test')
    await assert.rejects(store.openDraft('late'), MemoryFrozenError)
    await assert.rejects(store.commit('pending', { kind: 'practice', outcome: 'PASS' }), MemoryFrozenError)
    assert.ok(await store.getDraft('pending'), open.episode)
    await store.assertFrozenIntact()
    await writeFile(join(store.memoryDir, 'sneaky.md'), 'edited outside the protocol')
    await assert.rejects(store.assertFrozenIntact(), err => err instanceof MemoryFrozenTamperError && err.expected === treeHash)
    await assert.rejects(store.unfreeze(), MemoryFrozenTamperError)
    await rm(join(store.memoryDir, 'sneaky.md'))
    await store.unfreeze()
    assert.equal(await store.frozen(), null)
    await assert.rejects(store.assertFrozenIntact(), err => err instanceof MemoryError && err.code === 'memory_not_frozen')
    assert.ok(await store.openDraft('later'))
  })

  it('refuses to freeze a tampered tree', async () => {
    const { store } = await fresh()
    await writeFile(join(store.memoryDir, 'outside.md'), 'x')
    await assert.rejects(store.freeze({ by: 'x' }), MemoryTamperError)
  })

  it('refuses symlinks in canonical memory and in drafts', async () => {
    const { store } = await fresh()
    const draft = await store.openDraft('s')
    await symlink('/etc/hostname', join(draft.dir, 'link'))
    await assert.rejects(store.commit('s', { kind: 'practice', outcome: 'PASS' }), UnsafeMemoryPathError)
    assert.ok(await store.getDraft('s'), 'the draft is kept so it can be fixed')
    await symlink('/etc/hostname', join(store.memoryDir, 'link'))
    await assert.rejects(store.treeHash(), /symlink/)
    await assert.rejects(store.assertCanonicalIntact(), err => err instanceof MemoryTamperError && /invalid/.test(err.actual))
  })

  it('quarantines a commit that overlaps sealed material, absorbingly, without recording content', async () => {
    const base = await tmpDir()
    await writeFile(join(base, 'sealed.txt'), SEALED)
    const root = join(base, 'store')
    const audited = await MemoryStore.open(root, { limits, keepHistory: false, sealedTextFiles: [join(base, 'sealed.txt')] })
    const draft = await audited.openDraft('leak')
    await put(draft.dir, 'cheat.md', 'Remember: the held out task asks for exactly seven red widgets!')
    await put(draft.dir, 'fine.md', 'unrelated')
    await assert.rejects(audited.commit('leak', { kind: 'practice', outcome: 'PASS', origin: 'verdict-7', lineage: 'broad-x' }), err => {
      assert.ok(err instanceof MemoryQuarantineError)
      assert.equal(err.message, 'this learning phase could not be promoted; durable memory is unchanged')
      return true
    })
    assert.deepEqual((await audited.inventory()).files, [])
    assert.equal(await audited.treeHash(), EMPTY_TREE_SHA256)
    assert.equal(await audited.getDraft('leak'), undefined)
    const reopened = await MemoryStore.open(root, { limits, keepHistory: false })
    assert.equal(await reopened.isQuarantined('leak'), true)
    assert.equal(await reopened.isQuarantined('verdict-7'), true)
    assert.match(await readFile(join(root, 'quarantined', 'leak'), 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z\n$/)
    await assert.rejects(reopened.openDraft('leak'), MemoryQuarantineError)
    const rejects = await readFile(join(root, 'audit_rejects.jsonl'), 'utf8')
    assert.doesNotMatch(rejects, /widgets|held out/)
    const line = JSON.parse(rejects.trim().split('\n')[0])
    assert.deepEqual({ episode: line.episode, lineage: line.lineage, surface: line.surface, file: line.file, kinds: line.kinds },
      { episode: 'leak', lineage: 'broad-x', surface: 'commit', file: 'cheat.md', kinds: ['shingle'] })
    // auditTexts: a hit is recorded without content; a miss writes nothing.
    assert.equal(await audited.auditTexts(['clean text only'], { surface: 'wave', lineage: 'broad-x' }), false)
    assert.equal(await audited.auditTexts(['x', `notes: ${SEALED}`], { surface: 'wave', lineage: 'broad-x', episode: 'w001' }), true)
    const all = (await readFile(join(root, 'audit_rejects.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    assert.equal(all.length, 2)
    assert.deepEqual(all[1].kinds, ['shingle'])
    assert.equal(all[1].surface, 'wave')
    const plain = await MemoryStore.open(join(base, 'plain'), { limits })
    assert.equal(await plain.auditTexts([SEALED], { surface: 'wave' }), false)
  })

  it('recovers from an install interrupted between its renames', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    await learn(store, 'ok', { 'keep.md': 'durable' })
    await rename(store.memoryDir, join(root, '.backup-crash'))
    await mkdir(join(root, '.staging-crash'))
    const reopened = await MemoryStore.open(root, { limits, keepHistory: false })
    assert.equal(await readFile(join(reopened.memoryDir, 'keep.md'), 'utf8'), 'durable')
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.staging') || name.startsWith('.backup')), [])
    await reopened.assertCanonicalIntact()
  })

  it('finishes an install whose tree reached canonical before its journal record', async () => {
    const { root, store } = await fresh({ keepHistory: true })
    const draft = await store.openDraft('task-s-3')
    await put(draft.dir, 'lesson.md', 'promoted once')
    const record = await store.commit('task-s-3', { kind: 'task', outcome: 'PASS' })
    // The crash window: tree installed, marker present, journal and history not yet written, draft kept.
    await writeFile(join(root, 'commit.pending.json'), `${JSON.stringify({ v: 1, record })}\n`)
    await writeFile(join(root, 'journal.jsonl'), '')
    await rm(join(root, 'history'), { recursive: true, force: true })
    const again = await store.openDraft('task-s-3')
    await writeFile(join(again.dir, 'lesson.md'), 'promoted once')
    const restarted = await MemoryStore.open(root, { limits, keepHistory: true })
    assert.equal((await restarted.findCommit('task-s-3')).treeAfter, record.treeAfter)
    assert.equal(await restarted.getDraft('task-s-3'), undefined)
    assert.deepEqual(await readdir(join(root, 'history')), ['0001'])
    assert.equal((await readdir(root)).includes('commit.pending.json'), false)
    await restarted.assertCanonicalIntact()
    // A relearn of the same episode finds the commit instead of promoting twice.
    const relearn = await restarted.openDraft('task-s-3')
    await put(relearn.dir, 'lesson.md', 'promoted twice?')
    assert.deepEqual(await restarted.commit('task-s-3', { kind: 'task', outcome: 'PASS' }), record)
    assert.equal((await restarted.journal()).length, 1)
  })

  it('integrity() is lock-free and treats an install in flight as intact (memory-crash-10)', async () => {
    const { root, store } = await fresh({ keepHistory: true })
    const record = await learn(store, 'ep-int', { 'a.md': 'one' })
    assert.deepEqual(await store.integrity(), { expected: record.treeAfter, actual: record.treeAfter, intact: true, pending: false })
    // Another process installed a tree and has not journaled it yet: its pending marker names it.
    const draft = await store.openDraft('ep-int-2')
    await put(draft.dir, 'b.md', 'two')
    const next = await store.commit('ep-int-2', { kind: 'practice', outcome: 'PASS' })
    const journal = await readFile(join(root, 'journal.jsonl'), 'utf8')
    await writeFile(join(root, 'journal.jsonl'), `${journal.trim().split('\n')[0]}\n`)
    await writeFile(join(root, 'commit.pending.json'), `${JSON.stringify({ v: 1, record: next })}\n`)
    const inFlight = await storeIntegrity(root)
    assert.equal(inFlight.intact, true)
    assert.equal(inFlight.pending, true)
    // Without the marker the same tree is a change outside a commit.
    await rm(join(root, 'commit.pending.json'))
    const t0 = Date.now()
    const tampered = await storeIntegrity(root, { retryMs: 50 })
    assert.equal(tampered.intact, false)
    assert.equal(tampered.expected, record.treeAfter)
    assert.equal(tampered.actual, next.treeAfter)
    assert.ok(Date.now() - t0 >= 50, 'a mismatch is read once more before it is reported')
  })

  it('drops a pending commit whose install never happened (and a torn marker)', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    const draft = await store.openDraft('never')
    await put(draft.dir, 'x.md', 'x')
    const treeBefore = await store.treeHash()
    await writeFile(join(root, 'commit.pending.json'), JSON.stringify({ v: 1, record: { episode: 'never', treeBefore, treeAfter: 'f'.repeat(64) } }))
    const restarted = await MemoryStore.open(root, { limits, keepHistory: false })
    assert.deepEqual(await restarted.journal(), [])
    assert.ok(await restarted.getDraft('never'))
    assert.equal((await readdir(root)).includes('commit.pending.json'), false)
    await writeFile(join(root, 'commit.pending.json'), '{"v":1,"rec')
    await MemoryStore.open(root, { limits, keepHistory: false })
    assert.equal((await readdir(root)).includes('commit.pending.json'), false)
    assert.ok((await restarted.commit('never', { kind: 'practice', outcome: 'PASS' })).treeAfter)
  })

  it('never reopens a half-discarded or half-opened draft', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    const draft = await store.openDraft('half')
    await put(draft.dir, 'x.md', 'x')
    // A discard that crashed after removing the metadata (removed first) leaves only a directory.
    await rm(join(root, 'drafts', 'half.json'))
    await writeFile(join(root, 'drafts', '.half.json.123.abc.tmp'), '{')
    const restarted = await MemoryStore.open(root, { limits, keepHistory: false })
    assert.equal(await restarted.getDraft('half'), undefined)
    assert.deepEqual(await readdir(join(root, 'drafts')), [])
    await assert.rejects(restarted.commit('half', { kind: 'practice', outcome: 'PASS' }), MemoryDraftMissingError)
  })

  it('cleans up drafts of already-committed episodes at open', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    await learn(store, 'done', { 'a.md': 'a' })
    await mkdir(join(root, 'drafts', 'done'), { recursive: true })
    await writeFile(join(root, 'drafts', 'done.json'), JSON.stringify({ v: 1, episode: 'done', baseHash: '0'.repeat(64), baseManifest: {}, createdAt: '' }))
    await MemoryStore.open(root, { limits, keepHistory: false })
    assert.deepEqual(await readdir(join(root, 'drafts')), [])
  })

  it('tolerates a torn final journal line and keeps a record appended after it', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    await learn(store, 'e', { 'a.md': 'a' })
    await writeFile(join(root, 'journal.jsonl'), `${await readFile(join(root, 'journal.jsonl'), 'utf8')}{"episode":"tor`)
    assert.deepEqual((await store.journal()).map(r => r.episode), ['e'])
    await learn(store, 'after', { 'b.md': 'b' })
    assert.deepEqual((await store.journal()).map(r => r.episode), ['e', 'after'])
    assert.equal((await store.journal())[1].seq, 2)
    await store.assertCanonicalIntact()
  })

  it('promotes one experience once, by episode and by origin (session forks)', async () => {
    const { store } = await fresh({ keepHistory: false })
    const fork = await store.openDraft('task-fork-7')
    const parent = await store.openDraft('task-parent-7')
    await put(fork.dir, 'lesson.md', 'from the fork')
    await put(parent.dir, 'lesson.md', 'from the parent')
    const first = await store.commit('task-fork-7', { kind: 'task', outcome: 'PASS', origin: 'task-parent-7' })
    const second = await store.commit('task-parent-7', { kind: 'task', outcome: 'PASS', origin: 'task-parent-7' })
    assert.deepEqual(second, first)
    assert.equal((await store.journal()).length, 1)
    assert.deepEqual(await store.findCommit('task-parent-7'), first)
    assert.equal(await readFile(join(store.memoryDir, 'lesson.md'), 'utf8'), 'from the fork')
    assert.equal(await store.getDraft('task-parent-7'), undefined)
    assert.deepEqual(await store.commit('task-fork-7', { kind: 'task', outcome: 'PASS' }), first)
  })

  it('serializes commits across store instances: exactly one promotes, the other conflicts', async () => {
    const { root, store: a } = await fresh({ keepHistory: false })
    const b = await MemoryStore.open(root, { limits, keepHistory: false })
    const da = await a.openDraft('a')
    const db = await b.openDraft('b')
    await put(da.dir, 'a.md', 'a')
    await put(db.dir, 'b.md', 'b')
    const results = await Promise.allSettled([a.commit('a', { kind: 'practice', outcome: 'PASS' }), b.commit('b', { kind: 'practice', outcome: 'PASS' })])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.ok(results.find(r => r.status === 'rejected').reason instanceof MemoryConflictError)
  })

  it('serializes commits across two Node processes', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    for (const episode of ['p1', 'p2']) {
      const draft = await store.openDraft(episode, { owner: { kind: 'session', sessionId: 'never-swept' } })
      await put(draft.dir, `${episode}.md`, episode)
    }
    const script = `
      const { MemoryStore } = await import(${JSON.stringify(STORE_MODULE)})
      const store = await MemoryStore.open(process.argv[1], { keepHistory: false })
      try { await store.commit(process.argv[2], { kind: 'practice', outcome: 'PASS' }); console.log('ok') }
      catch (error) { console.log(error.code) }`
    const runs = await Promise.all(['p1', 'p2'].map(ep => runNode('--input-type=module', ['-e', script, root, ep])))
    assert.deepEqual(runs.map(r => r.stdout.trim()).sort(), ['memory_conflict', 'ok'], runs.map(r => r.stderr).join('\n'))
    await store.assertCanonicalIntact()
  })

  it('takes over a lock left by a dead pid, an earlier same-pid process or an expired lease', async () => {
    const { root, store } = await fresh({ keepHistory: false, lockOptions: { waitMs: 1500 } })
    const lock = join(root, '.lock')
    await writeFile(lock, JSON.stringify({ pid: DEAD_PID, host: hostname(), token: 't', at: '' }))
    assert.equal((await store.openDraft('c')).episode, 'c')
    // A container restart reuses the pid: same pid and host, but another process's token.
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: 'earlier-process:x' }))
    assert.equal((await store.openDraft('a')).episode, 'a')
    // Another host whose lease ran out.
    await writeFile(lock, JSON.stringify({ pid: 1, host: 'another-container', token: 't' }))
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    assert.equal((await store.openDraft('b')).episode, 'b')
    // A live lock elsewhere is respected until the wait budget runs out.
    await writeFile(lock, JSON.stringify({ pid: 1, host: 'another-container', token: 't' }))
    await assert.rejects(store.openDraft('d'), LockTimeoutError)
    await rm(lock)
  })

  it('detects tamper, accepts an external change, and restores history', async () => {
    const { root, store } = await fresh()
    const r1 = await learn(store, 'e1', { 'a.md': 'one' })
    const r2 = await learn(store, 'e2', { 'a.md': 'two', 'b.md': 'b' })
    await store.assertCanonicalIntact()
    // An external write (e.g. a Bash edit) changes canonical outside a commit.
    await writeFile(join(store.memoryDir, 'a.md'), 'edited outside')
    await assert.rejects(store.assertCanonicalIntact(), err => {
      assert.ok(err instanceof MemoryTamperError)
      assert.equal(err.expected, r2.treeAfter)
      assert.equal(err.actual, err.details.actual)
      assert.notEqual(err.actual, r2.treeAfter)
      return true
    })
    // Commits refuse while tampered; the draft is kept.
    const d = await store.openDraft('e3')
    await put(d.dir, 'c.md', 'c')
    await assert.rejects(store.commit('e3', { kind: 'practice', outcome: 'PASS' }), MemoryTamperError)
    assert.ok(await store.getDraft('e3'))
    // Open never throws on tamper.
    const reopened = await MemoryStore.open(root, { limits })
    await assert.rejects(reopened.assertCanonicalIntact(), MemoryTamperError)

    const accepted = await store.acceptExternal({ by: 'human' })
    assert.equal(accepted.kind, 'external')
    assert.equal(accepted.treeBefore, r2.treeAfter)
    assert.equal(accepted.treeAfter, await store.treeHash())
    assert.deepEqual(accepted.modified, ['a.md'])
    assert.equal(accepted.by, 'human')
    await store.assertCanonicalIntact()
    assert.equal(await store.acceptExternal({ by: 'human' }), null)

    await writeFile(join(store.memoryDir, 'junk.md'), 'more tamper')
    const restored = await store.restoreHistory(1, { by: 'human' })
    assert.equal(restored.kind, 'restore')
    assert.equal(restored.restoredFrom, 1)
    assert.equal(restored.treeAfter, r1.treeAfter)
    assert.equal(await store.treeHash(), r1.treeAfter)
    assert.equal(await readFile(join(store.memoryDir, 'a.md'), 'utf8'), 'one')
    await store.assertCanonicalIntact()
    assert.deepEqual((await store.inventory()).files, [{ path: 'a.md', bytes: 3 }])
    await assert.rejects(store.restoreHistory(99, { by: 'human' }), err => err.code === 'memory_history_missing')
    // The rebased draft can now proceed against the restored tree.
    await assert.rejects(store.commit('e3', { kind: 'practice', outcome: 'PASS' }), MemoryConflictError)
    const { draft } = await store.rebaseDraft('e3')
    await put(draft.dir, 'c.md', 'c')
    assert.deepEqual((await store.commit('e3', { kind: 'practice', outcome: 'PASS' })).created, ['c.md'])
  })

  it('refuses learning after a sealed evaluation until unfreeze --after-sealed', async () => {
    const { store } = await fresh()
    await learn(store, 'e1', { 'a.md': 'a' })
    const pending = await store.openDraft('e2')
    await put(pending.dir, 'b.md', 'b')
    await store.freeze({ by: 'eval' })
    await store.markSealed({ lineage: 'deep-1', runId: 'r-1' })
    const sealed = await store.sealed()
    assert.equal(sealed.learningAfterSealed, false)
    assert.deepEqual(sealed.runs.map(r => [r.lineage, r.runId]), [['deep-1', 'r-1']])
    await assert.rejects(store.unfreeze(), MemorySealedError)
    await store.unfreeze({ afterSealed: true })
    assert.equal((await store.sealed()).learningAfterSealed, true)
    assert.equal(await store.frozen(), null)
    assert.ok((await store.commit('e2', { kind: 'practice', outcome: 'PASS' })).treeAfter)
    // A later sealed run closes learning again.
    await store.markSealed({ lineage: 'deep-2', runId: 'r-2' })
    await assert.rejects(store.openDraft('e3'), MemorySealedError)
    await assert.rejects(store.restoreHistory(1, { by: 'h' }), MemorySealedError)
  })

  it('sweeps external drafts by owner liveness', async () => {
    const { base, root, store } = await fresh({ keepHistory: false })
    const sessions = join(base, 'sessions')
    await mkdir(join(sessions, 'live-session'), { recursive: true })
    const ext = name => join(base, 'work', name, 'memory')
    await store.openDraft('engine-dead', { dir: ext('a'), owner: { kind: 'engine', pid: DEAD_PID, host: hostname(), lineage: 'gone' } })
    await store.openDraft('engine-live', { dir: ext('b'), owner: { kind: 'engine', pid: process.pid, host: hostname() } })
    await store.openDraft('engine-elsewhere', { dir: ext('c'), owner: { kind: 'engine', pid: DEAD_PID, host: 'another-host' } })
    await store.openDraft('session-live', { dir: ext('d'), owner: { kind: 'session', sessionId: 'live-session' } })
    await store.openDraft('session-ended', { dir: ext('e'), owner: { kind: 'session', sessionId: 'ended-session' } })
    await store.openDraft('internal', { owner: { kind: 'engine', pid: DEAD_PID, host: hostname() } })
    // A paused lineage keeps its draft although its engine exited (SPEC §12.8: resume continues it).
    await mkdir(join(base, 'lineages', 'paused'), { recursive: true })
    await writeFile(join(base, 'lineages', 'paused', 'state.json'), JSON.stringify({ v: 1, status: 'paused_infra' }))
    await store.openDraft('engine-paused', { dir: ext('f'), owner: { kind: 'engine', pid: DEAD_PID, host: hostname(), lineage: 'paused' } })
    await mkdir(join(base, 'lineages', 'done'), { recursive: true })
    await writeFile(join(base, 'lineages', 'done', 'state.json'), JSON.stringify({ v: 1, status: 'completed' }))
    await store.openDraft('engine-done', { dir: ext('g'), owner: { kind: 'engine', pid: DEAD_PID, host: hostname(), lineage: 'done' } })

    const listed = await store.drafts()
    assert.equal(listed.length, 8)
    assert.deepEqual(listed.filter(d => !d.live).map(d => d.episode), ['engine-dead', 'engine-done', 'internal', 'session-ended'])
    assert.ok(listed.every(d => d.dirExists && !d.committed))
    await MemoryStore.open(root, { limits, keepHistory: false })
    assert.deepEqual((await store.drafts()).map(d => d.episode), ['engine-elsewhere', 'engine-live', 'engine-paused', 'session-live'])
    const kept = []
    for (const episode of ['engine-dead', 'engine-live', 'engine-elsewhere', 'session-live', 'session-ended', 'internal', 'engine-paused', 'engine-done']) {
      if (await store.getDraft(episode)) kept.push(episode)
    }
    assert.deepEqual(kept, ['engine-live', 'engine-elsewhere', 'session-live', 'engine-paused'])
    await assert.rejects(lstat(ext('a')), /ENOENT/)
    await assert.rejects(lstat(ext('e')), /ENOENT/)
    await assert.rejects(lstat(ext('g')), /ENOENT/)
    assert.ok((await stat(ext('d'))).isDirectory())
    assert.deepEqual((await readdir(join(root, 'drafts'))).sort(),
      ['engine-elsewhere.json', 'engine-live.json', 'engine-paused.json', 'session-live.json'])
  })

  it('reuses an existing draft, refreshes its owner, and discards with fresh', async () => {
    const { base, store } = await fresh()
    const dir = join(base, 'ext', 'memory')
    const first = await store.openDraft('ep', { dir, owner: { kind: 'engine', pid: DEAD_PID, host: hostname() } })
    await put(dir, 'note.md', 'kept')
    const again = await store.openDraft('ep', { dir, owner: { kind: 'engine', pid: process.pid, host: hostname() } })
    assert.equal(again.baseHash, first.baseHash)
    assert.equal(again.owner.pid, process.pid)
    assert.equal(await readFile(join(dir, 'note.md'), 'utf8'), 'kept')
    const reset = await store.openDraft('ep', { dir, fresh: true })
    assert.deepEqual(await readdir(reset.dir), [])
    // Moving the draft to another dir discards the old one.
    const moved = await store.openDraft('ep', { dir: join(base, 'ext2', 'memory') })
    await assert.rejects(lstat(dir), /ENOENT/)
    assert.ok((await stat(moved.dir)).isDirectory())
    await store.discardDraft('ep')
    await assert.rejects(lstat(moved.dir), /ENOENT/)
    assert.equal(await store.getDraft('ep'), undefined)
  })

  it('refuses unsafe draft directories', async () => {
    const { base, root, store } = await fresh()
    await assert.rejects(store.openDraft('x', { dir: join(root, 'memory') }), UnsafeMemoryPathError)
    await assert.rejects(store.openDraft('x', { dir: join(root, 'history', 'x') }), UnsafeMemoryPathError)
    await assert.rejects(store.openDraft('x', { dir: base }), UnsafeMemoryPathError)
    await assert.rejects(store.openDraft('x', { dir: join(root, 'drafts') }), UnsafeMemoryPathError)
    await assert.rejects(store.openDraft('x', { dir: '/' }), UnsafeMemoryPathError)
    const target = join(base, 'elsewhere')
    await mkdir(target)
    await symlink(target, join(base, 'link'))
    await assert.rejects(store.openDraft('x', { dir: join(base, 'link') }), UnsafeMemoryPathError)
  })

  it('stores reports by content and refuses altered ones', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    const sha = await store.putReport('VERDICT: PASS')
    assert.match(sha, /^[0-9a-f]{64}$/)
    assert.equal(await store.putReport('VERDICT: PASS'), sha)
    assert.equal(await store.getReport(sha), 'VERDICT: PASS')
    await writeFile(join(root, 'reports', `${sha}.md`), 'VERDICT: FAIL')
    assert.equal(await store.getReport(sha), undefined)
    assert.equal(await store.putReport('VERDICT: PASS'), sha)
    assert.equal(await store.getReport(sha), 'VERDICT: PASS')
    assert.equal(await store.getReport('../escape'), undefined)
    assert.equal(await store.getReport('0'.repeat(64)), undefined)
  })

  it('rebuilds a stale inventory.json at open and on refresh', async () => {
    const { root, store } = await fresh({ keepHistory: false })
    await learn(store, 'e', { 'a.md': 'aaa' })
    const cached = JSON.parse(await readFile(join(root, 'inventory.json'), 'utf8'))
    assert.equal(cached.v, 1)
    assert.equal(cached.totalBytes, 3)
    await writeFile(join(root, 'inventory.json'), JSON.stringify({ ...cached, treeSha256: 'f'.repeat(64) }))
    assert.equal((await store.inventory()).treeSha256, 'f'.repeat(64))
    assert.equal((await store.inventory({ refresh: true })).treeSha256, await store.treeHash())
    await rm(join(root, 'inventory.json'))
    await MemoryStore.open(root, { limits, keepHistory: false })
    assert.equal(JSON.parse(await readFile(join(root, 'inventory.json'), 'utf8')).treeSha256, await store.treeHash())
  })

  it('refuses to commit without a draft and validates the episode', async () => {
    const { store } = await fresh()
    await assert.rejects(store.commit('ghost', { kind: 'practice', outcome: 'PASS' }), MemoryDraftMissingError)
    await assert.rejects(store.openDraft(''), MemoryError)
  })

  it('drops __pycache__ from drafts at commit', async () => {
    const { store } = await fresh()
    const record = await learn(store, 'py', { 'tool.py': 'print(1)', '__pycache__/tool.pyc': 'x', 'x.pyo': 'y' })
    assert.deepEqual(record.created, ['tool.py'])
    assert.deepEqual((await store.inventory()).files.map(f => f.path), ['tool.py'])
  })

  it('keeps a live owner\'s draft meta and .prev while its directory is momentarily missing (memory-crash-4)', async () => {
    const { base, root, store } = await fresh()
    const dir = join(base, 'work', 'memory')
    const owner = { kind: 'engine', pid: process.pid, host: hostname(), lineage: 'l-1' }
    const draft = await store.openDraft('ep', { dir, owner })
    await put(dir, 'lesson.md', 'learned')
    // A concurrent commit makes the draft conflict, so it is rebased with a .prev.
    await learn(store, 'other', { 'x.md': 'x' })
    await assert.rejects(store.commit('ep', { kind: 'practice', outcome: 'PASS' }), MemoryConflictError)
    await store.rebaseDraft('ep')
    await put(dir, 'lesson.md', 'learned')
    // The Actor rebuilds its draft (mv aside, mv back) while another process opens the store.
    await rename(dir, `${dir}.aside`)
    const other = await MemoryStore.open(root, { limits })
    assert.equal(await other.getDraft('ep'), undefined)
    await assert.rejects(other.commit('ep', { kind: 'practice', outcome: 'PASS' }), MemoryDraftMissingError)
    const listed = (await other.drafts()).find(d => d.episode === 'ep')
    assert.deepEqual({ dirExists: listed.dirExists, live: listed.live }, { dirExists: false, live: true })
    assert.ok((await stat(`${dir}.prev`)).isDirectory(), '.prev of a live owner is kept')
    await rename(`${dir}.aside`, dir)
    const record = await store.commit('ep', { kind: 'practice', outcome: 'PASS' })
    assert.deepEqual(record.created, ['lesson.md'])
    assert.equal(draft.dir, dir)
    // A gone owner's meta is still swept, whatever its directory's state.
    await store.openDraft('dead', { dir: join(base, 'work2', 'memory'), owner: { kind: 'engine', pid: DEAD_PID, host: hostname() } })
    await rm(join(base, 'work2', 'memory'), { recursive: true })
    await MemoryStore.open(root, { limits })
    assert.equal((await store.drafts()).some(d => d.episode === 'dead'), false)
  })

  it('a rebase interrupted at any step is finished on resume and never loses the Actor\'s draft (memory-crash-5)', async () => {
    // Each case leaves the on-disk state of a crash after one step of rebaseDraft.
    const steps = ['intent', 'old-prev-removed', 'renamed', 'partial-copy', 'done']
    for (const step of steps) {
      for (const resume of ['rebaseDraft', 'openDraft']) {
        const { base, root, store } = await fresh()
        const dir = join(base, 'work', 'memory')
        const owner = { kind: 'engine', pid: process.pid, host: hostname(), lineage: 'l-1' }
        await store.openDraft('ep', { dir, owner })
        await learn(store, 'other', { 'x.md': 'x' })
        await mkdir(`${dir}.prev`, { recursive: true })
        await put(`${dir}.prev`, 'older.md', 'an older previous draft')
        await put(dir, 'lesson.md', 'the Actor\'s work')
        await assert.rejects(store.commit('ep', { kind: 'practice', outcome: 'PASS' }), MemoryConflictError)
        const metaPath = join(root, 'drafts', 'ep.json')
        if (step === 'done') {
          await store.rebaseDraft('ep')
        } else {
          const meta = JSON.parse(await readFile(metaPath, 'utf8'))
          const dirIno = String((await lstat(dir, { bigint: true })).ino)
          await writeFile(metaPath, JSON.stringify({ ...meta, rebase: { prevDir: `${dir}.prev`, dirIno, keepPrev: false, at: '' } }))
          if (step !== 'intent') await rm(`${dir}.prev`, { recursive: true })
          if (step === 'renamed' || step === 'partial-copy') await rename(dir, `${dir}.prev`)
          if (step === 'partial-copy') await put(dir, 'partial.md', 'half a copy')
          // Mid-rebase there is no promotable draft; a commit reports a conflict and changes nothing.
          assert.equal(await store.getDraft('ep'), undefined, step)
          await assert.rejects(store.commit('ep', { kind: 'practice', outcome: 'PASS' }), MemoryConflictError)
        }
        // The resumed process (a fresh open sweeps first) finishes the rebase.
        const resumed = await MemoryStore.open(root, { limits })
        const draft = resume === 'rebaseDraft'
          ? (await resumed.rebaseDraft('ep')).draft
          : await resumed.openDraft('ep', { dir, owner })
        const label = `${step} via ${resume}`
        assert.equal(await readFile(join(`${dir}.prev`, 'lesson.md'), 'utf8'), 'the Actor\'s work', label)
        assert.deepEqual((await readdir(dir)).sort(), ['x.md'], label)
        assert.equal(draft.baseHash, await resumed.treeHash(), label)
        assert.equal(JSON.parse(await readFile(metaPath, 'utf8')).rebase, undefined, label)
        assert.ok(await resumed.getDraft('ep'), label)
        // The Actor re-applies its work and the commit goes through.
        await put(dir, 'lesson.md', 'the Actor\'s work')
        assert.deepEqual((await resumed.commit('ep', { kind: 'practice', outcome: 'PASS' })).created, ['lesson.md'], label)
      }
    }
  })

  it('never accepts a change to frozen memory; restoring the frozen snapshot is the way back (memory-crash-8)', async () => {
    const { root, store } = await fresh()
    await learn(store, 'e1', { 'a.md': 'one' })
    const r2 = await learn(store, 'e2', { 'a.md': 'two' })
    const { treeHash } = await store.freeze({ by: 'test' })
    assert.equal(treeHash, r2.treeAfter)
    await writeFile(join(store.memoryDir, 'a.md'), 'edited by hand')
    await assert.rejects(store.assertFrozenIntact(), MemoryFrozenTamperError)
    await assert.rejects(store.acceptExternal({ by: 'human' }), err => {
      assert.ok(err instanceof MemoryFrozenError)
      assert.match(err.message, /cc-rsi memory restore 2/)
      assert.equal(err.details.frozenSeq, 2)
      return true
    })
    assert.equal((await store.journal()).length, 2, 'nothing was journaled')
    // Only the snapshot of the frozen tree can be restored while frozen.
    await assert.rejects(store.restoreHistory(1, { by: 'human' }), err => err instanceof MemoryFrozenError && /restore 2/.test(err.message))
    const restored = await store.restoreHistory(2, { by: 'human' })
    assert.equal(restored.kind, 'restore')
    assert.equal(restored.treeAfter, treeHash)
    await store.assertFrozenIntact()
    await store.assertCanonicalIntact()
    assert.ok(await store.frozen())
    // A mutation journaled while frozen (before this fix): accepting the return to the frozen tree clears it.
    await writeFile(join(store.memoryDir, 'a.md'), 'edited again')
    const edited = await store.treeHash()
    await appendFile(join(root, 'journal.jsonl'), `${JSON.stringify({ v: 1, seq: 4, episode: 'external-old', kind: 'external', treeBefore: treeHash, treeAfter: edited })}\n`)
    await writeFile(join(store.memoryDir, 'a.md'), 'two')
    await assert.rejects(store.assertCanonicalIntact(), MemoryTamperError)
    const back = await store.acceptExternal({ by: 'human' })
    assert.equal(back.treeAfter, treeHash)
    await store.assertCanonicalIntact()
    await store.assertFrozenIntact()
    await store.unfreeze()
  })

  it('a stale store lock raced by several processes never yields two installs (memory-crash-1)', async () => {
    const TRIALS = 12
    const WORKERS = 3
    const SLOT_MS = 300
    const base = await tmpDir('cc-rsi-store-race-')
    const old = new Date(Date.now() - 60_000)
    const roots = []
    for (let t = 0; t < TRIALS; t++) {
      const root = join(base, `s${t}`)
      const store = await MemoryStore.open(root, { limits, keepHistory: false })
      for (let w = 0; w < WORKERS; w++) {
        const draft = await store.openDraft(`ep-${w}`, { owner: { kind: 'session', sessionId: 'never-swept' } })
        await put(draft.dir, `w${w}.md`, `lesson ${w}`)
      }
      // The store lock of a crashed holder: a gone pid, or an expired lease elsewhere.
      await writeFile(join(root, '.lock'), JSON.stringify(t % 2 === 0
        ? { pid: DEAD_PID, host: hostname(), token: 'dead:1', at: '' }
        : { pid: 1, host: 'another-container', token: 'old:1', at: '' }))
      if (t % 2 === 1) await utimes(join(root, '.lock'), old, old)
      roots.push(root)
    }
    const worker = `
      const { MemoryStore } = await import(${JSON.stringify(STORE_MODULE)})
      const [episode, startAt, slot, ...roots] = process.argv.slice(1)
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const out = []
      for (let t = 0; t < roots.length; t++) {
        const at = Number(startAt) + t * Number(slot)
        while (Date.now() < at) await sleep(Math.max(0, Math.min(5, at - Date.now() - 1)))
        const store = new MemoryStore(roots[t], { keepHistory: false, lockOptions: { pollMs: 1, waitMs: 20000 } })
        try { const r = await store.commit(episode, { kind: 'test' }); out.push('ok:' + r.seq) } catch (e) { out.push(e.code) }
      }
      console.log(JSON.stringify(out))`
    const startAt = Date.now() + 1500
    const runs = await Promise.all(Array.from({ length: WORKERS }, (_, w) => runNode('--input-type=module',
      ['-e', worker, `ep-${w}`, String(startAt), String(SLOT_MS), ...roots], { timeoutMs: 90000 })))
    for (const run of runs) assert.equal(run.code, 0, run.stderr)
    const outcomes = runs.map(run => JSON.parse(run.stdout.trim()))
    for (let t = 0; t < TRIALS; t++) {
      const results = outcomes.map(list => list[t])
      const store = new MemoryStore(roots[t], { keepHistory: false })
      const journal = await store.journal()
      const label = `trial ${t}: ${results.join(' ')}`
      assert.equal(results.filter(r => r.startsWith('ok:')).length, 1, label)
      assert.equal(results.filter(r => r === 'memory_conflict').length, WORKERS - 1, label)
      assert.deepEqual(journal.map(r => r.seq), [1], label)
      await store.assertCanonicalIntact()
      const files = await readdir(store.memoryDir)
      assert.deepEqual(files, [`w${journal[0].episode.slice(3)}.md`], label)
    }
  })

  it('opens with every documented option and closes cleanly', async () => {
    const base = await tmpDir()
    const logged = []
    const logger = { info: m => logged.push(m), warn: m => logged.push(m), error: m => logged.push(m) }
    const store = await MemoryStore.open(join(base, 's'), { limits, keepHistory: false, sealedTextFiles: [], shingleWords: 8, logger, lockOptions: { waitMs: 1000 } })
    assert.equal(store.root, join(base, 's'))
    assert.equal(store.memoryDir, join(base, 's', 'memory'))
    await store.close()
  })
})

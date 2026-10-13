// WP5 unit tests: task state machine (SPEC §11.2), request capture and task messages (§11.8),
// attestations (§11.4), workspace locks (§11.6), the memory view (§11.10), jobIsDead (§11.5).

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { projectLayout, sessionLayout } from '../../lib/core/paths.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { sweepAttestations, takeAttestation, writeAttestation } from '../../lib/interactive/attest.mjs'
import { refreshView, viewInventory, viewLooksStale } from '../../lib/interactive/memview.mjs'
import { appendRequest, isSynthetic, lastRequestSeq, readRequests, taskMessagesFor } from '../../lib/interactive/requests.mjs'
import {
  applyInfra, applyVerdict, emptyState, jobIsDead, learnTarget, mayOpenOnPrompt, openTask, readTask, withTask,
} from '../../lib/interactive/task.mjs'
import {
  acquireWorkspaceLock, listLocksSync, lockCovering, lockFileFor, markRestoreFailed, releaseWorkspaceLock, releaseWorkspaceLockFor,
} from '../../lib/interactive/wslock.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'
import { deadPid } from './harness.mjs'

async function session() {
  const home = await tmpDir('cc-rsi-home-')
  const pl = projectLayout(home, 'proj-0123456789ab')
  const sl = sessionLayout(pl, '11111111-2222-4333-8444-555555555555')
  mkdirSync(sl.dir, { recursive: true })
  return { home, pl, sl }
}

describe('task state machine', () => {
  it('opens tasks, keeps an unlearned terminal task as prevTask, and picks the learn target', () => {
    const s = emptyState('sid')
    assert.equal(mayOpenOnPrompt(s), true)
    openTask(s, { requestSeq: 1, openDigest: 'd1', openRoot: '/r' })
    assert.equal(s.taskSeq, 1)
    assert.equal(s.task.firstRequestSeq, 1)
    assert.equal(mayOpenOnPrompt(s), false, 'an open task without a PASS stays')
    applyVerdict(s, { jobId: 'j1', taskSeq: 1, generation: 1, verdict: 'FAIL', reportSha: 'a', requestSeq: 1 })
    assert.equal(mayOpenOnPrompt(s), false, 'FAIL keeps the task for repair')
    assert.deepEqual(learnTarget(s), { which: 'task', t: s.task })
    applyVerdict(s, { jobId: 'j2', taskSeq: 1, generation: 2, verdict: 'PASS', reportSha: 'b', verifierSessionId: 'v1' })
    assert.equal(s.task.verifier.sessionId, 'v1')
    assert.equal(mayOpenOnPrompt(s), true)
    openTask(s, { requestSeq: 5 })
    assert.equal(s.prevTask.seq, 1)
    assert.equal(learnTarget(s).which, 'prevTask')
    s.learning = { episode: 'x' }
    assert.equal(mayOpenOnPrompt(s), false)
    s.learning = null
    s.prevTask.learned = true
    assert.equal(learnTarget(s), null)
    openTask(s, { requestSeq: 9 })
    assert.equal(s.prevTask, null, 'a task without an unlearned terminal verdict is dropped')
  })

  it('applies a verdict once per job and clears only its own job; infra retires the context on overflow / lost transcripts', () => {
    const s = emptyState('sid')
    openTask(s, { requestSeq: 1 })
    s.job = { id: 'j1', taskSeq: 1 }
    applyVerdict(s, { jobId: 'j1', taskSeq: 1, generation: 1, verdict: 'PASS', reportSha: 'a' })
    s.task.learned = true
    applyVerdict(s, { jobId: 'j1', taskSeq: 1, generation: 1, verdict: 'PASS', reportSha: 'a' })
    assert.equal(s.task.reports.length, 1)
    assert.equal(s.task.learned, true, 'a repeated application never resets learned')
    s.job = { id: 'j2', taskSeq: 1 }
    applyVerdict(s, { jobId: 'j-other', taskSeq: 99, generation: 1, verdict: 'FAIL', reportSha: 'z' })
    assert.equal(s.job.id, 'j2', 'a verdict of another task never touches this job')
    applyInfra(s, { jobId: 'j2', taskSeq: 1, cls: 'timeout' })
    assert.equal(s.job, null)
    assert.equal(s.task.verifier.retired, false)
    applyInfra(s, { jobId: 'j3', taskSeq: 1, cls: 'session_missing', established: false })
    assert.equal(s.task.verifier.retired, false)
    applyInfra(s, { jobId: 'j3', taskSeq: 1, cls: 'context_overflow' })
    assert.equal(s.task.verifier.retired, true)
    assert.equal(s.task.lastVerdict, 'PASS', 'infra never sets a verdict')
  })

  it('withTask serializes writers across processes and moves a corrupt file aside', async () => {
    const { sl } = await session()
    const src = `
      import { withTask } from ${JSON.stringify(new URL('../../lib/interactive/task.mjs', import.meta.url).href)}
      const sl = JSON.parse(process.argv[1])
      for (let i = 0; i < 20; i++) await withTask(sl, s => { s.stop.unverifiedStops++ }, { waitMs: 20000 })
    `
    const runs = await Promise.all([1, 2, 3].map(() => runNode('--input-type=module', ['-e', src, JSON.stringify(sl)])))
    for (const r of runs) assert.equal(r.code, 0, r.stderr)
    assert.equal((await readTask(sl)).stop.unverifiedStops, 60)
    writeFileSync(sl.task, '{torn')
    const state = await withTask(sl, s => { s.taskSeq = 7 })
    assert.equal(state.taskSeq, 7)
    assert.ok(readdirSync(sl.dir).some(n => n.startsWith('task.json.corrupt-')))
  })

  it('jobIsDead: dead pid on this host, stale heartbeat without a pid; a live pid keeps the job alive', () => {
    const now = Date.now()
    const fresh = new Date(now).toISOString()
    const old = new Date(now - 60000).toISOString()
    assert.equal(jobIsDead({ status: 'done', pid: deadPid() }), false)
    assert.equal(jobIsDead({ status: 'running', pid: deadPid(), heartbeatAt: fresh }), true)
    assert.equal(jobIsDead({ status: 'running', pid: process.pid, heartbeatAt: old }), false)
    assert.equal(jobIsDead({ status: 'queued', pid: null, createdAt: fresh }), false)
    assert.equal(jobIsDead({ status: 'queued', pid: null, createdAt: old }), true)
    assert.equal(jobIsDead({ status: 'queued', pid: null, createdAt: fresh }, { pid: deadPid() }), true, 'the server-known pid counts')
    assert.equal(jobIsDead({ status: 'running', pid: 4242, host: 'another-host', heartbeatAt: fresh }), false)
    assert.equal(jobIsDead({ status: 'running', pid: 4242, host: 'another-host', heartbeatAt: old }), true)
  })
})

describe('requests', () => {
  it('detects synthetic prompts', () => {
    for (const s of ['<task-notification>x', '  <cross-session-message from="a">', '<scheduled-task>', '<local-command-stdout>', '<command-name>', '<command-message>', '/compact', '/cc-rsi:status now', '', null]) {
      assert.equal(isSynthetic(s), true, String(s))
    }
    for (const s of ['fix it', '/home/u/file.txt is broken', '/ space', 'use <task-notification> in docs']) assert.equal(isSynthetic(s), false, s)
  })

  it('appends with increasing seq and reads the last seq from the tail', async () => {
    const { sl } = await session()
    assert.equal(await lastRequestSeq(sl), 0)
    for (const text of ['a', 'b\nwith "quotes"', 'c']) await appendRequest(sl, { promptId: 'p', text })
    assert.equal(await lastRequestSeq(sl), 3)
    assert.deepEqual((await readRequests(sl)).map(r => [r.seq, r.text]), [[1, 'a'], [2, 'b\nwith "quotes"'], [3, 'c']])
    await appendRequest(sl, { text: 'x'.repeat(300000) })
    assert.equal(await lastRequestSeq(sl), 4)
    await appendRequest(sl, { text: 'tail' })
    assert.equal(await lastRequestSeq(sl), 5)
  })

  it('taskMessagesFor: current task messages, filled with earlier context, capped at 60000 chars', () => {
    const reqs = [1, 2, 3, 4, 5].map(seq => ({ seq, text: `m${seq}` }))
    assert.deepEqual(taskMessagesFor(reqs, 4, 3), [{ seq: 3, text: 'm3', current: false }, { seq: 4, text: 'm4', current: true }, { seq: 5, text: 'm5', current: true }])
    assert.deepEqual(taskMessagesFor(reqs, 1, 2).map(m => m.seq), [4, 5])
    assert.deepEqual(taskMessagesFor([], 1, 3), [])
    const big = taskMessagesFor([{ seq: 1, text: 'a'.repeat(50000) }, { seq: 2, text: 'b'.repeat(50000) }], 1, 3)
    const total = big.reduce((n, m) => n + m.text.length, 0)
    assert.ok(total <= 60000, `${total}`)
    assert.equal(big[1].text, 'b'.repeat(50000), 'the latest message is kept whole when it fits')
    assert.match(big[0].text, /\n\[… 40\d{3} chars truncated\]$/)
  })
})

describe('attestations', () => {
  it('write → take once; missing → null after the wait; sweep removes old records', async () => {
    const dir = await tmpDir('cc-rsi-att-')
    await writeAttestation(dir, { tool_use_id: 'toolu_1', tool_name: 'mcp__plugin_cc-rsi_rsi__submit', session_id: 's', cwd: '/r', agent_id: undefined })
    assert.equal(statSync(join(dir, 'toolu_1.json')).mode & 0o777, 0o600)
    const r = await takeAttestation(dir, 'toolu_1')
    assert.equal(r.session_id, 's')
    assert.equal(r.agent_id, null)
    assert.equal(await takeAttestation(dir, 'toolu_1', { waitMs: 50 }), null, 'used once')
    const t0 = Date.now()
    assert.equal(await takeAttestation(dir, 'toolu_missing', { waitMs: 200 }), null)
    assert.ok(Date.now() - t0 >= 180)
    assert.equal(await takeAttestation(dir, '../x'), null)
    setTimeout(() => { writeAttestation(dir, { tool_use_id: 'toolu_late', session_id: 's2' }) }, 100)
    assert.equal((await takeAttestation(dir, 'toolu_late', { waitMs: 2000 })).session_id, 's2', 'polled until the hook wrote it')
    await assert.rejects(writeAttestation(dir, { tool_use_id: 'a/b' }), TypeError)
    await writeAttestation(dir, { tool_use_id: 'toolu_old', session_id: 's' })
    const past = new Date(Date.now() - 2 * 3600000)
    utimesSync(join(dir, 'toolu_old.json'), past, past)
    await writeAttestation(dir, { tool_use_id: 'toolu_new', session_id: 's' })
    assert.equal(await sweepAttestations(dir), 1)
    assert.ok(existsSync(join(dir, 'toolu_new.json')))
  })
})

describe('workspace locks', () => {
  it('one live lock per root; busy for others; listed live; covering paths; released', async () => {
    const locks = await tmpDir('cc-rsi-locks-')
    const root = await tmpDir('cc-rsi-root-')
    const lock = await acquireWorkspaceLock(locks, root, { jobId: 'j1', sessionId: 's1' })
    await assert.rejects(acquireWorkspaceLock(locks, root, { jobId: 'j2', sessionId: 's2' }), e => e.code === 'workspace_busy' && /job j1/.test(e.message))
    const list = listLocksSync(locks)
    assert.equal(list.length, 1)
    assert.deepEqual([list[0].root, list[0].jobId, list[0].sessionId, list[0].live, list[0].restoreFailed], [root, 'j1', 's1', true, false])
    assert.equal(lockCovering(list, join(root, 'src', 'new-file.txt')).jobId, 'j1')
    assert.equal(lockCovering(list, root).jobId, 'j1')
    assert.equal(lockCovering(list, `${root}-sibling`), null)
    assert.equal(lockCovering(list.map(l => ({ ...l, live: false })), root), null)
    await releaseWorkspaceLock(lock)
    assert.equal(listLocksSync(locks).length, 0)
  })

  it('a stale lock (dead pid) is taken over; a restore-failed lock is sticky until released by a human', async () => {
    const locks = await tmpDir('cc-rsi-locks-')
    const root = await tmpDir('cc-rsi-root-')
    writeFileSync(lockFileFor(locks, root), JSON.stringify({ pid: deadPid(), host: (await import('node:os')).hostname(), token: 'x:y', at: new Date().toISOString(), owner: { root, jobId: 'dead', sessionId: 's', restoreFailed: false } }))
    const past = new Date(Date.now() - 60000)
    utimesSync(lockFileFor(locks, root), past, past)
    assert.equal(listLocksSync(locks)[0].live, false)
    const lock = await acquireWorkspaceLock(locks, root, { jobId: 'j2', sessionId: 's' })
    await markRestoreFailed(locks, root)
    const [record] = listLocksSync(locks)
    assert.equal(record.restoreFailed, true)
    assert.equal(record.live, true)
    utimesSync(lockFileFor(locks, root), past, past)
    assert.equal(listLocksSync(locks)[0].live, true, 'sticky: never stale')
    await assert.rejects(acquireWorkspaceLock(locks, root, { jobId: 'j3' }), e => e.code === 'workspace_busy' && /failed to restore/.test(e.message))
    assert.equal(await releaseWorkspaceLockFor(locks, root, 'j2'), false, 'recovery never removes a restore-failed lock')
    void lock
    // A missing lock is created restore-failed (recovery after a restore failure).
    const other = await tmpDir('cc-rsi-root-')
    await markRestoreFailed(locks, other, { jobId: 'j9', sessionId: 's' })
    assert.equal(listLocksSync(locks).find(l => l.root === other).restoreFailed, true)
    // releaseWorkspaceLockFor removes only the owner's own record.
    const third = await tmpDir('cc-rsi-root-')
    const l3 = await acquireWorkspaceLock(locks, third, { jobId: 'j4' })
    l3.stopHeartbeat()
    assert.equal(await releaseWorkspaceLockFor(locks, third, 'someone-else'), false)
    assert.equal(await releaseWorkspaceLockFor(locks, third, 'j4'), true)
  })
})

describe('memory view', () => {
  it('materializes a read-only copy, notices staleness cheaply, and discards edits made to the view', async () => {
    const { home, pl, sl } = await session()
    const store = await MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
    assert.equal(viewLooksStale(pl.store, sl.viewJson), true)
    const first = await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })
    assert.equal(first.changed, true)
    assert.equal(viewLooksStale(pl.store, sl.viewJson), false)
    assert.equal((await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })).changed, false)
    const draft = join(home, 'draft')
    await store.openDraft('e1', { dir: draft, owner: { kind: 'session', sessionId: 'x' } })
    writeFileSync(join(draft, 'lesson.md'), 'lesson\n')
    await store.commit('e1', { kind: 'task', outcome: 'PASS' })
    assert.equal(viewLooksStale(pl.store, sl.viewJson), true)
    assert.equal((await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })).changed, true)
    assert.equal(readFileSync(join(sl.viewDir, 'lesson.md'), 'utf8'), 'lesson\n')
    assert.equal(statSync(join(sl.viewDir, 'lesson.md')).mode & 0o777, 0o444)
    // An edit through Bash (after a chmod) is discarded by the next refresh.
    chmodSync(sl.viewDir, 0o755)
    writeFileSync(join(sl.viewDir, 'forged.md'), 'x')
    assert.equal((await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })).changed, true)
    assert.equal(existsSync(join(sl.viewDir, 'forged.md')), false)
    await store.assertCanonicalIntact()
  })

  it('shows committed memory only: a canonical change outside a commit is not materialized', async () => {
    const { home, pl, sl } = await session()
    const store = await MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
    const draft = join(home, 'draft')
    await store.openDraft('e1', { dir: draft, owner: { kind: 'session', sessionId: 'x' } })
    writeFileSync(join(draft, 'committed.md'), 'ok\n')
    await store.commit('e1', { kind: 'task', outcome: 'PASS' })
    writeFileSync(join(store.memoryDir, 'forged.md'), 'forged\n')
    const r = await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })
    assert.equal(r.tampered, true)
    assert.equal(existsSync(join(sl.viewDir, 'committed.md')), true)
    assert.equal(existsSync(join(sl.viewDir, 'forged.md')), false)
    assert.equal(r.treeSha256, await store.expectedTreeHash())
    const inv = await viewInventory(sl.viewDir)
    assert.deepEqual(inv.files.map(f => f.path), ['committed.md'])
    // Once a human accepts the change, the view follows canonical again.
    await store.acceptExternal({ by: 'test' })
    assert.equal((await refreshView({ store, viewDir: sl.viewDir, viewJson: sl.viewJson })).changed, true)
    assert.equal(existsSync(join(sl.viewDir, 'forged.md')), true)
  })
})

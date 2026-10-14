// LeaseLock (SPEC §5.4; dsh-rsi store.ts:336-399 semantics), including takeover across two
// Node processes.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LockTimeoutError } from '../../lib/core/errors.mjs'
import { LeaseLock, withLock } from '../../lib/core/lock.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const LOCK_MODULE = fileURLToPath(new URL('../../lib/core/lock.mjs', import.meta.url))
const DEAD_PID = 2 ** 22 + 4321
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('LeaseLock', () => {
  it('acquires with O_EXCL, records the holder and releases', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'sub', 'x.lock')
    const lock = new LeaseLock(path, { owner: { jobId: 'j-1' } })
    assert.equal(lock.held, false)
    assert.equal(await lock.acquire(), true)
    assert.equal(lock.held, true)
    assert.equal(await lock.acquire(), true, 're-acquiring an instance-held lock is a no-op')
    const record = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(record.pid, process.pid)
    assert.equal(record.host, hostname())
    assert.match(record.token, /^[0-9a-f]{16}:[0-9a-f]{12}$/)
    assert.deepEqual(record.owner, { jobId: 'j-1' })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const seen = await LeaseLock.inspect(path)
    assert.equal(seen.stale, false)
    assert.deepEqual(seen.holder.owner, { jobId: 'j-1' })
    await lock.release()
    assert.equal(lock.held, false)
    assert.equal(await LeaseLock.inspect(path), null)
    await lock.release()
  })

  it('a second holder in the same process waits; wait:false returns false; waitMs throws LockTimeoutError', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const a = new LeaseLock(path)
    await a.acquire()
    assert.equal(await new LeaseLock(path).acquire({ wait: false }), false)
    await assert.rejects(new LeaseLock(path, { waitMs: 200 }).acquire(), LockTimeoutError)
    const waiter = new LeaseLock(path, { waitMs: 5000, pollMs: 10 })
    const pending = waiter.acquire()
    await sleep(50)
    await a.release()
    assert.equal(await pending, true)
    await waiter.release()
  })

  it('takes over a dead pid, an earlier same-pid process, an expired lease and an old torn record', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const fresh = async () => {
      const lock = new LeaseLock(path, { waitMs: 300 })
      assert.equal(await lock.acquire(), true)
      await lock.release()
    }
    await writeFile(path, JSON.stringify({ pid: DEAD_PID, host: hostname(), token: 'x:y', at: '' }))
    assert.match((await LeaseLock.inspect(path)).reason, /gone/)
    await fresh()
    await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'earlier-process:x' }))
    assert.equal((await LeaseLock.inspect(path)).stale, true)
    await fresh()
    await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname() }))
    await fresh()
    await writeFile(path, JSON.stringify({ pid: 1, host: 'another-container', token: 't' }))
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    assert.match((await LeaseLock.inspect(path)).reason, /lease expired/)
    await fresh()
    await writeFile(path, '{"pid":')
    assert.equal((await LeaseLock.inspect(path)).stale, false, 'a fresh torn record may still be being written')
    await utimes(path, old, old)
    await fresh()
    // A live holder elsewhere is respected.
    await writeFile(path, JSON.stringify({ pid: 1, host: 'another-container', token: 't' }))
    assert.equal((await LeaseLock.inspect(path)).stale, false)
    await assert.rejects(new LeaseLock(path, { waitMs: 200 }).acquire(), LockTimeoutError)
    // A lock judged with a short lease expires without heartbeats.
    const short = new LeaseLock(path, { leaseMs: 1, waitMs: 1000 })
    assert.equal(await short.acquire(), true)
    short.stopHeartbeat()
    assert.equal(await LeaseLock.forceRelease(path), true)
    await short.release()
    assert.equal(await LeaseLock.forceRelease(path), false)
  })

  it('a record with our nonce that is no longer held is stale', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const lock = new LeaseLock(path)
    await lock.acquire()
    const content = await readFile(path, 'utf8')
    await lock.release()
    await writeFile(path, content)
    assert.match((await LeaseLock.inspect(path)).reason, /no longer held/)
    await withLock(path, async l => assert.equal(l.held, true), { waitMs: 300 })
  })

  it('heartbeats refresh the mtime; release never removes a lock taken over by someone else', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const lock = new LeaseLock(path, { heartbeatMs: 20 })
    await lock.acquire()
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    await sleep(120)
    assert.ok(Date.now() - (await stat(path)).mtimeMs < 5000)
    const other = JSON.stringify({ pid: 1, host: 'another-container', token: 'other' })
    await writeFile(path, other)
    await lock.release()
    assert.equal(await readFile(path, 'utf8'), other)
  })

  it('sticky records are never stale and updateOwner keeps the token', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const lock = new LeaseLock(path, { owner: { root: '/r', restoreFailed: false } })
    await lock.acquire()
    await lock.updateOwner({ restoreFailed: true })
    lock.stopHeartbeat()
    const record = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(record.owner.restoreFailed, true)
    assert.equal(record.token, lock.token)
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    const sticky = holder => holder.owner?.restoreFailed === true
    assert.equal((await LeaseLock.inspect(path, { sticky })).stale, false)
    assert.equal((await LeaseLock.inspect(path)).stale, true)
    assert.equal(await new LeaseLock(path, { sticky }).acquire({ wait: false }), false)
    await lock.release()
    assert.equal(await LeaseLock.inspect(path), null)
  })

  it('withLock releases after errors', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    await assert.rejects(withLock(path, async () => { throw new Error('boom') }), /boom/)
    assert.equal(await LeaseLock.inspect(path), null)
    assert.equal(await withLock(path, async () => 42), 42)
  })

  it('serializes critical sections across Node processes and takes over a SIGKILLed holder', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'shared.lock')
    const counter = join(dir, 'counter.txt')
    await writeFile(counter, '0')
    const worker = `
      const { withLock } = await import(${JSON.stringify(LOCK_MODULE)})
      const { readFile, writeFile } = await import('node:fs/promises')
      for (let i = 0; i < 15; i++) {
        await withLock(process.argv[1], async () => {
          const n = Number(await readFile(process.argv[2], 'utf8'))
          await new Promise(r => setTimeout(r, 2))
          await writeFile(process.argv[2], String(n + 1))
        }, { pollMs: 5, waitMs: 20000 })
      }`
    const runs = await Promise.all([1, 2, 3].map(() => runNode('--input-type=module', ['-e', worker, path, counter], { timeoutMs: 60000 })))
    for (const run of runs) assert.equal(run.code, 0, run.stderr)
    assert.equal(await readFile(counter, 'utf8'), '45')

    // A holder killed with SIGKILL leaves its lock; the next process takes it over at once (ESRCH).
    const holder = `
      const { LeaseLock } = await import(${JSON.stringify(LOCK_MODULE)})
      await new LeaseLock(process.argv[1]).acquire()
      console.log('held')
      setInterval(() => {}, 1000)`
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['--input-type=module', '-e', holder, path], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise(resolve => child.stdout.once('data', resolve))
    assert.equal((await LeaseLock.inspect(path)).holder.pid, child.pid)
    assert.equal(await new LeaseLock(path).acquire({ wait: false }), false, 'a live holder is respected')
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    const started = Date.now()
    const lock = new LeaseLock(path, { waitMs: 5000 })
    assert.equal(await lock.acquire(), true)
    assert.ok(Date.now() - started < 2000, 'took over without waiting for the lease')
    await lock.release()
  })

  it('release, takeover and rewrites wait for the takeover guard; a guard left by a crash is broken', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const guard = `${path}.takeover`
    await writeFile(path, JSON.stringify({ pid: DEAD_PID, host: hostname(), token: 'dead:1', at: '' }))
    // A live guard (a contender inside its compare-and-delete) holds the takeover back.
    await writeFile(guard, '')
    const lock = new LeaseLock(path, { waitMs: 5000, pollMs: 5 })
    let done = false
    const pending = lock.acquire().then(value => { done = true; return value })
    await sleep(150)
    assert.equal(done, false, 'no takeover while the guard is held')
    await rm(guard)
    assert.equal(await pending, true)
    await lock.release()
    assert.equal(existsSync(guard), false)
    // A guard older than 5 s was left by a process that died holding it.
    await writeFile(path, JSON.stringify({ pid: DEAD_PID, host: hostname(), token: 'dead:2', at: '' }))
    await writeFile(guard, '')
    const old = new Date(Date.now() - 60_000)
    await utimes(guard, old, old)
    const started = Date.now()
    const again = new LeaseLock(path, { waitMs: 5000, pollMs: 5 })
    assert.equal(await again.acquire(), true)
    assert.ok(Date.now() - started < 2000)
    await again.release()
    assert.deepEqual((await readdir(dir)).sort(), [], 'no guard, aside or temporary file is left behind')
  })

  it('compareAndDelete and compareAndReplace act only when the predicate holds under the guard', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'locks', 'r.json')
    assert.equal(await LeaseLock.compareAndDelete(path, () => true), false, 'a missing directory has nothing to delete')
    assert.equal(await LeaseLock.compareAndReplace(path, current => current === null, '{"token":"a"}\n'), true)
    assert.equal(await readFile(path, 'utf8'), '{"token":"a"}\n')
    assert.equal(await LeaseLock.compareAndReplace(path, current => current?.record?.token === 'other', '{"token":"b"}\n'), false)
    assert.equal(await LeaseLock.compareAndReplace(path, current => current?.record?.token === 'a', '{"token":"b"}\n'), true)
    assert.equal(await LeaseLock.compareAndDelete(path, current => current.record?.token === 'a'), false)
    assert.equal(await readFile(path, 'utf8'), '{"token":"b"}\n')
    assert.equal(await LeaseLock.compareAndDelete(path, current => current.record?.token === 'b' && current.content.endsWith('\n')), true)
    assert.equal(existsSync(path), false)
    assert.deepEqual(await readdir(join(dir, 'locks')), [])
  })

  it('a holder whose record was taken over is fenced: lost, onLost, no heartbeat on the new record, assertHeld throws', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const events = []
    const a = new LeaseLock(path, { heartbeatMs: 20, onLost: info => events.push(info) })
    await a.acquire()
    await a.assertHeld()
    // assertHeld re-arms the lease.
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    await a.assertHeld()
    assert.ok(Date.now() - (await stat(path)).mtimeMs < 5000)
    // Another holder replaces the record (as a takeover after an expired lease would).
    const other = `${JSON.stringify({ pid: 1, host: 'another-container', token: 'other' })}\n`
    await writeFile(path, other)
    await utimes(path, old, old)
    for (let i = 0; i < 100 && !a.lost; i++) await sleep(10)
    assert.equal(a.lost, true)
    assert.equal(a.held, false)
    assert.equal(events.length, 1)
    assert.equal(events[0].path, path)
    await sleep(80)
    assert.ok(Date.now() - (await stat(path)).mtimeMs > 50_000, 'the lost holder never refreshes the new record')
    await assert.rejects(a.assertHeld(), err => err.code === 'lock_lost')
    await assert.rejects(a.updateOwner({ x: 1 }), err => err.code === 'lock_lost')
    await a.release()
    assert.equal(await readFile(path, 'utf8'), other)
    assert.equal(events.length, 1, 'onLost is called once')
    // assertHeld and updateOwner detect a takeover by themselves too (no heartbeat).
    await rm(path)
    const b = new LeaseLock(path, { heartbeatMs: 0 })
    await b.acquire()
    await writeFile(path, other)
    await assert.rejects(b.assertHeld(), err => err.code === 'lock_lost')
    assert.equal(b.lost, true)
    await b.release()
    await rm(path)
    const c = new LeaseLock(path, { heartbeatMs: 0 })
    await c.acquire()
    await writeFile(path, other)
    await assert.rejects(c.updateOwner({ y: 1 }), err => err.code === 'lock_lost')
    assert.equal(c.lost, true)
    await c.release()
    assert.equal(await readFile(path, 'utf8'), other)
  })

  it('a stopped holder that resumes after a takeover finds itself lost and never touches the new record (memory-crash-9)', { skip: process.platform === 'win32' }, async () => {
    const dir = await tmpDir()
    const path = join(dir, 'x.lock')
    const holder = `
      const { LeaseLock } = await import(${JSON.stringify(LOCK_MODULE)})
      const lock = new LeaseLock(process.argv[1], { leaseMs: 300, heartbeatMs: 50, onLost: () => console.log('lost') })
      await lock.acquire()
      console.log('held')
      setInterval(() => {}, 1000)`
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['--input-type=module', '-e', holder, path], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    try {
      for (let i = 0; i < 500 && !out.includes('held'); i++) await sleep(10)
      assert.ok(out.includes('held'))
      child.kill('SIGSTOP')
      await sleep(600)
      const b = new LeaseLock(path, { leaseMs: 300, heartbeatMs: 0, waitMs: 3000 })
      assert.equal(await b.acquire(), true, 'the expired lease of a stopped holder is taken over')
      const old = new Date(Date.now() - 60_000)
      await utimes(path, old, old)
      child.kill('SIGCONT')
      for (let i = 0; i < 300 && !out.includes('lost'); i++) await sleep(10)
      assert.ok(out.includes('lost'), 'the resumed holder learns it lost the lock')
      await sleep(200)
      assert.ok(Date.now() - (await stat(path)).mtimeMs > 50_000, 'its heartbeat never refreshed the new record')
      assert.equal(JSON.parse(await readFile(path, 'utf8')).token, b.token)
      await b.release()
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('a stale lock raced by several processes is taken over by exactly one of them (memory-crash-1)', async () => {
    const dir = await tmpDir()
    const TRIALS = 30
    const WAITERS = 4
    const SLOT_MS = 150
    const old = new Date(Date.now() - 60_000)
    // One stale record per trial: alternately a gone pid on this host and an expired lease elsewhere.
    for (let t = 0; t < TRIALS; t++) {
      const path = join(dir, `t${t}.lock`)
      if (t % 2 === 0) {
        await writeFile(path, JSON.stringify({ pid: DEAD_PID, host: hostname(), token: `dead:${t}`, at: '' }))
      } else {
        await writeFile(path, JSON.stringify({ pid: 1, host: 'another-container', token: `old:${t}`, at: '' }))
        await utimes(path, old, old)
      }
    }
    const log = join(dir, 'holders.log')
    await writeFile(log, '')
    // Every waiter starts trial t at the same wall-clock instant and polls every 1 ms (widest race).
    const worker = `
      const { LeaseLock } = await import(${JSON.stringify(LOCK_MODULE)})
      const { appendFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const [dir, log, startAt, trials, slot] = process.argv.slice(1).map((v, i) => (i < 2 ? v : Number(v)))
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      for (let t = 0; t < trials; t++) {
        const at = startAt + t * slot
        while (Date.now() < at) await sleep(Math.max(0, Math.min(5, at - Date.now() - 1)))
        const lock = new LeaseLock(join(dir, 't' + t + '.lock'), { pollMs: 1, waitMs: 20000 })
        await lock.acquire()
        appendFileSync(log, 'A ' + t + ' ' + process.pid + '\\n')
        await sleep(10)
        appendFileSync(log, 'R ' + t + ' ' + process.pid + '\\n')
        await lock.release()
      }`
    const startAt = Date.now() + 1500
    const runs = await Promise.all(Array.from({ length: WAITERS }, () => runNode('--input-type=module',
      ['-e', worker, dir, log, String(startAt), String(TRIALS), String(SLOT_MS)], { timeoutMs: 90000 })))
    for (const run of runs) assert.equal(run.code, 0, run.stderr)
    const held = new Map()
    const max = new Map()
    const acquired = new Map()
    for (const line of (await readFile(log, 'utf8')).trim().split('\n')) {
      const [kind, t] = line.split(' ')
      const now = (held.get(t) ?? 0) + (kind === 'A' ? 1 : -1)
      held.set(t, now)
      max.set(t, Math.max(max.get(t) ?? 0, now))
      if (kind === 'A') acquired.set(t, (acquired.get(t) ?? 0) + 1)
    }
    const violations = [...max].filter(([, n]) => n > 1)
    assert.deepEqual(violations, [], `trials with concurrent holders: ${JSON.stringify(violations)}`)
    assert.equal(acquired.size, TRIALS)
    for (const [t, n] of acquired) assert.equal(n, WAITERS, `trial ${t}`)
  })
})

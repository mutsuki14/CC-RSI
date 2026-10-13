// LeaseLock (SPEC §5.4; dsh-rsi store.ts:336-399 semantics), including takeover across two
// Node processes.

import assert from 'node:assert/strict'
import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
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
})

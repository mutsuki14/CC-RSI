// Machine identity (portability-7): records written on this machine under an older hostname (macOS
// renames hosts) are still this machine's, so a dead holder is judged gone at once.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { LeaseLock } from '../../lib/core/lock.mjs'
import { computeMachineId, machineId, sameMachine } from '../../lib/core/machine.mjs'
import { jobIsDead } from '../../lib/interactive/task.mjs'
import { listLocksSync, lockFileFor } from '../../lib/interactive/wslock.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid
const OLD_HOST = 'Johns-Old-MacBook.local'

describe('machine identity', () => {
  it('is stable within a process and never the raw OS id', () => {
    const id = machineId()
    assert.equal(machineId(), id)
    assert.ok(id === null || /^(os|local):[0-9a-f]{32}$/.test(id), id)
  })

  it('is never taken from a directory two machines may share, and differs per pid namespace (r2-concurrency-3)', async () => {
    const dir = await tmpDir('cc-rsi-machine-')
    // Two hosts that share one cc-rsi home and have no OS machine id: each keeps its own local id.
    const home = join(dir, 'shared-home')
    mkdirSync(join(home, 'run'), { recursive: true })
    writeFileSync(join(home, 'run', 'machine-id'), `${'ab'.repeat(16)}\n`)
    const a = computeMachineId({ osFiles: [], localPath: join(dir, 'host-a', 'machine-id'), platform: 'linux', nsPath: join(dir, 'none') })
    const b = computeMachineId({ osFiles: [], localPath: join(dir, 'host-b', 'machine-id'), platform: 'linux', nsPath: join(dir, 'none') })
    assert.match(a, /^local:[0-9a-f]{32}$/)
    assert.notEqual(a, b)
    assert.equal(computeMachineId({ osFiles: [], localPath: join(dir, 'host-a', 'machine-id'), platform: 'linux', nsPath: join(dir, 'none') }), a, 'stable')
    // The id the old code kept in the shared home grants no sameness to another host's records.
    assert.equal(sameMachine({ host: 'mac-b', machine: `home:${'ab'.repeat(16)}` }), false)
    // Containers on one kernel (one /etc/machine-id, separate pid namespaces) are different machines.
    const osFile = join(dir, 'os-machine-id')
    writeFileSync(osFile, 'f00d\n')
    symlinkSync('pid:[4026531836]', join(dir, 'ns1'))
    symlinkSync('pid:[4026532999]', join(dir, 'ns2'))
    const c1 = computeMachineId({ osFiles: [osFile], platform: 'linux', nsPath: join(dir, 'ns1') })
    assert.notEqual(c1, computeMachineId({ osFiles: [osFile], platform: 'linux', nsPath: join(dir, 'ns2') }))
    assert.equal(c1, computeMachineId({ osFiles: [osFile], platform: 'linux', nsPath: join(dir, 'ns1') }))
    // macOS: the hardware UUID seeds the local id, so a lost id file comes back the same.
    const m1 = computeMachineId({ osFiles: [], localPath: join(dir, 'mac-1', 'machine-id'), platform: 'darwin', uuid: () => 'UUID-1' })
    assert.equal(m1, computeMachineId({ osFiles: [], localPath: join(dir, 'mac-1b', 'machine-id'), platform: 'darwin', uuid: () => 'UUID-1' }))
    assert.notEqual(m1, computeMachineId({ osFiles: [], localPath: join(dir, 'mac-2', 'machine-id'), platform: 'darwin', uuid: () => 'UUID-2' }))
  })

  it('a live lease of another host that shared the old home id stays live (r2-concurrency-3)', async () => {
    const dir = await tmpDir('cc-rsi-lock-')
    const path = join(dir, 'x.lock')
    // pid 1 exists here too; the other host's record must be judged by its lease, never by our pids.
    writeFileSync(path, `${JSON.stringify({ pid: 999999, host: 'mac-a', machine: `home:${'ab'.repeat(16)}`, token: 'a:b', at: new Date().toISOString(), owner: {} })}\n`)
    const verdict = await LeaseLock.inspect(path, { leaseMs: 60000 })
    assert.equal(verdict.stale, false, verdict.reason)
    assert.equal(await new LeaseLock(path, { leaseMs: 60000, heartbeatMs: 0 }).acquire({ wait: false }), false)
  })

  it('a record is this machine\'s by machine id or by hostname; the id never makes a same-host record foreign', () => {
    const mine = machineId()
    if (mine !== null) assert.equal(sameMachine({ host: OLD_HOST, machine: mine }), true)
    assert.equal(sameMachine({ host: hostname() }), true)
    assert.equal(sameMachine({ host: hostname(), machine: 'os:0000000000000000000000000000dead' }), true)
    assert.equal(sameMachine({ host: OLD_HOST, machine: 'os:0000000000000000000000000000dead' }), false)
    assert.equal(sameMachine({ host: OLD_HOST }), false)
    assert.equal(sameMachine(null), false)
  })

  it('a lease left by a dead pid of this machine under its old hostname is taken over at once', { skip: machineId() === null ? 'no machine id here' : false }, async () => {
    const dir = await tmpDir('cc-rsi-lock-')
    const path = join(dir, 'x.lock')
    writeFileSync(path, `${JSON.stringify({ pid: deadPid(), host: OLD_HOST, machine: machineId(), token: 'old:token', at: new Date().toISOString(), owner: {} })}\n`)
    const lock = new LeaseLock(path, { leaseMs: 60000, heartbeatMs: 0 })
    assert.equal(await lock.acquire({ wait: false }), true, 'the holder pid is gone on this machine')
    await lock.release()
    // Without a machine id the old hostname reads as another host: the lease must expire first.
    writeFileSync(path, `${JSON.stringify({ pid: deadPid(), host: OLD_HOST, token: 'old:token', at: new Date().toISOString(), owner: {} })}\n`)
    assert.equal(await new LeaseLock(path, { leaseMs: 60000, heartbeatMs: 0 }).acquire({ wait: false }), false)
  })

  it('a renamed host\'s dead checkpoint-open workspace lock is recovered, and its dead job is dead', { skip: machineId() === null ? 'no machine id here' : false }, async () => {
    const home = await tmpDir('cc-rsi-home-')
    const locks = join(home, 'run', 'locks')
    mkdirSync(locks, { recursive: true })
    const root = await tmpDir('cc-rsi-root-')
    const jobFile = join(home, 'projects', 'p', 'sessions', 's', 'jobs', 'j-1.json')
    const pid = deadPid()
    writeFileSync(lockFileFor(locks, root), JSON.stringify({ pid, host: OLD_HOST, machine: machineId(), token: 'x:y', at: new Date().toISOString(),
      owner: { root, jobId: 'j-1', sessionId: 's', jobFile, restoreFailed: false, checkpointOpen: true } }))
    const [lock] = listLocksSync(locks)
    assert.equal(lock.recoveryPending, true)
    const job = { status: 'running', pid, host: OLD_HOST, machine: machineId(), heartbeatAt: new Date().toISOString() }
    assert.equal(jobIsDead(job), true)
    assert.equal(jobIsDead({ ...job, machine: undefined }), false, 'another host: only the heartbeat can tell')
  })
})

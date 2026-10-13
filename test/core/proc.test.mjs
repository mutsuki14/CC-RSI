// Process helpers (SPEC §0 "Processes", §5.5).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { killGracefully, pidAlive, runCapture, spawnDetached } from '../../lib/core/proc.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(20)
  }
  return false
}

/** A child that logs each signal it receives and ignores SIGINT/SIGTERM unless told to exit on one. */
const SIGNAL_LOGGER = `
  const fs = require('node:fs')
  const [log, exitOn] = process.argv.slice(1)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fs.appendFileSync(log, sig + '\\n'); if (sig === exitOn) process.exit(0) })
  fs.appendFileSync(log, 'ready\\n')
  setInterval(() => {}, 1000)`

describe('proc', () => {
  it('pidAlive', () => {
    assert.equal(pidAlive(process.pid), true)
    assert.equal(pidAlive(2 ** 22 + 999), false)
    assert.equal(pidAlive(0), false)
    assert.equal(pidAlive(-1), false)
    assert.equal(pidAlive('12'), false)
  })

  it('killGracefully sends SIGINT → SIGTERM → SIGKILL in order', async () => {
    const dir = await tmpDir()
    const log = join(dir, 'signals.log')
    const pid = spawnDetached(process.execPath, ['-e', SIGNAL_LOGGER, log, 'none'], { logFile: join(dir, 'child.log') })
    assert.ok(await waitFor(async () => (await readFile(log, 'utf8').catch(() => '')).includes('ready')))
    const started = Date.now()
    assert.equal(await killGracefully(pid, { graceMs: 300 }), 'killed')
    assert.ok(Date.now() - started >= 550)
    assert.equal(pidAlive(pid), false)
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['ready', 'SIGINT', 'SIGTERM'])
  })

  it('killGracefully stops at SIGTERM when the process exits; reports gone for a dead pid', async () => {
    const dir = await tmpDir()
    const log = join(dir, 'signals.log')
    const pid = spawnDetached(process.execPath, ['-e', SIGNAL_LOGGER, log, 'SIGTERM'], { logFile: join(dir, 'child.log') })
    assert.ok(await waitFor(async () => (await readFile(log, 'utf8').catch(() => '')).includes('ready')))
    assert.equal(await killGracefully(pid, { graceMs: 300 }), 'exited')
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['ready', 'SIGINT', 'SIGTERM'])
    assert.equal(await killGracefully(pid, { graceMs: 10 }), 'gone')
  })

  it('killGracefully with group stops the whole process group', async () => {
    const dir = await tmpDir()
    const childPidFile = join(dir, 'grandchild.pid')
    const parent = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const c = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
      fs.writeFileSync(process.argv[1], String(c.pid))
      process.on('SIGINT', () => {})
      setInterval(() => {}, 1000)`
    const pid = spawnDetached(process.execPath, ['-e', parent, childPidFile], { logFile: join(dir, 'p.log') })
    assert.ok(await waitFor(async () => (await readFile(childPidFile, 'utf8').catch(() => '')) !== ''))
    const grandchild = Number(await readFile(childPidFile, 'utf8'))
    assert.equal(pidAlive(grandchild), true)
    const result = await killGracefully(pid, { graceMs: 300, group: true })
    assert.ok(['exited', 'killed'].includes(result))
    assert.ok(await waitFor(() => !pidAlive(grandchild), 3000))
  })

  it('spawnDetached starts a group leader that outlives its parent, with output in the log file', async () => {
    const dir = await tmpDir()
    const logFile = join(dir, 'logs', 'job.log')
    const pid = spawnDetached(process.execPath, ['-e', 'console.log("out " + process.pid); console.error("err")'], { logFile, cwd: dir, env: { ...process.env, X: '1' } })
    assert.ok(Number.isInteger(pid))
    assert.ok(await waitFor(async () => (await readFile(logFile, 'utf8').catch(() => '')).includes('err')))
    assert.match(await readFile(logFile, 'utf8'), new RegExp(`out ${pid}`))
    assert.throws(() => spawnDetached(join(dir, 'no-such-binary'), [], { logFile }), err => err.code === 'spawn_failed' || err.code === 'ENOENT')
  })

  it('runCapture captures output, input, exit codes and timeouts and never rejects', async () => {
    const ok = await runCapture(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); console.error("e")'], { input: 'piped' })
    assert.deepEqual({ code: ok.code, stdout: ok.stdout, stderr: ok.stderr.trim(), timedOut: ok.timedOut }, { code: 0, stdout: 'piped', stderr: 'e', timedOut: false })
    const fail = await runCapture(process.execPath, ['-e', 'process.exit(3)'])
    assert.equal(fail.code, 3)
    const slow = await runCapture(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })
    assert.equal(slow.timedOut, true)
    assert.equal(slow.code, null)
    assert.equal(slow.signal, 'SIGTERM')
    const missing = await runCapture('/nonexistent/binary', [])
    assert.equal(missing.code, null)
    assert.equal(missing.error, 'ENOENT')
    const big = await runCapture(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], { maxBuffer: 100 })
    assert.equal(big.stdout.length, 100)
    assert.equal(big.truncated, true)
    const cwd = await tmpDir()
    assert.equal((await runCapture(process.execPath, ['-e', 'process.stdout.write(process.cwd() + process.env.Y)'], { cwd, env: { ...process.env, Y: '!' } })).stdout, `${cwd}!`)
  })

  it('pidAlive is false after a spawned child exits (reaped)', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise(resolve => child.once('exit', resolve))
    assert.ok(await waitFor(() => !pidAlive(child.pid), 2000))
  })
})

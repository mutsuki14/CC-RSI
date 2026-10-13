// lib/runtime/child.mjs runInvocation: line splitting (split UTF-8), stream/stderr files, the 64 KiB stderr tail,
// watchdog and abort stops (SIGINT first), spawn errors, and grandchildren that keep the pipes open.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureClaude, runInvocation } from '../../lib/runtime/child.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

async function script(source) {
  const dir = await tmpDir('cc-rsi-child-')
  const file = join(dir, 'child.cjs')
  writeFileSync(file, source)
  return { dir, file }
}

test('stdout lines (a multi-byte character split across chunks), stdin, stream.jsonl and stderr.txt', async () => {
  const { dir, file } = await script(`
    let input = ''
    process.stdin.on('data', d => { input += d })
    process.stdin.on('end', () => {
      const b = Buffer.from(JSON.stringify({ t: 'é中', input }) + '\\n' + JSON.stringify({ n: 2 }))
      process.stdout.write(b.subarray(0, 9))
      setTimeout(() => { process.stdout.write(b.subarray(9)); process.stderr.write('E'.repeat(70000) + 'TAIL') }, 30)
    })`)
  const r = await runInvocation({ bin: process.execPath, argv: [file], env: process.env, stdin: 'hello\n', timeoutSec: 20, dir })
  assert.equal(r.exitCode, 0)
  assert.equal(r.killedBy, null)
  assert.deepEqual(r.lines.map(l => JSON.parse(l)), [{ t: 'é中', input: 'hello\n' }, { n: 2 }], 'a final line without a newline is kept')
  assert.equal(readFileSync(join(dir, 'stream.jsonl'), 'utf8'), `${r.lines[0]}\n${r.lines[1]}`)
  assert.equal(r.stderr.length, 64 * 1024)
  assert.ok(r.stderr.endsWith('TAIL'))
  assert.equal(readFileSync(join(dir, 'stderr.txt'), 'utf8'), r.stderr)
  assert.ok(r.durationMs >= 0)
})

test('the watchdog stops a child with SIGINT first', async () => {
  const { file } = await script("process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000)")
  const r = await runInvocation({ bin: process.execPath, argv: [file], env: process.env, timeoutSec: 0.3, graceMs: 2000 })
  assert.equal(r.killedBy, 'watchdog')
  assert.equal(r.exitCode, 130)
})

test('a child ignoring SIGINT and SIGTERM is killed after the grace periods', async () => {
  const { file } = await script("process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")
  const t0 = Date.now()
  const r = await runInvocation({ bin: process.execPath, argv: [file], env: process.env, timeoutSec: 0.2, graceMs: 200 })
  assert.equal(r.killedBy, 'watchdog')
  assert.equal(r.signal, 'SIGKILL')
  assert.ok(Date.now() - t0 < 10000)
})

test('abort: before the spawn nothing runs; during the run the child is stopped', async () => {
  const { file } = await script("process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000)")
  const pre = new AbortController()
  pre.abort()
  const r0 = await runInvocation({ bin: process.execPath, argv: [file], env: process.env, signal: pre.signal })
  assert.equal(r0.killedBy, 'stop')
  assert.equal(r0.pid, null)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 200)
  const r1 = await runInvocation({ bin: process.execPath, argv: [file], env: process.env, signal: ac.signal, timeoutSec: 30 })
  assert.equal(r1.killedBy, 'stop')
  assert.equal(r1.exitCode, 130)
})

test('a missing binary is a spawn error, never a rejection', async () => {
  const dir = await tmpDir()
  const r = await runInvocation({ bin: join(dir, 'no-such-claude'), argv: [], env: process.env, dir })
  assert.equal(r.spawnError?.code, 'ENOENT')
  assert.equal(r.exitCode, null)
  const c = await captureClaude(join(dir, 'no-such-claude'), ['--version'])
  assert.equal(c.code, null)
})

test('a grandchild holding the pipes open does not hang the invocation', async () => {
  const { file } = await script(`
    const { spawn } = require('node:child_process')
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
    g.unref()
    process.stdout.write(JSON.stringify({ grandchild: g.pid }) + '\\n')
    process.exit(0)`)
  const t0 = Date.now()
  const r = await runInvocation({ bin: process.execPath, argv: [file], env: process.env, timeoutSec: 30 })
  const { grandchild } = JSON.parse(r.lines[0])
  try { process.kill(grandchild, 'SIGKILL') } catch { /* already gone */ }
  assert.equal(r.exitCode, 0)
  assert.equal(r.lines.length, 1)
  assert.ok(Date.now() - t0 < 10000, 'returns after the close grace, not after the grandchild')
})

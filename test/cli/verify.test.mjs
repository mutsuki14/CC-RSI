// `cc-rsi verify cancel` ★ (SPEC §13.1): signals the running verification job of a session so that
// its own finally-restore runs and it records infra `cancelled`; the CLI never writes job state.
// The job here is a stand-in process (named verify-job.mjs) that behaves like the real job on SIGINT.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { jobProcessIdentity, main, processProbe } from '../../lib/cli/main.mjs'
import { pidAlive } from '../../lib/core/proc.mjs'
import { projectKey, projectLayout, sessionLayout } from '../../lib/core/paths.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const children = []
after(() => {
  for (const child of children) {
    try { process.kill(child.pid, 'SIGKILL') } catch { /* gone */ }
  }
})

const STAND_IN = `
import { readFileSync, writeFileSync } from 'node:fs'
const file = process.argv[2]
const write = patch => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }))
write({ status: 'running', pid: process.pid, startedAt: new Date().toISOString() })
const stop = () => {
  // The real job restores the candidate in its finally block, then records infra 'cancelled'.
  write({ status: 'infra', infra: { cls: 'cancelled', detail: 'the verification was cancelled; the candidate was restored; this is not a verdict' } })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setInterval(() => {}, 1000)
`

async function waitFor(predicate, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(res => setTimeout(res, 50))
  }
  return false
}

describe('cc-rsi verify cancel', () => {
  it('stops the running job gracefully; the job records infra cancelled', async () => {
    const { home, env } = await tmpHome()
    for (const name of Object.keys(env)) if (name.startsWith('CC_RSI_')) delete env[name]
    env.CC_RSI_HOME = home
    const repo = await gitRepo({ 'a.txt': 'a\n' })
    const pl = projectLayout(home, projectKey(await gitProjectRoot(repo)))
    const sid = '22222222-3333-4444-8555-666666666666'
    const sl = sessionLayout(pl, sid)
    mkdirSync(sl.jobs, { recursive: true })
    const jobId = 'j-20261013000000-aaaaaa'
    const jobFile = join(sl.jobs, `${jobId}.json`)
    writeFileSync(jobFile, JSON.stringify({ v: 1, id: jobId, status: 'queued', sessionId: sid, candidateRoot: repo }))
    const dir = await tmpDir('cc-rsi-job-')
    writeFileSync(join(dir, 'verify-job.mjs'), STAND_IN)
    const child = spawn(process.execPath, [join(dir, 'verify-job.mjs'), jobFile], { detached: true, stdio: 'ignore' })
    children.push(child)
    assert.ok(await waitFor(() => JSON.parse(readFileSync(jobFile, 'utf8')).status === 'running'))
    const out = []
    const io = { stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => out.push(s) }, env, cwd: repo, isTTY: false }
    assert.equal(await main(['verify', 'cancel', '--session', sid], { ...io, env: { ...env, CLAUDECODE: '1' } }), 65)
    assert.equal(JSON.parse(readFileSync(jobFile, 'utf8')).status, 'running', 'refused under CLAUDECODE')
    const code = await main(['verify', 'cancel', '--session', sid, '--grace', '10'], io)
    assert.equal(code, 0, out.join(''))
    const job = JSON.parse(readFileSync(jobFile, 'utf8'))
    assert.equal(job.status, 'infra')
    assert.equal(job.infra.cls, 'cancelled')
    assert.match(out.join(''), new RegExp(`job ${jobId}: stopped; status infra \\(cancelled\\)`))
    // Nothing left to cancel.
    out.length = 0
    assert.equal(await main(['verify', 'cancel', '--session', sid], io), 0)
    assert.match(out.join(''), /no verification is running/)
  })

  it('never signals a live pid it cannot identify as the job (portability-1: pid reuse without /proc)', async () => {
    const { home, env } = await tmpHome()
    for (const name of Object.keys(env)) if (name.startsWith('CC_RSI_')) delete env[name]
    env.CC_RSI_HOME = home
    const repo = await gitRepo({ 'a.txt': 'a\n' })
    const pl = projectLayout(home, projectKey(await gitProjectRoot(repo)))
    const sid = '44444444-3333-4444-8555-666666666666'
    const sl = sessionLayout(pl, sid)
    mkdirSync(sl.jobs, { recursive: true })
    // A job that crashed without updating its file; its pid now belongs to an unrelated process.
    const victim = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
    children.push(victim)
    const jobId = 'j-20261013000000-bbbbbb'
    const jobFile = join(sl.jobs, `${jobId}.json`)
    writeFileSync(jobFile, JSON.stringify({ v: 1, id: jobId, status: 'running', sessionId: sid, pid: victim.pid, host: hostname(), heartbeatAt: '2026-01-01T00:00:00.000Z' }))
    const out = []
    const io = { stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => out.push(s) }, env, cwd: repo, isTTY: false }
    const saved = { ...processProbe }
    try {
      // As on macOS (no /proc) with no usable ps: the command line is unknown.
      processProbe.cmdline = () => null
      assert.equal(await main(['verify', 'cancel', '--session', sid, '--grace', '1'], io), 3, out.join(''))
      assert.match(out.join(''), /is not cancelled: pid \d+ cannot be identified as the job/)
      await new Promise(res => setTimeout(res, 300))
      assert.equal(pidAlive(victim.pid), true, 'the unrelated process was not signalled')
      // With a readable command line (Linux /proc), the unrelated program is recognised as such: the job is gone.
      Object.assign(processProbe, saved)
      out.length = 0
      processProbe.cmdline = () => 'sleep 600'
      assert.equal(await main(['verify', 'cancel', '--session', sid, '--grace', '1'], io), 0, out.join(''))
      assert.match(out.join(''), /has no live process \(pid \d+ runs another program now: sleep 600\)/)
      assert.equal(pidAlive(victim.pid), true)
      assert.equal(JSON.parse(readFileSync(jobFile, 'utf8')).status, 'running', 'the CLI never writes job state')
    } finally {
      Object.assign(processProbe, saved)
    }
  })

  it('identifies the job by start token, command line or a fresh heartbeat on this host only', () => {
    const now = Date.parse('2026-10-13T12:00:00Z')
    const file = '/h/projects/p/sessions/s/jobs/j-1.json'
    const job = { id: 'j-1', status: 'running', pid: 4242, host: hostname(), heartbeatAt: new Date(now - 10000).toISOString() }
    const probe = cmd => ({ cmdline: () => cmd, pgid: () => null })
    // Unknown command line: a fresh heartbeat (< 90 s) on this host proves the job; a stale one does not.
    assert.equal(jobProcessIdentity(job, file, { now, probe: probe(null) }).ok, true)
    assert.equal(jobProcessIdentity({ ...job, heartbeatAt: new Date(now - 600000).toISOString() }, file, { now, probe: probe(null) }).ok, false)
    assert.equal(jobProcessIdentity({ ...job, host: undefined }, file, { now, probe: probe(null) }).ok, false)
    // Another host: never.
    assert.equal(jobProcessIdentity({ ...job, host: 'elsewhere.example' }, file, { now, probe: probe(`node verify-job.mjs run ${file}`) }).ok, false)
    // Command line: verify-job and the job file name are both required.
    assert.equal(jobProcessIdentity(job, file, { now: now + 3600000, probe: probe(`node /p/lib/interactive/verify-job.mjs run ${file}`) }).ok, true)
    assert.equal(jobProcessIdentity(job, file, { now: now + 3600000, probe: probe('node /p/lib/interactive/verify-job.mjs run /x/j-2.json') }).ok, false)
    assert.equal(jobProcessIdentity(job, file, { now, probe: probe('vim notes.txt') }).ok, false, 'a readable foreign command line beats a fresh heartbeat')
    assert.equal(jobProcessIdentity(job, file, { now, probe: probe('vim notes.txt') }).other, true)
    assert.equal(jobProcessIdentity({ ...job, heartbeatAt: null }, file, { now, probe: probe(null) }).other, false, 'unknown is not "another process"')
    // A recorded start token decides first.
    const withToken = { ...job, pidStart: 'linux:boot:123' }
    assert.equal(jobProcessIdentity(withToken, file, { now, probe: probe(`verify-job ${file}`), sameStart: () => false }).ok, false)
    assert.equal(jobProcessIdentity(withToken, file, { now: now + 3600000, probe: probe(null), sameStart: () => true }).ok, true)
  })
})

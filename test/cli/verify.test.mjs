// `cc-rsi verify cancel` ★ (SPEC §13.1): signals the running verification job of a session so that
// its own finally-restore runs and it records infra `cancelled`; the CLI never writes job state.
// The job here is a stand-in process (named verify-job.mjs) that behaves like the real job on SIGINT.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { main } from '../../lib/cli/main.mjs'
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
})

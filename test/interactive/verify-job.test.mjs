// WP5: the verification job run directly (SPEC §11.5): the Verifier role spec and isolation record,
// workspace_busy, checkpoint_failed, sandbox_required, a lost Verifier context (R3 both ways),
// cancellation, restore failure keeping the lock, detect-only checkpoints, recovery of a finished
// job, run-once semantics and the CLI refusals.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { writeJsonAtomic } from '../../lib/core/atomic.mjs'
import { loadConfig } from '../../lib/core/config.mjs'
import { newJobId } from '../../lib/core/ids.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { staticProbe } from '../../lib/runtime/sandbox.mjs'
import { openTask, readTask, withTask } from '../../lib/interactive/task.mjs'
import { acquireWorkspaceLock, listLocksSync, releaseWorkspaceLock } from '../../lib/interactive/wslock.mjs'
import { recoverJob, runJob, verifierHidden } from '../../lib/interactive/verify-job.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { ROOT, deadPid, layouts, reapJobs, setupProject } from './harness.mjs'

const homes = []
after(async () => { for (const h of homes) await reapJobs(h) })

/** A queued job file + task state exactly as the submit tool writes them. */
async function queuedJob(p, { config: patch = {}, verifier = {}, taskReports = [], candidateRoot } = {}) {
  homes.push(p.home)
  const { sl, pl } = layouts(p)
  const { config } = loadConfig({ home: p.home, projectRoot: p.repo, cli: patch })
  const id = newJobId()
  const sessionId = verifier.sessionId ?? randomUUID()
  let job
  await withTask(sl, s => {
    if (!s.task) openTask(s, { requestSeq: 1, openRoot: p.repo })
    s.task.candidateRoot = candidateRoot ?? p.repo
    s.task.generation += 1
    s.task.verifier.ctxIndex = 1
    s.task.verifier.ctxKey = 'task-1-v1'
    job = {
      v: 1, id, status: 'queued', sessionId: p.sid, projectKey: pl.dir.split('/').pop(), taskSeq: s.task.seq, generation: s.task.generation,
      candidateRoot: candidateRoot ?? p.repo, pluginRoot: ROOT, home: p.home,
      verifier: { ctxKey: 'task-1-v1', sessionId, fresh: true, model: 'test-model', modelSource: 'config', ...verifier },
      taskMessages: [{ seq: 1, text: 'Keep src/app.txt at version 1', current: true }], leadsText: null, leadsIgnored: false,
      priorReportShas: taskReports.map(r => r.sha), taskReports, baselineFile: null, prevManifest: null, config, isolationWant: config.isolation.sandbox,
      createdAt: new Date().toISOString(), startedAt: null, pid: null, heartbeatAt: null, checkpoint: null, result: null, infra: null, delivered: false,
    }
    s.job = { id, pid: null, gen: job.generation, taskSeq: job.taskSeq, startedAt: job.createdAt }
  })
  const file = join(sl.jobs, `${id}.json`)
  await writeJsonAtomic(file, job)
  return { file, job, sl, pl }
}

const verifierLog = p => p.fake.log().filter(e => e.ccRsi?.CC_RSI_ROLE === 'verifier')

describe('verification job', () => {
  it('runs the Verifier with the interactive role spec and records the isolation actually used', async () => {
    const p = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'git push origin main' }, { tool: 'Bash', command: 'cat README.md' }], text: 'Looks right.\nVERDICT: PASS' } } } })
    const { file, sl } = await queuedJob(p)
    const job = await runJob(file, { env: p.env })
    assert.equal(job.status, 'done')
    assert.equal(job.result.verdict, 'PASS')
    assert.equal(job.result.isolation.mode, staticProbe().available ? 'sandbox' : 'rollback')
    assert.equal(job.result.model, 'test-model')
    assert.equal(job.result.invocations, 1)
    assert.equal(typeof job.result.candidateDigest, 'string')
    assert.match(job.result.statusDigest, /^[0-9a-f]{64}$/)
    assert.equal(job.pid, process.pid)
    const state = await readTask(sl)
    assert.equal(state.job, null)
    assert.equal(state.task.lastVerdict, 'PASS')
    const [entry] = verifierLog(p)
    assert.deepEqual(entry.argv.slice(entry.argv.indexOf('--tools') + 1), ['Read,Grep,Glob,Bash'])
    assert.ok(entry.envKeys.includes('VERIFIER_SCRATCH') && entry.envKeys.includes('TMPDIR') && entry.envKeys.includes('DISABLE_AUTO_COMPACT'))
    // The role policy: read-only candidate, private scratch, harness state hidden, mutation patterns without a sandbox.
    const metaDir = join(sl.ctx, 'task-1-v1', '1')
    const meta = JSON.parse(readFileSync(join(metaDir, 'meta.json'), 'utf8'))
    const policy = JSON.parse(readFileSync(meta.policyFile, 'utf8'))
    assert.equal(policy.role, 'verifier')
    assert.deepEqual(policy.readOnlyRoots, [p.repo])
    assert.ok(policy.allowedPaths.includes(join(p.home, 'vscratch', job.verifier.sessionId)))
    for (const h of ['projects', 'run', 'bin', 'config.json', 'work']) assert.ok(policy.hidden.includes(join(p.home, h)), h)
    assert.ok(policy.hiddenTokens.includes('actor-private'))
    if (job.result.isolation.mode === 'rollback') {
      assert.ok(policy.bashDeny.length > 0)
      const guardLog = readFileSync(join(metaDir, 'guard.jsonl'), 'utf8')
      assert.match(guardLog, /"decision":"deny","reason":"[^"]*git push/)
    }
    const prompt = readFileSync(join(metaDir, 'prompt.md'), 'utf8')
    assert.match(prompt, /AUTHORITATIVE TASK — verbatim:\n---\nKeep src\/app\.txt at version 1\n---/)
    assert.match(prompt, /CANDIDATE ROOT: /)
    assert.match(prompt, /The working tree has no uncommitted changes\./)
    const system = readFileSync(meta.systemFile, 'utf8')
    if (job.result.isolation.mode === 'rollback') assert.match(system, /Your shell commands are NOT sandboxed/)
  })

  it('the hidden roots never contain the Verifier\'s own cwd or scratch', () => {
    const hidden = verifierHidden({ home: '/h', scratch: '/h/vscratch/v1', cwd: '/h/work/k/x/projects/t001', env: { HOME: '/u' } })
    assert.ok(!hidden.includes('/h/work'), 'a root containing the cwd is dropped')
    assert.ok(hidden.includes('/h/projects'))
    assert.ok(!hidden.some(h => h === '/h/vscratch/v1'))
    assert.ok(hidden.includes('/u/.claude/projects'))
  })

  it('workspace_busy when another verification holds the root; nothing runs, the lock stays theirs', async () => {
    const p = await setupProject({ script: { verifier: { default: { text: 'VERDICT: PASS' } } } })
    const { file, sl } = await queuedJob(p)
    const other = await acquireWorkspaceLock(layouts(p).g.locks, p.repo, { jobId: 'j-other', sessionId: 'other' })
    try {
      const job = await runJob(file, { env: p.env })
      assert.equal(job.status, 'infra')
      assert.equal(job.infra.cls, 'workspace_busy')
      assert.equal(job.checkpoint, null)
      assert.equal(verifierLog(p).length, 0)
      assert.equal(listLocksSync(layouts(p).g.locks)[0].jobId, 'j-other')
      assert.equal((await readTask(sl)).job, null)
    } finally {
      await releaseWorkspaceLock(other)
    }
  })

  it('checkpoint_failed when the candidate root is unusable; sandbox_required when require meets no sandbox', async () => {
    const p = await setupProject({ script: { verifier: { default: { text: 'VERDICT: PASS' } } } })
    const missing = join(p.repo, 'does-not-exist')
    const a = await queuedJob(p, { candidateRoot: missing })
    const job = await runJob(a.file, { env: p.env })
    assert.equal(job.infra.cls, 'checkpoint_failed')
    assert.equal(listLocksSync(layouts(p).g.locks).length, 0)
    if (!staticProbe().available) {
      const b = await queuedJob(p, { config: { isolation: { sandbox: 'require' } } })
      const refused = await runJob(b.file, { env: p.env })
      assert.equal(refused.infra.cls, 'sandbox_required')
      assert.match(refused.infra.detail, /isolation\.sandbox=require/)
      assert.equal(refused.checkpoint.open, false, 'restored and disposed anyway')
    }
    assert.equal(verifierLog(p).length, 0)
  })

  it('a lost transcript (R3, established) → a fresh context seeded with the prior reports; never established → new uuid, same charter', async () => {
    const p = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'Fresh look.\nVERDICT: FAIL' } } } })
    homes.push(p.home)
    const store = await MemoryStore.open(layouts(p).pl.store)
    const sha = await store.putReport('Generation 1 report: the parser drops the last line.\nVERDICT: FAIL')
    const lost = randomUUID()
    const logDir = join(layouts(p).sl.ctx, 'task-1-v1')
    mkdirSync(join(logDir, 'sessions'), { recursive: true })
    writeFileSync(join(logDir, 'sessions', `${lost}.json`), JSON.stringify({ attempted: 3, completed: 3, lastCostUsdTotal: 0 }))
    const { file } = await queuedJob(p, { verifier: { sessionId: lost, fresh: false }, taskReports: [{ gen: 1, sha }] })
    const job = await runJob(file, { env: p.env })
    assert.equal(job.status, 'done', JSON.stringify(job.infra))
    const log = verifierLog(p)
    assert.deepEqual(log.map(e => e.mode), ['resume', 'new'])
    assert.equal(log[0].sessionId, lost)
    assert.notEqual(log[1].sessionId, lost)
    assert.equal(job.result.verifierSessionId, log[1].sessionId)
    const prompts = readdirSync(logDir).filter(n => /^\d+$/.test(n)).map(n => readFileSync(join(logDir, n, 'prompt.md'), 'utf8'))
    assert.match(prompts.at(-1), /YOUR PRIOR PUBLISHED REPORTS ON EARLIER GENERATIONS/)
    assert.match(prompts.at(-1), /--- generation 1 ---\nGeneration 1 report: the parser drops the last line\./)
    const state = await readTask(layouts(p).sl)
    assert.equal(state.task.verifier.sessionId, log[1].sessionId)

    // Never established: the same charter (no prior reports) in a new context.
    const q = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'VERDICT: PASS' } } } })
    const never = randomUUID()
    const qDir = join(layouts(q).sl.ctx, 'task-1-v1')
    mkdirSync(join(qDir, 'sessions'), { recursive: true })
    writeFileSync(join(qDir, 'sessions', `${never}.json`), JSON.stringify({ attempted: 1, completed: 0, lastCostUsdTotal: 0 }))
    const qj = await queuedJob(q, { verifier: { sessionId: never, fresh: false } })
    const qJob = await runJob(qj.file, { env: q.env })
    assert.equal(qJob.status, 'done')
    const qPrompts = readdirSync(qDir).filter(n => /^\d+$/.test(n)).map(n => readFileSync(join(qDir, n, 'prompt.md'), 'utf8'))
    assert.ok(!qPrompts.at(-1).includes('YOUR PRIOR PUBLISHED REPORTS'))
  })

  it('cancellation restores the candidate and records infra "cancelled" (never a verdict)', async () => {
    const p = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'echo changed > src/app.txt; sleep 20' }], text: 'VERDICT: PASS' } } } })
    const { file, sl } = await queuedJob(p)
    const controller = new AbortController()
    const watcher = setInterval(() => {
      if (readFileSync(join(p.repo, 'src/app.txt'), 'utf8') === 'changed\n') controller.abort()
    }, 50)
    try {
      const job = await runJob(file, { env: p.env, signal: controller.signal })
      assert.equal(job.infra.cls, 'cancelled')
      assert.equal(job.result, null)
    } finally {
      clearInterval(watcher)
    }
    assert.equal(p.read('src/app.txt'), 'version 1\n')
    assert.equal((await readTask(sl)).task.lastVerdict, null)
  })

  it('a failed restore is infra restore_failed and keeps a sticky lock and the checkpoint', async () => {
    const p = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'echo changed > src/app.txt' }], text: 'VERDICT: PASS' } } } })
    const { file, sl } = await queuedJob(p)
    // The displaced dir cannot be created: restore cannot move the changed file aside (it never deletes).
    writeFileSync(sl.displaced, 'not a directory')
    const job = await runJob(file, { env: p.env })
    assert.equal(job.status, 'infra')
    assert.equal(job.infra.cls, 'restore_failed')
    assert.equal(job.result, null, 'no verdict after a failed restore')
    const [lock] = listLocksSync(layouts(p).g.locks)
    assert.equal(lock.restoreFailed, true)
    assert.equal(lock.live, true)
    assert.equal(job.checkpoint.open, true)
    assert.ok(existsSync(job.checkpoint.dir))
    assert.equal((await readTask(sl)).task.lastVerdict, null)
  })

  it('a detect-only checkpoint reports the changed paths instead of restoring them', async () => {
    const p = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'echo changed > src/app.txt' }], text: 'VERDICT: PASS' } } } })
    const { file } = await queuedJob(p, { config: { interactive: { checkpointMaxFiles: 1 } } })
    const job = await runJob(file, { env: p.env })
    assert.equal(job.result.detectOnly, true)
    assert.deepEqual(job.result.restored, ['src/app.txt'])
    assert.equal(p.read('src/app.txt'), 'changed\n')
  })

  it('runs once; recovery completes a job whose verdict was recorded before it died', async () => {
    const p = await setupProject({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'VERDICT: FAIL' } } } })
    const { file, sl } = await queuedJob(p)
    const done = await runJob(file, { env: p.env })
    assert.equal(done.status, 'done')
    assert.equal((await runJob(file, { env: p.env })).status, 'done', 'a finished job is returned untouched')
    assert.equal(verifierLog(p).length, 1)
    // Simulate a crash after the result was written and before the final status.
    await writeJsonAtomic(file, { ...done, status: 'running', pid: deadPid() })
    await withTask(sl, s => { s.job = { id: done.id, pid: null, taskSeq: done.taskSeq } })
    const recovered = await recoverJob(file, { env: p.env })
    assert.equal(recovered.status, 'done')
    assert.equal(recovered.result.verdict, 'FAIL')
    assert.equal((await readTask(sl)).job, null)
    // Recovery never runs while the job's pid is alive.
    await writeJsonAtomic(file, { ...done, status: 'running', pid: process.pid, heartbeatAt: new Date().toISOString() })
    assert.equal((await recoverJob(file, { env: p.env })).status, 'running')
    await writeJsonAtomic(file, done)
  })

  it('the CLI refuses inside a role context and prints usage otherwise', async () => {
    const script = join(ROOT, 'lib', 'interactive', 'verify-job.mjs')
    const role = await runNode(script, ['run', '/nonexistent.json'], { env: { ...process.env, CC_RSI_ROLE: 'verifier' } })
    assert.equal(role.code, 64)
    assert.match(role.stderr, /refusing to run inside a cc-rsi role context/)
    const usage = await runNode(script, ['bogus'], { env: { ...process.env, CC_RSI_ROLE: '' } })
    assert.equal(usage.code, 2)
    const missing = await runNode(script, ['run', '/nonexistent/job.json'], { env: { ...process.env, CC_RSI_ROLE: '' } })
    assert.equal(missing.code, 1)
  })
})

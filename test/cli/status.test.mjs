// `cc-rsi status` (SPEC §11.12, §13.1, §15.3 WP7 cli row): the §11.12 lines for a session and for a
// project, verdict currency, running jobs, lineages and sealed counts — and never any report text or
// score.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from '../../lib/cli/main.mjs'
import { globalLayout, projectKey, projectLayout, sessionLayout } from '../../lib/core/paths.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { projectRoot as gitProjectRoot, statusDigest } from '../../lib/workspace/git.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const SENTINEL = 'REPORT-SENTINEL-7c1f: the Verifier observed the secret detail'

async function hermeticEnv() {
  const { home, env } = await tmpHome()
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_') || name.startsWith('CC_RSI_') || name === 'CLAUDE_CODE_EXECPATH' || name === 'ANTHROPIC_MODEL') delete env[name]
  }
  env.CC_RSI_HOME = home
  env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
  return { home, env }
}

async function cli(argv, { env, cwd }) {
  const out = []
  const err = []
  const code = await main(argv, { stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => err.push(s) }, env, cwd, isTTY: false })
  return { code, stdout: out.join(''), stderr: err.join('') }
}

/** The digest the interactive mode records (WP5 helper when present, else plain statusDigest). */
async function digestOf(root, home) {
  try {
    const session = await import('../../lib/interactive/session.mjs')
    if (typeof session.workspaceDigest === 'function') return session.workspaceDigest(root, { home })
  } catch {
    // fall through
  }
  return statusDigest(root)
}

async function setup() {
  const { home, env } = await hermeticEnv()
  const repo = await gitRepo({ 'app.js': 'console.log(1)\n' })
  const root = await gitProjectRoot(repo)
  const key = projectKey(root)
  const pl = projectLayout(home, key)
  const sid = '0f6c2a1e-1111-4222-8333-944455556666'
  const sl = sessionLayout(pl, sid)
  mkdirSync(sl.jobs, { recursive: true })
  writeFileSync(sl.sessionJson, JSON.stringify({ v: 1, sessionId: sid, projectRoot: root, projectKey: key, model: 'claude-session-model', endedAt: null }))
  mkdirSync(globalLayout(home).runSessions, { recursive: true })
  writeFileSync(join(globalLayout(home).runSessions, `${sid}.json`), JSON.stringify({ v: 1, sessionId: sid, projectDir: root, projectRoot: root, projectKey: key }))
  const store = await MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
  const reportSha = await store.putReport(`VERDICT: FAIL\n${SENTINEL}\n`)
  const draft = await store.openDraft('ep-1', { owner: { kind: 'engine', pid: process.pid } })
  writeFileSync(join(draft.dir, 'lesson.md'), 'x'.repeat(2048))
  await store.commit('ep-1', { kind: 'practice', outcome: 'PASS' })
  await store.close()
  return { home, env, repo, root, key, pl, sid, sl, reportSha }
}

function writeTask(s, { digest, job = null, learning = null }) {
  writeFileSync(s.sl.task, JSON.stringify({
    v: 1, sessionId: s.sid, taskSeq: 2,
    task: {
      seq: 2, firstRequestSeq: 3, openedAt: new Date().toISOString(), openDigest: null, baselineFile: null, candidateRoot: s.root,
      verifier: { ctxIndex: 1, ctxKey: 'task-2-v1', sessionId: '6f1c0000-0000-4000-8000-0000000000e2', model: null, lastUsed: null, retired: false },
      generation: 1,
      reports: [{ gen: 1, jobId: 'j-20261013000000-abcdef', verdict: 'FAIL', reportSha: s.reportSha, statusDigest: digest, candidateDigest: 'c', isolation: 'rollback', model: 'm', at: new Date().toISOString() }],
      lastVerdict: 'FAIL', lastVerdictGen: 1, lastVerdictRequestSeq: 3, learned: false, closed: false,
    },
    prevTask: null, job, learning, stop: { nudged: [], gate: null }, lastDeliveredJob: null,
  }))
}

describe('cc-rsi status', () => {
  it('prints the §11.12 lines for a session without report text, and tracks verdict currency', async () => {
    const s = await setup()
    writeTask(s, { digest: await digestOf(s.root, s.home), learning: { episode: 'task-0f6c2a1e-2-g1', stage: 'distill', code: 'abcdef' } })
    // Run from an unrelated directory: --session finds the session's project.
    const elsewhere = await tmpDir()
    const r = await cli(['status', '--session', s.sid], { env: s.env, cwd: elsewhere })
    assert.equal(r.code, 0, r.stderr)
    const lines = r.stdout.trim().split('\n')
    assert.equal(lines[0], `cc-rsi status — session ${s.sid.slice(0, 8)}, project ${s.key}`)
    assert.match(lines[1], /^mode: learn \| memory: 1 files, 2 KiB, tree [0-9a-f]{12} \(intact\) \| frozen: no \| sealed: no$/)
    assert.equal(lines[2], 'task 2: generation 1; last verdict FAIL (current)')
    assert.equal(lines[3], 'verification: none')
    assert.equal(lines[4], 'learning: open (stage distill)')
    assert.match(lines[5], /^isolation: Verifier (sandbox|rollback) \(.+\) \| Verifier model: claude-session-model \(session\)$/)
    assert.equal(lines[6], 'lineages: none')
    assert.equal(lines[7], 'sealed evaluations: 0 recorded (scores are shown only in a terminal: cc-rsi eval show)')
    assert.ok(!r.stdout.includes('REPORT-SENTINEL'), 'status never prints report text')
    // A workspace change makes the verdict stale.
    writeFileSync(join(s.repo, 'app.js'), 'console.log(2)\n')
    const stale = await cli(['status', '--session', s.sid], { env: s.env, cwd: elsewhere })
    assert.match(stale.stdout, /task 2: generation 1; last verdict FAIL \(stale: workspace changed since inspection\)/)
    // A non-git report digest (null) is reported as such.
    writeTask(s, { digest: null })
    const nonGit = await cli(['status', '--session', s.sid], { env: s.env, cwd: elsewhere })
    assert.match(nonGit.stdout, /last verdict FAIL \(n\/a: not a git project\)/)
  })

  it('shows a running job, lineages and sealed counts; --json carries no report text', async () => {
    const s = await setup()
    const jobId = 'j-20261013000000-123456'
    writeFileSync(join(s.sl.jobs, `${jobId}.json`), JSON.stringify({ v: 1, id: jobId, status: 'running', pid: process.pid, startedAt: new Date(Date.now() - 5000).toISOString() }))
    writeTask(s, { digest: null, job: { id: jobId, pid: process.pid, gen: 1, startedAt: new Date().toISOString() } })
    mkdirSync(join(s.pl.lineages, 'broad-a'), { recursive: true })
    writeFileSync(join(s.pl.lineages, 'broad-a', 'state.json'), JSON.stringify({ v: 1, id: 'broad-a', phase: 'broad', status: 'paused_infra', wave: 2, projectsDone: 3, infra: { cls: 'auth', detail: 'DETAIL-SENTINEL' } }))
    mkdirSync(join(s.pl.lineages, 'deep-b'), { recursive: true })
    writeFileSync(join(s.pl.lineages, 'deep-b', 'state.json'), JSON.stringify({ v: 1, id: 'deep-b', phase: 'deep', status: 'completed', targetCycles: 2, practiceProjects: 1 }))
    writeFileSync(join(s.pl.lineages, 'deep-b', 'result.json'), JSON.stringify({ termination: 'verifier_pass', rationale: 'RATIONALE-SENTINEL' }))
    const store = await MemoryStore.open(s.pl.store, { sessionsDir: s.pl.sessions, lineagesDir: s.pl.lineages })
    await store.freeze({ by: 'test' })
    await store.markSealed({ lineage: 'deep-b', runId: 'r-20261013000000' })
    await store.close()
    const r = await cli(['status', '--session', s.sid, '--project', s.repo], { env: s.env, cwd: s.repo })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`verification: running \\(job ${jobId}, \\d+ s\\)`))
    assert.match(r.stdout, /mode: frozen \| .* \| frozen: yes \| sealed: yes/)
    assert.match(r.stdout, /lineages: broad-a broad paused_infra \(wave 2, 3 projects\), deep-b deep completed \[verifier_pass\] \(2 target cycles, 1 practice projects\)/)
    assert.match(r.stdout, /sealed evaluations: 1 recorded/)
    for (const sentinel of ['REPORT-SENTINEL', 'DETAIL-SENTINEL', 'RATIONALE-SENTINEL']) assert.ok(!r.stdout.includes(sentinel), sentinel)
    const json = await cli(['status', '--json', '--session', s.sid], { env: s.env, cwd: s.repo })
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.session.verification.jobId, jobId)
    assert.equal(parsed.sealedEvaluations, 1)
    assert.equal(parsed.memory.frozen, true)
    for (const sentinel of ['REPORT-SENTINEL', 'DETAIL-SENTINEL', 'RATIONALE-SENTINEL']) assert.ok(!json.stdout.includes(sentinel), sentinel)
    // A job whose process is gone is reported as such.
    writeFileSync(join(s.sl.jobs, `${jobId}.json`), JSON.stringify({ v: 1, id: jobId, status: 'running', pid: 2147483646, startedAt: new Date().toISOString() }))
    const dead = await cli(['status', '--session', s.sid], { env: s.env, cwd: s.repo })
    assert.match(dead.stdout, new RegExp(`verification: job ${jobId} is no longer running`))
  })

  it('reports the project without a session, and an unknown session plainly', async () => {
    const s = await setup()
    const r = await cli(['status'], { env: s.env, cwd: s.repo })
    assert.equal(r.code, 0)
    assert.equal(r.stdout.split('\n')[0], `cc-rsi status — project ${s.key} (${s.root})`)
    assert.doesNotMatch(r.stdout, /^task /m)
    const unknown = await cli(['status', '--session', 'nope-session', '--project', s.repo], { env: s.env, cwd: s.repo })
    assert.match(unknown.stdout, /session nope-session: no cc-rsi state/)
    const bad = await cli(['status', 'extra'], { env: s.env, cwd: s.repo })
    assert.equal(bad.code, 2)
  })
})

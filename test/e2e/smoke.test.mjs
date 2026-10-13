// Opt-in end-to-end smoke (SPEC §15.3 WP7 e2e row): the REAL `claude` with `--model haiku`, an
// allowlisted environment, a temporary CC_RSI_HOME and a temporary git repository. Runs only with
// CC_RSI_E2E=1 (`npm run smoke`); the SIGTERM/resume scenario (4) also needs CC_RSI_E2E_FULL=1
// because it repeats a whole lineage. Every model call uses haiku; the whole default run is a
// handful of tiny calls plus one broad wave and one frozen attempt.
//
//  (1) cc-rsi doctor --live → auth + hook probes PASS
//  (2) claude -p --plugin-dir <repo> --model haiku: create hello.txt, submit, wait_verdict → a verdict
//      record (not infra) with its isolation, the workspace restored, no --session-id reuse
//  (3) explore start --phase broad … --allow-unconfined --foreground --yes --model haiku with
//      broadProjectBudget 1, waveCeiling 1 → budget_exhausted|saturated, a journal commit, no evaluator
//  (4) [FULL] SIGTERM a second broad lineage mid-wave, then explore resume completes it
//  (5) memory freeze + a frozen lineage + cc-rsi eval run with evaluation.command ["sh","-c","echo 1"]
//      and --json-out → scored 1

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { isPassName } from '../../lib/runtime/env.mjs'
import { projectKey, projectLayout } from '../../lib/core/paths.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { gitEnv, gitRepo, tmpDir } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const BIN = join(ROOT, 'bin', 'cc-rsi')
const E2E = process.env.CC_RSI_E2E === '1'
const FULL = process.env.CC_RSI_E2E_FULL === '1'
const haveClaude = E2E && spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 }).status === 0
const skip = !E2E ? 'opt-in: set CC_RSI_E2E=1' : !haveClaude ? '`claude` is not installed' : false

const spawned = new Set()
after(() => {
  for (const pid of spawned) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
  }
})

/** The allowlisted parent environment (SPEC §10.5 PASS names; never a Claude Code session variable). */
function allowlisted(home) {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) if (typeof value === 'string' && isPassName(name)) env[name] = value
  env.CC_RSI_HOME = home
  return env
}

function run(cmd, args, { env, cwd, input = '', timeoutMs = 600000 }) {
  return new Promise(resolvePromise => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    spawned.add(child.pid)
    const out = []
    const err = []
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }, timeoutMs)
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      spawned.delete(child.pid)
      resolvePromise({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

const cli = (args, ctx, opts = {}) => run(process.execPath, [BIN, ...args], { env: ctx.env, cwd: ctx.repo, ...opts })

function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** Every role invocation meta.json under a directory tree. */
function metas(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) metas(full, out)
    else if (name.name === 'meta.json') {
      try { out.push(JSON.parse(readFileSync(full, 'utf8'))) } catch { /* torn */ }
    }
  }
  return out
}

describe('e2e smoke (real claude, haiku)', { skip, concurrency: false }, () => {
  const ctx = {}

  it('setup: temporary home, project and global config', async () => {
    ctx.home = await tmpDir('cc-rsi-e2e-home-')
    ctx.repo = await gitRepo({ 'README.md': '# e2e project\n' })
    ctx.root = await gitProjectRoot(ctx.repo)
    ctx.pl = projectLayout(ctx.home, projectKey(ctx.root))
    ctx.env = allowlisted(ctx.home)
    writeFileSync(join(ctx.home, 'config.json'), JSON.stringify({
      models: { verifier: 'haiku', actor: 'haiku', curriculum: 'haiku' },
      exploration: { broadProjectBudget: 1, waveCeiling: 1, waveConcurrency: 1, targetResumes: 0, frozenRepairRounds: 2 },
      evaluation: { command: ['sh', '-c', 'echo 1'], timeoutSec: 60, retries: 0 },
      isolation: { allowUnconfined: false },
    }, null, 2))
  })

  it('(1) doctor --live: auth and hook probes pass', async () => {
    const r = await cli(['doctor', '--live'], ctx)
    assert.match(r.stdout, /^PASS live-auth: /m, r.stdout + r.stderr)
    assert.match(r.stdout, /^PASS live-hooks: the role guard ran on the first message and on --resume$/m, r.stdout)
  })

  it('(2) interactive submit through the plugin yields a verdict record and restores the workspace', async () => {
    const prompt = 'Create a file named hello.txt containing exactly the text hi (one line). When done, call the cc-rsi submit tool; '
      + 'if it says VERIFICATION RUNNING, call wait_verdict until you have a verdict; then reply with the verdict line only.'
    const tools = ['Write', 'Read', 'Edit', 'Bash', 'mcp__plugin_cc-rsi_rsi__submit', 'mcp__plugin_cc-rsi_rsi__wait_verdict', 'mcp__plugin_cc-rsi_rsi__status']
    const r = await run('claude', ['-p', '--plugin-dir', ROOT, '--model', 'haiku', '--max-turns', '30', '--output-format', 'text', '--allowedTools', ...tools],
      { env: ctx.env, cwd: ctx.repo, input: prompt, timeoutMs: 900000 })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readFileSync(join(ctx.repo, 'hello.txt'), 'utf8').trim(), 'hi')
    const sessions = readdirSync(ctx.pl.sessions)
    assert.equal(sessions.length, 1, 'one main session recorded by the hooks')
    const verdicts = readJsonl(join(ctx.pl.sessions, sessions[0], 'verdicts.jsonl'))
    assert.ok(verdicts.length >= 1, `a verdict record exists (stdout: ${r.stdout})`)
    for (const v of verdicts) {
      assert.match(v.verdict, /^(PASS|FAIL|UNVERIFIED)$/)
      assert.ok(v.isolation, 'the isolation actually used is recorded')
    }
    // Workspace restored: the Verifier's changes (if any) are gone, nothing is locked.
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: ctx.repo, env: gitEnv(), encoding: 'utf8' }).stdout
    assert.deepEqual(status.trim().split('\n').filter(Boolean).sort(), ['?? hello.txt'])
    const locks = join(ctx.home, 'run', 'locks')
    assert.deepEqual(existsSync(locks) ? readdirSync(locks).filter(n => n.endsWith('.json')) : [], [])
    // No --session-id reuse: each role session id was opened with --session-id at most once.
    const all = metas(join(ctx.pl.sessions, sessions[0], 'ctx'))
    const opened = all.filter(m => m.mode === 'new').map(m => m.sessionId)
    assert.equal(new Set(opened).size, opened.length)
  })

  it('(3) a broad lineage in the foreground commits memory without any evaluator call', async () => {
    const r = await cli(['explore', 'start', '--phase', 'broad', '--direction', 'tiny text-processing CLI exercises', '--id', 'e2e-broad',
      '--allow-unconfined', '--foreground', '--yes', '--model', 'haiku'], ctx, { timeoutMs: 1800000 })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const result = JSON.parse(readFileSync(join(ctx.pl.lineages, 'e2e-broad', 'result.json'), 'utf8'))
    assert.ok(['budget_exhausted', 'saturated'].includes(result.termination), result.termination)
    assert.equal(result.official_evaluator_calls, 0)
    const journal = readJsonl(join(ctx.pl.store, 'journal.jsonl'))
    const commits = journal.filter(c => c.lineage === 'e2e-broad')
    if (result.termination === 'budget_exhausted') assert.ok(commits.length >= 1, 'a committed practice project')
    for (const c of commits) assert.match(`${c.treeBefore} ${c.treeAfter}`, /^[0-9a-f]{64} [0-9a-f]{64}$/)
  })

  it('(4) a lineage stopped mid-wave resumes to completion', { skip: FULL ? false : 'set CC_RSI_E2E_FULL=1 (repeats a whole lineage)' }, async () => {
    const started = await cli(['explore', 'start', '--phase', 'broad', '--direction', 'tiny string utilities', '--id', 'e2e-resume',
      '--allow-unconfined', '--yes', '--model', 'haiku', '--skip-auth-probe'], ctx)
    assert.equal(started.code, 0, started.stdout + started.stderr)
    const pid = Number((/engine pid (\d+)/.exec(started.stdout) ?? [])[1])
    spawned.add(pid)
    const events = join(ctx.pl.lineages, 'e2e-resume', 'events.jsonl')
    const deadline = Date.now() + 600000
    while (Date.now() < deadline && !readJsonl(events).some(e => e.type === 'WAVE_FIXTURES_CAPTURED')) await new Promise(res => setTimeout(res, 1000))
    const stopped = await cli(['explore', 'stop', 'e2e-resume'], ctx)
    assert.match(stopped.stdout, /lineage e2e-resume: paused_(user|infra)/, stopped.stdout)
    const resumed = await cli(['explore', 'resume', 'e2e-resume', '--foreground'], ctx, { timeoutMs: 1800000 })
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr)
    assert.ok(existsSync(join(ctx.pl.lineages, 'e2e-resume', 'result.json')))
  })

  it('(5) freeze, a frozen lineage, and a sealed evaluation with --json-out', async () => {
    const frozen = await cli(['memory', 'freeze'], ctx)
    assert.equal(frozen.code, 0, frozen.stderr)
    const r = await cli(['explore', 'start', '--phase', 'frozen', '--target', 'Create a file named answer.txt containing the number 42.', '--id', 'e2e-frozen',
      '--allow-unconfined', '--foreground', '--yes', '--model', 'haiku', '--skip-auth-probe'], ctx, { timeoutMs: 1800000 })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const result = JSON.parse(readFileSync(join(ctx.pl.lineages, 'e2e-frozen', 'result.json'), 'utf8'))
    assert.ok(['frozen_attempt_complete', 'target_harness_unverified'].includes(result.termination))
    assert.match(result.candidate_digest, /^[0-9a-f]{64}$/)
    const out = join(await tmpDir('cc-rsi-e2e-out-'), 'evaluation.json')
    const ev = await cli(['eval', 'run', 'e2e-frozen', '--json-out', out], ctx)
    assert.equal(ev.code, 0, ev.stdout + ev.stderr)
    assert.doesNotMatch(ev.stdout, /score: /, 'stdout is a pipe: the score is withheld')
    const record = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(record.status, 'scored')
    assert.equal(record.score, 1)
    assert.equal(record.frozen_intact, true)
    assert.equal(record.official_evaluator_feedback_entered_agent, false)
  })
})

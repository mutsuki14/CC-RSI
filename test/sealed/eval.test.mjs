// Sealed evaluation (SPEC §13.4, §15.3 WP7 sealed row): scores a copy of the final candidate on
// frozen memory with a fake evaluator; refused under CLAUDECODE/CC_RSI_ROLE; refused on a changed
// candidate; `blocked` after retries and after an identical stderr ×3; the score is never printed to
// a non-TTY; the sealed marker blocks learning.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { main } from '../../lib/cli/main.mjs'
import { LeaseLock } from '../../lib/core/lock.mjs'
import { lineageLayout, projectKey, projectLayout } from '../../lib/core/paths.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { parseScore, runSealedEvaluation, showEvaluation } from '../../lib/sealed/eval.mjs'
import { treeFingerprint } from '../../lib/workspace/fingerprint.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

async function hermeticEnv() {
  const { home, env } = await tmpHome()
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_') || name.startsWith('CC_RSI_') || name === 'CLAUDE_CODE_EXECPATH') delete env[name]
  }
  env.CC_RSI_HOME = home
  env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
  return { home, env }
}

/** Whether `pid` runs (a zombie waiting for its reaper counts as gone). */
function running(pid) {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0]
    return state !== 'Z' && state !== 'X'
  } catch {
    try {
      process.kill(pid, 0)
      return !existsSync('/proc/self')
    } catch {
      return false
    }
  }
}

function sink(isTTY) {
  const chunks = []
  return { write: s => chunks.push(String(s)), isTTY, text: () => chunks.join('') }
}

/** Writes an evaluator script and returns its argv. */
async function evaluator(source) {
  const dir = await tmpDir('cc-rsi-evaluator-')
  const file = join(dir, 'evaluate.mjs')
  writeFileSync(file, source)
  return [process.execPath, file]
}

const SCORING = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.RSI_CANDIDATE_ROOT
const leaks = Object.keys(process.env).filter(k => k.startsWith('CC_RSI_') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_SESSION'))
if (process.cwd() !== root) { console.error('cwd is not the candidate'); process.exit(3) }
if (leaks.length) { console.error('leaked env ' + leaks.join(',')); process.exit(4) }
const task = readFileSync(process.env.RSI_TASK_FILE, 'utf8')
const ok = readFileSync(join(root, 'answer.txt'), 'utf8').trim() === '42' && task === 'Compute the answer.'
writeFileSync(join(root, 'evaluator-was-here.txt'), 'x')
console.log('grading…')
console.log(JSON.stringify({ score: ok ? 0.83 : 0 }))
`

/** A finished deep lineage with a final candidate, a committed memory file and a global evaluator config. */
async function fixture({ command, evaluation = {}, phase = 'deep', result = true, id = 'deep-1' } = {}) {
  const { home, env } = await hermeticEnv()
  const repo = await gitRepo({ 'README.md': 'project\n' })
  const projectRoot = await gitProjectRoot(repo)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ evaluation: { command: command ?? [], timeoutSec: 20, retries: 2, ...evaluation } }))
  const pl = projectLayout(home, projectKey(projectRoot))
  const layout = lineageLayout(pl, id)
  mkdirSync(layout.dir, { recursive: true })
  writeFileSync(layout.lineageJson, JSON.stringify({
    v: 1, id, phase, projectKey: projectKey(projectRoot), projectRoot, home, storeRoot: pl.store, target: { text: 'Compute the answer.', sha256: 'x' },
  }))
  const tree = join(layout.priv, 'final-candidate', 'tree')
  mkdirSync(join(tree, 'src'), { recursive: true })
  writeFileSync(join(tree, 'answer.txt'), '42\n')
  writeFileSync(join(tree, 'src', 'main.js'), 'console.log(42)\n')
  const digest = await treeFingerprint(tree)
  if (result) {
    writeFileSync(layout.result, JSON.stringify({ schema_version: 1, lineage: id, phase, termination: 'verifier_pass', candidate_digest: digest, target_verifier_verdict: 'PASS' }))
  }
  const store = await MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
  const draft = await store.openDraft('ep-1', { owner: { kind: 'engine', pid: process.pid } })
  writeFileSync(join(draft.dir, 'lesson.md'), 'verify before submit\n')
  await store.commit('ep-1', { kind: 'practice', outcome: 'PASS' })
  const tree0 = await store.treeHash()
  await store.close()
  return { home, env, repo, projectRoot, pl, layout, tree, digest, tree0, id }
}

async function openStore(f) {
  return MemoryStore.open(f.pl.store, { sessionsDir: f.pl.sessions, lineagesDir: f.pl.lineages })
}

describe('parseScore', () => {
  it('takes the last non-empty stdout line as a JSON number or {"score": n}', () => {
    assert.equal(parseScore('noise\n0.5\n\n'), 0.5)
    assert.equal(parseScore('{"score": 1}\n'), 1)
    assert.equal(parseScore('0.5\nnot json\n'), null)
    assert.equal(parseScore('{"score":"1"}'), null)
    assert.equal(parseScore('NaN'), null)
    assert.equal(parseScore(''), null)
  })
})

describe('runSealedEvaluation', () => {
  it('scores a private copy of the final candidate on frozen memory and withholds the score from a non-TTY', async () => {
    const f = await fixture({ command: await evaluator(SCORING) })
    const out = sink(false)
    const r = await runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: out, env: f.env, retryDelayMs: 0 })
    assert.equal(r.status, 'scored')
    assert.match(r.runId, /^r-\d{14}$/)
    assert.equal(r.frozenIntact, true)
    // Non-TTY: the score never reaches stdout.
    assert.doesNotMatch(out.text(), /0\.83/)
    assert.match(out.text(), /evaluation recorded \(score withheld: stdout is not a terminal\); view it with "cc-rsi eval show deep-1" in a terminal/)
    const runDir = join(f.pl.sealed, f.id, r.runId)
    const record = JSON.parse(readFileSync(join(runDir, 'evaluation.json'), 'utf8'))
    assert.deepEqual(Object.keys(record).sort(), ['attempts', 'candidate_digest', 'frozen_intact', 'lineage', 'memory_tree_after', 'memory_tree_before',
      'official_evaluator_feedback_entered_agent', 'run_id', 'schema_version', 'score', 'status', 'ts'])
    assert.equal(record.score, 0.83)
    assert.equal(record.status, 'scored')
    assert.equal(record.official_evaluator_feedback_entered_agent, false)
    assert.equal(record.candidate_digest, f.digest)
    assert.equal(record.memory_tree_before, f.tree0)
    assert.equal(record.memory_tree_after, f.tree0)
    assert.equal(record.attempts.length, 1)
    assert.equal(record.attempts[0].exit_code, 0)
    // The evaluator ran in the copy; the private source is untouched.
    assert.ok(existsSync(join(runDir, 'candidate', 'evaluator-was-here.txt')))
    assert.equal(await treeFingerprint(f.tree), f.digest)
    assert.equal(readFileSync(join(runDir, 'task.md'), 'utf8'), 'Compute the answer.')
    // Store: frozen, intact, sealed; the lineage marker carries no score.
    const store = await openStore(f)
    try {
      assert.equal((await store.frozen()).treeHash, f.tree0)
      const sealed = await store.sealed()
      assert.deepEqual(sealed.runs.map(x => [x.lineage, x.runId]), [[f.id, r.runId]])
      assert.equal(sealed.learningAfterSealed, false)
    } finally {
      await store.close()
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.layout.dir, 'sealed.json'), 'utf8')), { runs: [r.runId] })
    // show: no score to a non-TTY, the score to a TTY.
    const plain = sink(false)
    await showEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: plain, env: f.env })
    assert.doesNotMatch(plain.text(), /0\.83/)
    assert.match(plain.text(), /score withheld/)
    const tty = sink(true)
    await showEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: tty, env: f.env })
    assert.match(tty.text(), /score: 0\.83/)
  })

  it('prints the score to a TTY and writes --json-out outside model-visible directories only', async () => {
    const f = await fixture({ command: await evaluator(SCORING) })
    await assert.rejects(
      runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, jsonOut: join(f.projectRoot, 'score.json'), stdout: sink(true), env: f.env }),
      /--json-out .* lies inside the project/,
    )
    assert.equal(existsSync(join(f.pl.sealed, f.id)), false, 'a refused --json-out runs nothing')
    const outFile = join(await tmpDir(), 'summary.json')
    const tty = sink(true)
    const r = await runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, jsonOut: outFile, stdout: tty, env: f.env, retryDelayMs: 0 })
    assert.equal(r.status, 'scored')
    assert.match(tty.text(), /score: 0\.83/)
    assert.equal(JSON.parse(readFileSync(outFile, 'utf8')).score, 0.83)
  })

  it('is refused under CLAUDECODE and CC_RSI_ROLE, before any side effect', async () => {
    const f = await fixture({ command: await evaluator(SCORING) })
    await assert.rejects(runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: sink(true), env: { ...f.env, CLAUDECODE: '1' } }), { code: 'human_only' })
    await assert.rejects(runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: sink(true), env: { ...f.env, CC_RSI_ROLE: 'verifier' } }), { code: 'role_context' })
    await assert.rejects(showEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: sink(true), env: { ...f.env, CLAUDECODE: '1' } }), { code: 'human_only' })
    const store = await openStore(f)
    try {
      assert.equal(await store.frozen(), null)
      assert.equal(await store.sealed(), null)
    } finally {
      await store.close()
    }
    // Through the CLI: exit 65, nothing printed on stdout.
    const out = []
    const err = []
    const io = { stdout: { write: s => out.push(s), isTTY: true }, stderr: { write: s => err.push(s) }, env: { ...f.env, CLAUDECODE: '1' }, cwd: f.repo, isTTY: true }
    assert.equal(await main(['eval', 'run', f.id], io), 65)
    assert.equal(out.join(''), '')
  })

  it('refuses a candidate that changed after the lineage ended', async () => {
    const f = await fixture({ command: await evaluator(SCORING) })
    writeFileSync(join(f.tree, 'answer.txt'), '43\n')
    await assert.rejects(
      runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: sink(false), env: f.env }),
      /the final candidate changed after the lineage ended/,
    )
    const store = await openStore(f)
    try {
      assert.equal(await store.sealed(), null)
    } finally {
      await store.close()
    }
  })

  it('refuses without a command, an unfinished or broad lineage, or a live engine', async () => {
    const none = await fixture({ command: [] })
    await assert.rejects(runSealedEvaluation({ home: none.home, projectRoot: none.projectRoot, lineageId: none.id, stdout: sink(false), env: none.env }), /evaluation\.command is not configured/)
    const unfinished = await fixture({ command: await evaluator(SCORING), result: false })
    await assert.rejects(runSealedEvaluation({ home: unfinished.home, projectRoot: unfinished.projectRoot, lineageId: unfinished.id, stdout: sink(false), env: unfinished.env }), /has not ended/)
    const broad = await fixture({ command: await evaluator(SCORING), phase: 'broad', id: 'broad-1' })
    await assert.rejects(runSealedEvaluation({ home: broad.home, projectRoot: broad.projectRoot, lineageId: broad.id, stdout: sink(false), env: broad.env }), /only deep and frozen lineages/)
    const live = await fixture({ command: await evaluator(SCORING) })
    const lock = new LeaseLock(live.layout.engineLock)
    await lock.acquire()
    try {
      await assert.rejects(runSealedEvaluation({ home: live.home, projectRoot: live.projectRoot, lineageId: live.id, stdout: sink(false), env: live.env }), /engine of lineage deep-1 is running/)
    } finally {
      await lock.release()
    }
  })

  it('blocks early after the same evaluator error three times in a row (RSIAgent GradingBlocked)', async () => {
    const f = await fixture({ command: await evaluator("console.error('AttributeError: grader broken'); process.exit(1)\n"), evaluation: { retries: 6 } })
    const r = await runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: sink(true), env: f.env, retryDelayMs: 0 })
    assert.equal(r.status, 'blocked')
    const record = JSON.parse(readFileSync(join(f.pl.sealed, f.id, r.runId, 'evaluation.json'), 'utf8'))
    assert.equal(record.attempts.length, 3)
    assert.equal(record.score, null)
    assert.match(record.blocked_reason, /same evaluator error repeated 3 times/)
    assert.ok(record.attempts.every(a => a.exit_code === 1 && /grader broken/.test(a.stderr_tail)))
  })

  it('blocks after the retries are exhausted, with a fresh candidate copy per attempt', async () => {
    const script = `
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const marker = join(process.env.RSI_CANDIDATE_ROOT, 'dirty.txt')
if (existsSync(marker)) { console.error('dirty candidate'); process.exit(9) }
writeFileSync(marker, 'x')
console.error('transient outage ' + process.hrtime.bigint())
process.exit(2)
`
    const f = await fixture({ command: await evaluator(script) })
    const r = await runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, retries: 2, stdout: sink(false), env: f.env, retryDelayMs: 0 })
    assert.equal(r.status, 'blocked')
    const record = JSON.parse(readFileSync(join(f.pl.sealed, f.id, r.runId, 'evaluation.json'), 'utf8'))
    assert.equal(record.attempts.length, 3)
    assert.deepEqual(record.attempts.map(a => a.exit_code), [2, 2, 2])
    assert.match(record.blocked_reason, /retries exhausted/)
  })

  it('blocks an unparseable score and times out an evaluator together with its children', async () => {
    const unparseable = await fixture({ command: await evaluator("console.log('all good')\n") })
    const r1 = await runSealedEvaluation({ home: unparseable.home, projectRoot: unparseable.projectRoot, lineageId: unparseable.id, stdout: sink(true), env: unparseable.env, retryDelayMs: 0 })
    assert.equal(r1.status, 'blocked')
    const pidFile = join(await tmpDir(), 'grandchild.pid')
    const hang = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
setTimeout(() => {}, 60000)
`
    const slow = await fixture({ command: await evaluator(hang), evaluation: { timeoutSec: 1, retries: 0 } })
    const r2 = await runSealedEvaluation({ home: slow.home, projectRoot: slow.projectRoot, lineageId: slow.id, stdout: sink(false), env: slow.env, retryDelayMs: 0 })
    assert.equal(r2.status, 'blocked')
    const record = JSON.parse(readFileSync(join(slow.pl.sealed, slow.id, r2.runId, 'evaluation.json'), 'utf8'))
    assert.equal(record.attempts.length, 1)
    assert.equal(record.attempts[0].timed_out, true)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    let alive = true
    for (let i = 0; i < 100 && alive; i++) {
      alive = running(grandchild)
      if (alive) await new Promise(res => setTimeout(res, 50))
    }
    assert.equal(alive, false, 'the evaluator process group was killed')
  })

  it('the sealed marker closes learning until a human unfreezes with --after-sealed', async () => {
    const f = await fixture({ command: await evaluator(SCORING) })
    await runSealedEvaluation({ home: f.home, projectRoot: f.projectRoot, lineageId: f.id, stdout: sink(false), env: f.env, retryDelayMs: 0 })
    const store = await openStore(f)
    try {
      await store.unfreeze({ afterSealed: false }).then(() => assert.fail('unfreeze without --after-sealed must refuse'), error => assert.equal(error.code, 'memory_sealed'))
      // Frozen and sealed: no learning draft can open.
      await assert.rejects(store.openDraft('later', { owner: { kind: 'engine', pid: process.pid } }), error => ['memory_frozen', 'memory_sealed'].includes(error.code))
      await store.unfreeze({ afterSealed: true })
      const draft = await store.openDraft('later', { owner: { kind: 'engine', pid: process.pid } })
      assert.ok(existsSync(draft.dir))
      await store.discardDraft('later')
    } finally {
      await store.close()
    }
    // With the engine available, a learning lineage start is blocked while sealed.
    const sealedAgain = await fixture({ command: await evaluator(SCORING) })
    await runSealedEvaluation({ home: sealedAgain.home, projectRoot: sealedAgain.projectRoot, lineageId: sealedAgain.id, stdout: sink(false), env: sealedAgain.env, retryDelayMs: 0 })
    const s2 = await openStore(sealedAgain)
    try {
      await s2.unfreeze({ afterSealed: false }).catch(() => undefined)
      assert.equal((await s2.sealed()).learningAfterSealed, false)
    } finally {
      await s2.close()
    }
    let records = null
    try {
      records = await import('../../lib/engine/records.mjs')
    } catch {
      records = null
    }
    if (records?.preflight) {
      const pre = await records.preflight({ home: sealedAgain.home, projectRoot: sealedAgain.projectRoot, phase: 'deep', target: 'x', allowUnconfined: true, env: sealedAgain.env, pluginRoot: ROOT })
      assert.ok(pre.blockers.some(b => /sealed evaluation|frozen/.test(b)), pre.blockers.join('\n'))
    }
    assert.ok(readdirSync(join(sealedAgain.pl.sealed, sealedAgain.id)).length === 1)
  })
})

const WORLD = join(ROOT, 'test', 'engine', 'scenarios', 'world.mjs')
let engineAvailable = false
try {
  await import('../../lib/engine/records.mjs')
  engineAvailable = existsSync(WORLD)
} catch {
  engineAvailable = false
}

describe('sealed evaluation of a real deep lineage (engine + fake claude)', { skip: engineAvailable ? false : 'lib/engine (WP6) or its world scenario is not available' }, () => {
  it('evaluates the final candidate the engine captured, through the CLI', async () => {
    const { fakeClaude } = await import('../_helpers/fake.mjs')
    const { home, env: base } = await hermeticEnv()
    const fake = await fakeClaude({ scenario: WORLD, home })
    const env = { ...base, CC_RSI_CLAUDE_BIN: fake.bin }
    writeFileSync(join(fake.fakeHome, 'world.json'), JSON.stringify({ verdicts: { '*': ['PASS'] } }))
    const scorer = await evaluator("import { existsSync } from 'node:fs'\nconsole.log(existsSync('out.txt') ? 1 : 0)\n")
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      children: { claudeBin: fake.bin },
      models: { actor: 'actor-model', verifier: 'verifier-model', curriculum: 'curriculum-model' },
      transport: { pauseSecs: 0, pauseMaxSecs: 0 },
      exploration: { stopPolicy: 'verifier_pass' },
      evaluation: { command: scorer, timeoutSec: 30, retries: 0 },
    }))
    const repo = await gitRepo({ 'README.md': 'project\n' })
    const out = []
    const io = (extra = {}) => ({ stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => out.push(s) }, env: { ...env, ...extra }, cwd: repo, isTTY: false })
    const started = await main(['explore', 'start', '--phase', 'deep', '--target', 'Write out.txt.', '--id', 'deep-e', '--allow-unconfined', '--skip-auth-probe', '--foreground', '--yes'], io())
    assert.equal(started, 0, out.join(''))
    assert.match(out.join(''), /lineage deep-e: completed \(termination verifier_pass\)/)
    const summary = join(await tmpDir(), 'summary.json')
    out.length = 0
    assert.equal(await main(['eval', 'run', 'deep-e', '--json-out', summary], io()), 0, out.join(''))
    assert.doesNotMatch(out.join(''), /score: /)
    const record = JSON.parse(readFileSync(summary, 'utf8'))
    assert.deepEqual([record.status, record.score, record.frozen_intact], ['scored', 1, true])
    // The sealed marker now blocks resuming or starting learning lineages.
    out.length = 0
    assert.equal(await main(['explore', 'start', '--phase', 'deep', '--target', 'again', '--id', 'deep-f', '--allow-unconfined', '--skip-auth-probe', '--yes'], io()), 3)
    assert.match(out.join(''), /memory is frozen|sealed evaluation/)
  })
})

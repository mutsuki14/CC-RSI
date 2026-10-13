// SPEC §15.3 WP5 hooks: the main-session PreToolUse guard — lock deny for the main thread and for an
// `agent_id` payload, private-path deny, view/draft allow, human-only Bash deny, `explore start`
// deny, Verifier transcripts, and the p95 < 150 ms budget for guard and attest.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { acquireWorkspaceLock, markRestoreFailed, releaseWorkspaceLock } from '../../lib/interactive/wslock.mjs'
import { withTask } from '../../lib/interactive/task.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'
import { fixture, hook, layouts, setupProject } from '../interactive/harness.mjs'

const pre = (p, tool_name, tool_input, extra = {}) => fixture('pre-tool-use', p, { extra: { tool_name, tool_input, ...extra } })
const decision = r => r.json?.hookSpecificOutput?.permissionDecision ?? null
const reason = r => r.json?.hookSpecificOutput?.permissionDecisionReason ?? ''

async function started(p) {
  const r = await hook('session-start', fixture('session-start', p), p.env)
  assert.equal(r.code, 0)
  return layouts(p)
}

describe('main-session guard', () => {
  it('denies file changes and shell commands under a live workspace lock, for the main thread and subagents', async () => {
    const p = await setupProject()
    const { g } = await started(p)
    const lock = await acquireWorkspaceLock(g.locks, p.repo, { jobId: 'j-20260101000000-abcdef', sessionId: 'other-session' })
    try {
      for (const [tool, input] of [['Bash', { command: 'ls' }], ['Edit', { file_path: join(p.repo, 'README.md'), old_string: 'a', new_string: 'b' }],
        ['Write', { file_path: join(p.repo, 'x.txt'), content: 'x' }], ['NotebookEdit', { notebook_path: join(p.repo, 'n.ipynb'), new_source: '' }],
        ['MultiEdit', { file_path: join(p.repo, 'README.md'), edits: [] }], ['PowerShell', { command: 'dir' }], ['Monitor', { command: 'tail -f x' }]]) {
        const r = await hook('guard', pre(p, tool, input), p.env)
        assert.equal(decision(r), 'deny', tool)
        assert.match(reason(r), /^cc-rsi: an independent verification of this workspace is running \(job j-20260101000000-abcdef, started \d\d:\d\d:\d\d\)\. File changes and shell commands are paused until it finishes\. Call the cc-rsi wait_verdict tool\.$/)
      }
      const sub = await hook('guard', fixture('pre-tool-use-subagent', p), p.env)
      assert.equal(decision(sub), 'deny')
      // A write path under the root is denied even from another cwd; reads stay allowed.
      const outside = await hook('guard', pre(p, 'Write', { file_path: join(p.repo, 'y.txt'), content: 'y' }, { cwd: '/' }), p.env)
      assert.equal(decision(outside), 'deny')
      const named = await hook('guard', pre(p, 'Bash', { command: `cd ${p.repo} && touch z.txt` }, { cwd: '/' }), p.env)
      assert.equal(decision(named), 'deny', 'a shell command naming the locked root from elsewhere')
      assert.equal((await hook('guard', pre(p, 'Bash', { command: 'ls /tmp' }, { cwd: '/' }), p.env)).json, null)
      for (const [tool, input] of [['Read', { file_path: join(p.repo, 'README.md') }], ['Grep', { pattern: 'x' }], ['Glob', { pattern: '**/*.md' }]]) {
        assert.equal((await hook('guard', pre(p, tool, input), p.env)).json, null, tool)
      }
      // A restore failure keeps the lock and changes the explanation.
      await markRestoreFailed(g.locks, p.repo)
      const failed = await hook('guard', pre(p, 'Bash', { command: 'ls' }), p.env)
      assert.equal(decision(failed), 'deny')
      assert.match(reason(failed), /a verification failed to restore the workspace; run cc-rsi doctor in a terminal/)
    } finally {
      await releaseWorkspaceLock(lock)
    }
    const { rmSync } = await import('node:fs')
    rmSync(g.locks, { recursive: true, force: true })
    assert.equal((await hook('guard', pre(p, 'Bash', { command: 'ls' }), p.env)).json, null)
  })

  it('keeps <home> private except the read-only view, <home>/bin and the open draft', async () => {
    const p = await setupProject()
    const { sl, g, pl } = await started(p)
    for (const [tool, input] of [
      ['Read', { file_path: join(p.home, 'config.json') }],
      ['Read', { file_path: sl.task }],
      ['Write', { file_path: sl.verdicts, content: '{}' }],
      ['Edit', { file_path: join(pl.store, 'journal.jsonl'), old_string: 'a', new_string: 'b' }],
      ['Read', { file_path: join(pl.store, 'memory', 'a.md') }],
      ['Glob', { pattern: `${p.home}/**/*.json` }],
      ['Grep', { pattern: 'PASS', path: join(p.home, 'projects') }],
    ]) {
      const r = await hook('guard', pre(p, tool, input), p.env)
      assert.equal(decision(r), 'deny', `${tool} ${JSON.stringify(input)}`)
      assert.match(reason(r), tool === 'Glob' ? /^narrow the search path; it covers cc-rsi private state$/ : /is cc-rsi private state; it is not part of your task\.$/)
    }
    const wide = await hook('guard', pre(p, 'Grep', { pattern: 'x', path: '/' }), p.env)
    assert.equal(reason(wide), 'narrow the search path; it covers cc-rsi private state')
    // The view: reads allowed (with an allow decision), writes denied.
    const viewRead = await hook('guard', pre(p, 'Read', { file_path: join(sl.viewDir, 'INDEX.md') }), p.env)
    assert.equal(decision(viewRead), 'allow')
    const viewGrep = await hook('guard', pre(p, 'Grep', { pattern: 'x', path: sl.viewDir }), p.env)
    assert.equal(decision(viewGrep), 'allow')
    const viewWrite = await hook('guard', pre(p, 'Write', { file_path: join(sl.viewDir, 'x.md'), content: 'x' }), p.env)
    assert.equal(reason(viewWrite), 'the memory view is read-only; durable memory changes only through learn → memory_commit')
    // <home>/bin is readable, not writable.
    assert.equal((await hook('guard', pre(p, 'Read', { file_path: g.binShim }), p.env)).json, null)
    assert.equal(decision(await hook('guard', pre(p, 'Write', { file_path: g.binShim, content: '' }), p.env)), 'deny')
    // The draft: only while learning is open.
    const draftDir = join(pl.drafts, 'task-x-1-g1')
    mkdirSync(draftDir, { recursive: true })
    const closed = await hook('guard', pre(p, 'Write', { file_path: join(draftDir, 'a.md'), content: 'x' }), p.env)
    assert.equal(decision(closed), 'deny')
    await withTask(sl, s => { s.learning = { episode: 'task-x-1-g1', taskSeq: 1, gen: 1, verdict: 'PASS', stage: 'distill', code: 'abcdef', draftDir } })
    for (const [tool, input] of [['Write', { file_path: join(draftDir, 'a.md'), content: 'x' }], ['Edit', { file_path: join(draftDir, 'a.md'), old_string: 'x', new_string: 'y' }],
      ['MultiEdit', { file_path: join(draftDir, 'a.md'), edits: [] }], ['Read', { file_path: join(draftDir, 'a.md') }]]) {
      assert.equal(decision(await hook('guard', pre(p, tool, input), p.env)), 'allow', tool)
    }
    const bashDraft = await hook('guard', pre(p, 'Bash', { command: `printf 'x' > ${draftDir}/b.md && cat ${sl.viewDir}/a.md` }), p.env)
    assert.equal(bashDraft.json, null)
  })

  it('denies Bash references to private state, human-only commands, explore start and Verifier session ids', async () => {
    const p = await setupProject()
    const { sl } = await started(p)
    const deny = async (command, pattern) => {
      const r = await hook('guard', pre(p, 'Bash', { command }), p.env)
      assert.equal(decision(r), 'deny', command)
      if (pattern) assert.match(reason(r), pattern, command)
    }
    await deny(`cat ${sl.task}`, /is cc-rsi private state/)
    // <home>/bin is exec-only for shell commands: the shim runs, it is never written.
    const shim = join(p.home, 'bin', 'cc-rsi')
    for (const ok of [`"${shim}" status`, `${shim} memory show | head -5`, 'FOO=1 $CC_RSI_HOME/bin/cc-rsi doctor']) {
      assert.equal((await hook('guard', pre(p, 'Bash', { command: ok }), p.env)).json, null, ok)
    }
    for (const bad of [`echo 'exec evil' > ${shim}`, `cp /tmp/x ${join(p.home, 'bin')}/`, `sh -c "echo > ${shim}"`, 'tee $CC_RSI_HOME/bin/cc-rsi < /tmp/x', `chmod +x ${shim}`]) {
      await deny(bad, /only running the cc-rsi shim is allowed/)
    }
    await deny('cat $CC_RSI_HOME/config.json', /is cc-rsi private state/)
    await deny(`cd ${p.home} && ls projects`, /is cc-rsi private state/)
    for (const sub of ['eval run deep-1', 'memory unfreeze --after-sealed', 'memory restore 3', 'memory import /x', 'memory verify --accept-external',
      'memory drafts --prune', 'explore abandon deep-1', 'doctor --release-lock /repo', 'verify cancel']) {
      await deny(`node "/plugins/cc-rsi/bin/cc-rsi" ${sub}`, /^cc-rsi: that command is human-only; ask the user to run it in a terminal$/)
      await deny(`cc-rsi ${sub}`, /human-only/)
    }
    await deny('cc-rsi explore start --phase broad --yes', /human-only/)
    await deny('cc-rsi explore resume deep-1', /human-only/)
    // Read-only CLI commands stay available to the model.
    for (const ok of ['cc-rsi status', 'cc-rsi explore status', 'cc-rsi memory show', 'node /x/bin/cc-rsi doctor', 'git restore README.md', 'npm test']) {
      const r = await hook('guard', pre(p, 'Bash', { command: ok }), p.env)
      assert.equal(r.json, null, ok)
    }
    // exploration.modelMayStart (global config only) lets the model start lineages.
    writeFileSync(join(p.home, 'config.json'), JSON.stringify({ exploration: { modelMayStart: true } }))
    assert.equal((await hook('guard', pre(p, 'Bash', { command: 'cc-rsi explore start --phase broad --yes' }), p.env)).json, null)
    // Independent Verifier transcripts and session ids.
    const vsid = '6f1c1234-5678-4abc-8def-0123456789ab'
    await withTask(sl, s => { s.task = { seq: 1, verifier: { sessionId: vsid }, reports: [] } })
    await deny(`grep -r PASS ~/.claude/projects/x/${vsid}.jsonl`)
    await deny(`echo ${vsid}`, /independent Verifier session/)
    const userHome = await tmpDir('cc-rsi-user-home-')
    const env = { ...p.env, HOME: userHome }
    const readTranscript = await hook('guard', pre(p, 'Read', { file_path: join(userHome, '.claude', 'projects', '-repo', `${vsid}.jsonl`) }), env)
    assert.match(reason(readTranscript), /independent Verifier transcript/)
  })

  it('denies edits of the project cc-rsi config while a job runs', async () => {
    const p = await setupProject()
    const { sl } = await started(p)
    const cfg = join(p.repo, '.claude', 'cc-rsi.json')
    assert.equal((await hook('guard', pre(p, 'Write', { file_path: cfg, content: '{}' }), p.env)).json, null)
    await withTask(sl, s => { s.job = { id: 'j-20260101000000-abcdef', pid: null, gen: 1, taskSeq: 1 } })
    assert.equal(decision(await hook('guard', pre(p, 'Write', { file_path: cfg, content: '{}' }), p.env)), 'deny')
  })

  it('meets the p95 < 150 ms budget for guard and attest', async () => {
    const p = await setupProject()
    await started(p)
    // A bare `node -e 0` spawn measured interleaved with the hooks is the machine's own floor. On an
    // idle machine the SPEC budget is asserted as is (p95 < 150 ms); on a loaded machine (a parallel
    // test run) single scheduling outliers dominate a p95, so the test asserts what the hook adds to
    // node's own start-up instead (median over the baseline median).
    const timed = async fn => {
      const t0 = process.hrtime.bigint()
      await fn()
      return Number(process.hrtime.bigint() - t0) / 1e6
    }
    const samples = { guard: [], attest: [], node: [] }
    for (let i = 0; i < 15; i++) {
      samples.node.push(await timed(() => runNode('-e', ['0'], { env: p.env })))
      samples.guard.push(await timed(async () => assert.equal((await hook('guard', pre(p, 'Bash', { command: 'ls -la src && cat README.md' }), p.env)).code, 0)))
      samples.attest.push(await timed(async () => assert.equal((await hook('attest', fixture('pre-tool-use-mcp', p, { extra: { tool_use_id: `toolu_timing_${i}` } }), p.env)).code, 0)))
    }
    const at = (list, q) => [...list].sort((a, b) => a - b)[Math.ceil(list.length * q) - 1]
    const idle = at(samples.node, 0.5) <= 80 && loadavg()[0] <= cpus().length / 2
    for (const sub of ['guard', 'attest']) {
      const detail = `${sub}: p95 ${at(samples[sub], 0.95).toFixed(1)} ms, median ${at(samples[sub], 0.5).toFixed(1)} ms; node -e 0 median ${at(samples.node, 0.5).toFixed(1)} ms`
      if (idle) assert.ok(at(samples[sub], 0.95) < 150, detail)
      else assert.ok(at(samples[sub], 0.5) - at(samples.node, 0.5) < 100, detail)
    }
  })
})

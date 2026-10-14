// SPEC §15.3 WP5 hooks: the main-session PreToolUse guard — lock deny for the main thread and for an
// `agent_id` payload, private-path deny, view/draft allow, human-only Bash deny, `explore start`
// deny, Verifier transcripts (security-3), the plugin code (security-4), an external store
// (security-5), and the p95 < 150 ms budget for guard and attest.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { acquireWorkspaceLock, markRestoreFailed, releaseWorkspaceLock } from '../../lib/interactive/wslock.mjs'
import { withTask } from '../../lib/interactive/task.mjs'
import { humanOnlyIn, transcriptSlug } from '../../lib/hooks/guard.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { shq, tmpDir } from '../_helpers/tmp.mjs'
import { ROOT, deadPid, fixture, hook, layouts, setupProject } from '../interactive/harness.mjs'

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
    for (const ok of [`"${shim}" status`, `${shq(shim)} memory show | head -5`, 'FOO=1 "$CC_RSI_HOME/bin/cc-rsi" doctor']) {
      assert.equal((await hook('guard', pre(p, 'Bash', { command: ok }), p.env)).json, null, ok)
    }
    for (const bad of [`echo 'exec evil' > ${shq(shim)}`, `cp /tmp/x ${shq(join(p.home, 'bin'))}/`, `sh -c "echo > '${shim}'"`, 'tee "$CC_RSI_HOME/bin/cc-rsi" < /tmp/x', `chmod +x ${shq(shim)}`]) {
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
    const { sl } = await started(p)
    // With a Verifier id (the transcript rule is on) and a 200-line heredoc (r2-overblock-8).
    await withTask(sl, s => { s.verifierSessionIds = ['7a9f86c9-0000-4000-8000-00000000000a']; s.task = { seq: 1, candidateRoot: p.repo, verifier: { sessionId: '7a9f86c9-0000-4000-8000-00000000000a' }, reports: [] } })
    const body = Array.from({ length: 200 }, (_, i) => `rows.append({"id": ${i}, "path": "data/part-${i}.csv", "ok": glob.glob("out/*.txt")})  # see src/lib/f${i}.py`).join('\n')
    const heredoc = `python3 - <<'EOF'\nimport glob\nrows = []\n${body}\nprint(len(rows))\nEOF`
    // A bare `node -e 0` spawn measured interleaved with the hooks is the machine's own floor. On an
    // idle machine the SPEC budget is asserted as is (p95 < 150 ms); on a loaded machine (a parallel
    // test run) single scheduling outliers dominate a p95, so the test asserts what the hook adds to
    // node's own start-up instead (median over the baseline median). Load slows both by the same
    // factor, so that overhead is bounded relative to the floor: under 100 ms or 4 node start-ups
    // (idle, the guard adds about 2 start-ups; a hook twice as slow adds about 5).
    const timed = async fn => {
      const t0 = process.hrtime.bigint()
      await fn()
      return Number(process.hrtime.bigint() - t0) / 1e6
    }
    const samples = { guard: [], heredoc: [], attest: [], node: [] }
    for (let i = 0; i < 15; i++) {
      samples.node.push(await timed(() => runNode('-e', ['0'], { env: p.env })))
      samples.guard.push(await timed(async () => assert.equal((await hook('guard', pre(p, 'Bash', { command: 'ls -la src && cat README.md' }), p.env)).code, 0)))
      samples.heredoc.push(await timed(async () => assert.equal((await hook('guard', pre(p, 'Bash', { command: heredoc }), p.env)).json, null)))
      samples.attest.push(await timed(async () => assert.equal((await hook('attest', fixture('pre-tool-use-mcp', p, { extra: { tool_use_id: `toolu_timing_${i}` } }), p.env)).code, 0)))
    }
    const at = (list, q) => [...list].sort((a, b) => a - b)[Math.ceil(list.length * q) - 1]
    const idle = at(samples.node, 0.5) <= 80 && loadavg()[0] <= cpus().length / 2
    for (const sub of ['guard', 'heredoc', 'attest']) {
      const detail = `${sub}: p95 ${at(samples[sub], 0.95).toFixed(1)} ms, median ${at(samples[sub], 0.5).toFixed(1)} ms; node -e 0 median ${at(samples.node, 0.5).toFixed(1)} ms`
      if (idle) assert.ok(at(samples[sub], 0.95) < 150, detail)
      else assert.ok(at(samples[sub], 0.5) - at(samples.node, 0.5) < Math.max(100, 4 * at(samples.node, 0.5)), detail)
    }
  })
})

describe('main-session guard: Verifier transcripts, plugin code, external store', () => {
  /** A user home whose Claude Code transcript dir holds the project's slug dir (Actor + Verifier transcripts). */
  async function transcriptsOf(p) {
    const userHome = await tmpDir('cc-rsi-user-home-')
    const env = { ...p.env, HOME: userHome, CLAUDE_CONFIG_DIR: join(userHome, '.claude') }
    const projects = join(userHome, '.claude', 'projects')
    const slugDir = join(projects, transcriptSlug(p.repo))
    mkdirSync(join(slugDir, 'memory'), { recursive: true })
    mkdirSync(join(slugDir, p.sid, 'tool-results'), { recursive: true })
    return { userHome, env, projects, slugDir }
  }
  const vsid = '7a9f86c9-0000-4000-8000-000000000001'

  it('hides the candidate root transcript dir while the first Verifier job is in flight (security-3 a)', async () => {
    const p = await setupProject()
    const { sl } = await started(p)
    const { env, projects, slugDir } = await transcriptsOf(p)
    const read = file => hook('guard', pre(p, 'Read', { file_path: file }), env)
    // No Verifier yet: the transcript dir is not cc-rsi's business.
    assert.equal((await read(join(slugDir, 'other.jsonl'))).json, null)
    // submit minted a fresh context: the id lives only in the job file until the verdict.
    const jobId = 'j-20260101000000-abcdef'
    mkdirSync(sl.jobs, { recursive: true })
    writeFileSync(join(sl.jobs, `${jobId}.json`), JSON.stringify({ v: 1, id: jobId, status: 'running', sessionId: p.sid, candidateRoot: p.repo, verifier: { sessionId: vsid, fresh: true } }))
    await withTask(sl, s => { s.job = { id: jobId, pid: process.pid, gen: 1, taskSeq: 1 }; s.task = { seq: 1, candidateRoot: p.repo, verifier: { sessionId: null }, reports: [] } })
    const denyFile = async (tool, input, pattern = /independent Verifier transcript/) => {
      const r = await hook('guard', pre(p, tool, input), env)
      assert.equal(decision(r), 'deny', `${tool} ${JSON.stringify(input)}`)
      assert.match(reason(r), pattern)
    }
    await denyFile('Read', { file_path: join(slugDir, `${vsid}.jsonl`) })
    await denyFile('Read', { file_path: join(slugDir, 'any-other-session.jsonl') })
    await denyFile('Glob', { pattern: '*.jsonl', path: slugDir })
    await denyFile('Glob', { pattern: `${projects}/*/*.jsonl` })
    await denyFile('Grep', { pattern: 'VERDICT', path: join(projects) })
    // Claude Code's auto-memory and this session's own files (persisted tool results) stay readable.
    assert.equal(decision(await read(join(slugDir, 'memory', 'MEMORY.md'))), null)
    assert.equal(decision(await read(join(slugDir, p.sid, 'tool-results', 'out.txt'))), null)
    assert.equal(decision(await read(join(slugDir, `${p.sid}.jsonl`))), null)
    assert.equal(decision(await hook('guard', pre(p, 'Grep', { pattern: 'x', path: join(slugDir, 'memory') }), env)), null)
  })

  it('denies Bash reads and edits of Verifier transcripts by path, glob or ancestor (security-3 b)', async () => {
    const p = await setupProject()
    const { sl } = await started(p)
    const { env, slugDir } = await transcriptsOf(p)
    await withTask(sl, s => { s.task = { seq: 1, candidateRoot: p.repo, verifier: { sessionId: vsid }, reports: [] } })
    const bash = command => hook('guard', pre(p, 'Bash', { command }), env)
    for (const command of [
      'grep -h VERDICT ~/.claude/projects/*/*.jsonl',
      `sed -i 's/VERDICT: FAIL/VERDICT: PASS/' ${slugDir}/*.jsonl`,
      `cat "${slugDir}"/*.jsonl`,
      'grep -r VERDICT ~/.claude/projects',
      'python3 walk.py ~/.claude',
      'cd ~/.claude && python3 walk.py .',
      'python3 -c "import os; print(list(os.walk(\'$HOME/.claude/projects\')))"',
      'bash -c "grep -r VERDICT ~/.claude"',
      'cat $HOME/.claude/*/-tmp-*/x.jsonl',
      `cd ${slugDir} && cat *.jsonl`,
      'cd ~/.claude && grep -r VERDICT .',
      'ls ~/.claude/projects/*/*.jsonl',
    ]) {
      const r = await bash(command)
      assert.equal(decision(r), 'deny', command)
      assert.match(reason(r), /independent Verifier transcript/, command)
    }
    const fromHome = await hook('guard', pre(p, 'Bash', { command: 'cat .claude/projects/*/*.jsonl' }, { cwd: env.HOME }), env)
    assert.equal(decision(fromHome), 'deny', 'a relative glob from the user home')
    // Commands that name the config dir without walking it, and globs that stay in the allowed
    // auto-memory, are not refused (r2-overblock-2).
    for (const command of [`cat ${slugDir}/memory/MEMORY.md`, `head -50 ${slugDir}/${p.sid}/tool-results/out.txt`, 'cat ~/.claude/settings.json', 'ls ~/.claude/plugins', 'git status',
      'ls ~/.claude', 'ls -la ~/.claude/', 'cd ~/.claude && git status', 'git -C ~/.claude log --oneline -5', 'cp .claude/settings.json ~/.claude/',
      'ln -s ~/dotfiles/CLAUDE.md ~/.claude/', 'CLAUDE_CONFIG_DIR=~/.claude claude mcp list', "echo 'export CLAUDE_CONFIG_DIR=~/.claude' >> ~/.zshrc",
      'git commit -m "docs: document the ~/.claude/ settings layout"', 'echo "see ~/.claude for config"', 'ls $HOME/.claude/', 'ls ~/.claude/projects',
      'cat ~/.claude/projects/*/memory/MEMORY.md', 'grep -c x ~/.claude/projects/*/memory/MEMORY.md', 'ls ~/.claude/projects/*/memory']) {
      assert.equal((await bash(command)).json, null, command)
    }
  })

  it('keeps every Verifier id the session minted (verifierSessionIds), not only the current contexts (security-3 c)', async () => {
    const p = await setupProject()
    const { sl } = await started(p)
    const { env, projects, slugDir } = await transcriptsOf(p)
    const retired = '5d80e5f2-0000-4000-8000-000000000002'
    // A restarted context dropped the old id from task.verifier; an earlier task's root differs.
    await withTask(sl, s => { s.verifierSessionIds = [retired, vsid]; s.task = { seq: 3, candidateRoot: p.repo, verifier: { sessionId: vsid }, reports: [] }; s.prevTask = null })
    const elsewhere = join(projects, '-tmp-old-worktree', `${retired}.jsonl`)
    assert.match(reason(await hook('guard', pre(p, 'Read', { file_path: elsewhere }), env)), /independent Verifier transcript/)
    assert.equal(decision(await hook('guard', pre(p, 'Bash', { command: `cat ${elsewhere}` }), env)), 'deny')
    assert.equal(decision(await hook('guard', pre(p, 'Read', { file_path: join(slugDir, `${retired}.jsonl`) }), env)), 'deny')
    // The list alone protects the slug dir (no current context).
    await withTask(sl, s => { s.verifierSessionIds = [retired]; s.task = { seq: 4, candidateRoot: p.repo, verifier: { sessionId: null }, reports: [] } })
    assert.equal(decision(await hook('guard', pre(p, 'Read', { file_path: join(slugDir, 'new.jsonl') }), env)), 'deny')
  })

  it('computes Claude Code transcript directory names', () => {
    assert.equal(transcriptSlug('/tmp/cc-rsi-repo-Gk3B9q'), '-tmp-cc-rsi-repo-Gk3B9q')
    assert.equal(transcriptSlug('/home/user/CC-RSI'), '-home-user-CC-RSI')
    const long = `/tmp/${'x'.repeat(250)}`
    const slug = transcriptSlug(long)
    assert.equal(slug.slice(0, 201), `${long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-`)
    assert.match(slug.slice(201), /^[0-9a-z]+$/)
  })

  it('keeps the running plugin code read/exec-only (security-4)', async () => {
    const p = await setupProject()
    await started(p)
    const deny = async (tool, input) => {
      const r = await hook('guard', pre(p, tool, input), p.env)
      assert.equal(decision(r), 'deny', `${tool} ${JSON.stringify(input)}`)
      assert.match(reason(r), /is the running cc-rsi plugin code; it cannot be changed from this session/)
    }
    await deny('Edit', { file_path: join(ROOT, 'lib', 'interactive', 'verify-job.mjs'), old_string: 'a', new_string: 'b' })
    await deny('Write', { file_path: join(ROOT, 'hooks', 'role-guard.mjs'), content: 'process.exit(0)' })
    await deny('MultiEdit', { file_path: join(ROOT, 'lib', 'hooks', 'guard.mjs'), edits: [] })
    await deny('NotebookEdit', { notebook_path: join(ROOT, 'x.ipynb'), new_source: '' })
    for (const command of [`sed -i s/x/y/ ${ROOT}/lib/sealed/eval.mjs`, `echo 'exit 0' > ${ROOT}/bin/cc-rsi`, `cp /tmp/x ${ROOT}/lib/`, `cd ${ROOT} && git checkout -- .`]) {
      await deny('Bash', { command })
    }
    // Reading and running it stay allowed.
    assert.equal((await hook('guard', pre(p, 'Read', { file_path: join(ROOT, 'lib', 'hooks', 'guard.mjs') }), p.env)).json, null)
    assert.equal((await hook('guard', pre(p, 'Grep', { pattern: 'x', path: join(ROOT, 'lib') }), p.env)).json, null)
    for (const command of [`node "${ROOT}/bin/cc-rsi" status --session ${p.sid}`, `${ROOT}/bin/cc-rsi memory show`]) {
      assert.equal((await hook('guard', pre(p, 'Bash', { command }), p.env)).json, null, command)
    }
    // CLAUDE_PLUGIN_ROOT may spell it through a link.
    const linkDir = await tmpDir('cc-rsi-plugin-link-')
    const link = join(linkDir, 'cc-rsi')
    symlinkSync(ROOT, link)
    const env = { ...p.env, CLAUDE_PLUGIN_ROOT: link }
    assert.equal(decision(await hook('guard', pre(p, 'Write', { file_path: join(link, 'lib', 'x.mjs'), content: '' }), env)), 'deny')
    assert.equal(decision(await hook('guard', pre(p, 'Bash', { command: `rm ${shq(join(link, 'hooks', 'role-guard.mjs'))}` }), env)), 'deny')
    // Developing cc-rsi itself (the project is the checkout): not enforced.
    const dev = { ...p.env, CLAUDE_PROJECT_DIR: ROOT }
    assert.equal((await hook('guard', pre(p, 'Edit', { file_path: join(ROOT, 'lib', 'hooks', 'guard.mjs'), old_string: 'a', new_string: 'b' }, { cwd: ROOT }), dev)).json, null)
  })

  it('keeps an external memory store (memory.dir) private like <home> (security-5)', async () => {
    const store = await tmpDir('cc-rsi-store-')
    const p = await setupProject({ config: { memory: { dir: store } } })
    await started(p)
    assert.ok(existsSync(join(store, 'memory')), 'SessionStart opened the external store')
    const deny = async (tool, input, env = p.env, extra = {}) => {
      const r = await hook('guard', pre(p, tool, input, extra), env)
      assert.equal(decision(r), 'deny', `${tool} ${JSON.stringify(input)}`)
      return reason(r)
    }
    assert.match(await deny('Write', { file_path: join(store, 'memory', 'planted.md'), content: 'x' }), /is cc-rsi private state/)
    await deny('Edit', { file_path: join(store, 'journal.jsonl'), old_string: 'a', new_string: 'b' })
    await deny('Read', { file_path: join(store, 'reports', 'abc.md') })
    await deny('Grep', { pattern: 'PASS', path: dirname(store) })
    assert.match(await deny('Bash', { command: `rm ${store}/frozen.json ${store}/sealed.json` }), /is cc-rsi private state/)
    // An unknown session (no session state) is covered through the global config.
    await deny('Read', { file_path: join(store, 'reports', 'abc.md') }, p.env, { session_id: undefined })
    // The read-only view (under <home>) is still the way to read memory.
    assert.equal(decision(await hook('guard', pre(p, 'Read', { file_path: join(layouts(p).sl.viewDir, 'INDEX.md') }), p.env)), 'allow')
  })

  it('never makes project-wide searches impossible through a ~, relative or in-project memory.dir (r2-overblock-1)', async () => {
    const searches = async (p, env) => {
      for (const [tool, input] of [['Grep', { pattern: 'TODO' }], ['Glob', { pattern: '**/*.js' }], ['Bash', { command: 'grep -rn TODO .' }], ['Bash', { command: 'rg TODO' }]]) {
        assert.equal((await hook('guard', pre(p, tool, input), env)).json, null, `${tool} ${JSON.stringify(input)}`)
      }
    }
    // `~/…` is the user home, not a directory named `~` in the project.
    const userHome = await tmpDir('cc-rsi-user-home-')
    const p = await setupProject({ config: { memory: { dir: '~/rsi-memory' } } })
    const env = { ...p.env, HOME: userHome }
    assert.equal((await hook('session-start', fixture('session-start', p), env)).code, 0)
    assert.ok(existsSync(join(userHome, 'rsi-memory', 'memory')), 'the store opened under the user home')
    assert.ok(!existsSync(join(p.repo, '~')), 'no literal ~ directory in the project')
    await searches(p, env)
    assert.equal(decision(await hook('guard', pre(p, 'Read', { file_path: join(userHome, 'rsi-memory', 'journal.jsonl') }), env)), 'deny')
    // A relative value is refused with a visible warning; the default store is used.
    const q = await setupProject({ config: { memory: { dir: 'rsi-memory' } } })
    const start = await hook('session-start', fixture('session-start', q), q.env)
    assert.match(start.json?.systemMessage ?? '', /memory\.dir in ~\/\.cc-rsi\/config\.json is not an absolute path/)
    assert.ok(!existsSync(join(q.repo, 'rsi-memory')))
    await searches(q, q.env)
    // An absolute store inside the project: direct paths stay private, searches pass, the user is warned.
    const r = await setupProject()
    const inside = join(r.repo, 'mem')
    writeFileSync(join(r.home, 'config.json'), JSON.stringify({ memory: { dir: inside } }))
    const warned = await hook('session-start', fixture('session-start', r), r.env)
    assert.match(warned.json?.systemMessage ?? '', /memory\.dir \(.*\) lies inside this project: move it outside/)
    await searches(r, r.env)
    assert.equal(decision(await hook('guard', pre(r, 'Read', { file_path: join(inside, 'journal.jsonl') }), r.env)), 'deny')
    assert.equal(decision(await hook('guard', pre(r, 'Bash', { command: 'cat mem/journal.jsonl' }), r.env)), 'deny')
    assert.equal(decision(await hook('guard', pre(r, 'Grep', { pattern: 'x', path: inside }), r.env)), 'deny')
  })

  it('gives Bash tree walks rooted above <home> the search reason, and globs into it the private reason (security-6)', async () => {
    const p = await setupProject()
    await started(p)
    const above = dirname(p.home)
    const bash = async (command, extra = {}) => hook('guard', pre(p, 'Bash', { command }, extra), p.env)
    for (const command of [`grep -rn VERDICT ${shq(above)}`, `find ${shq(above)} -name task.json`, 'cd .. && grep -r VERDICT .']) {
      const r = await bash(command, command.startsWith('cd') ? { cwd: join(above, 'x') } : {})
      assert.equal(decision(r), 'deny', command)
      assert.equal(reason(r), 'narrow the search path; it covers cc-rsi private state', command)
    }
    const glob = await bash(`cat ${shq(p.home.slice(0, -2))}*/projects/*/sessions/*/task.json`)
    assert.equal(decision(glob), 'deny')
    assert.match(reason(glob), /is cc-rsi private state; it is not part of your task\.$/)
    // Narrow walks stay allowed.
    assert.equal((await bash(`grep -rn x ${shq(p.repo)}`)).json, null)
  })

  it('denies explore start/resume with options before the subcommand', async () => {
    const p = await setupProject()
    await started(p)
    for (const command of ['cc-rsi explore --yes start --phase broad', 'cc-rsi explore --report-exit resume deep-1', 'node /x/bin/cc-rsi explore --json start']) {
      const r = await hook('guard', pre(p, 'Bash', { command }), p.env)
      assert.equal(decision(r), 'deny', command)
      assert.match(reason(r), /human-only/, command)
    }
    assert.equal((await hook('guard', pre(p, 'Bash', { command: 'cc-rsi explore --report-exit status' }), p.env)).json, null)
    // Free text that merely mentions the words is not a command (r2-overblock-4).
    for (const command of ['git commit -m "cc-rsi explore: the guard now catches options before start"', 'git commit -m "cc-rsi: restore the view on resume"',
      'node /x/bin/cc-rsi explore preflight --phase broad --direction "make the dev server start faster"']) {
      assert.equal((await hook('guard', pre(p, 'Bash', { command }), p.env)).json, null, command)
    }
  })

  it('parses human-only cc-rsi invocations instead of matching free text (r2-overblock-4)', () => {
    const denied = ['cc-rsi eval run deep-1', 'cc-rsi explore --yes start', 'cc-rsi explore --report-exit start', 'cc-rsi explore --phase broad start',
      "sh -c 'cc-rsi eval run x'", 'bash -lc "cc-rsi memory import /x"', 'eval cc-rsi verify cancel', '"$HOME/.cc-rsi/bin/cc-rsi" memory unfreeze',
      'node /p/bin/cc-rsi doctor --release-lock /repo', 'node --no-warnings /p/bin/cc-rsi memory drafts --prune', 'cc-rsi memory verify --accept-external',
      'env -u CLAUDECODE cc-rsi explore abandon deep-1', 'x=$(cc-rsi eval show deep-1)', 'find . -name x -exec cc-rsi eval run {} \\;',
      'cc-rsi doctor --release-lock=/repo', 'cc-rsi explore resume deep-1 --accept-drift', 'echo y | cc-rsi memory restore 3']
    for (const command of denied) assert.equal(humanOnlyIn(command), true, command)
    assert.equal(humanOnlyIn('cc-rsi explore start --phase broad', { modelMayStart: true }), false)
    const allowed = ['git commit -m "cc-rsi: fix explore start option parsing"', 'git commit -m "cc-rsi explore: handle resume after crash"',
      'cat /u/src/cc-rsi/lib/sealed/eval.mjs | head -40', 'node --test /u/src/cc-rsi/test/sealed/eval.test.mjs', 'gh pr create --title "cc-rsi: fix memory import" --body "Fixes the import path"',
      'gh issue create -R me/cc-rsi --title "cancel leaves the lock behind"', 'cat vendor/cc-rsi/lib/sealed/eval.mjs', 'git diff vendor/cc-rsi/lib/memory/import.mjs',
      'node /x/bin/cc-rsi explore preflight --phase broad --direction "make the dev server start faster"', 'cc-rsi explore status', 'cc-rsi memory show',
      'cc-rsi status', 'node -e "require(\'cc-rsi\')" eval', 'cc-rsi explore show deep-1', 'cc-rsi explore log deep-1 -n 5', 'cc-rsi doctor --live']
    for (const command of allowed) assert.equal(humanOnlyIn(command), false, command)
  })

  it('starts the recovery of a job that died with its checkpoint open and explains the wait (memory-crash-2)', async () => {
    const p = await setupProject()
    const { g, sl } = await started(p)
    const jobFile = join(sl.jobs, 'j-20260101000000-dead01.json')
    mkdirSync(g.locks, { recursive: true })
    const { lockFileFor } = await import('../../lib/interactive/wslock.mjs')
    const { hostname } = await import('node:os')
    const pid = deadPid()
    writeFileSync(lockFileFor(g.locks, p.repo), `${JSON.stringify({
      pid, host: hostname(), token: 'x:y', at: new Date().toISOString(),
      owner: { root: p.repo, jobId: 'j-20260101000000-dead01', sessionId: p.sid, jobFile, restoreFailed: false, checkpointOpen: true },
    })}\n`)
    const r = await hook('guard', pre(p, 'Bash', { command: 'ls' }), p.env)
    assert.equal(decision(r), 'deny')
    assert.match(reason(r), /^cc-rsi: a verification job \(job j-20260101000000-dead01\) ended without restoring its checkpoint of this workspace; its recovery is running, retry shortly/)
    // The recovery was spawned (its log file is opened by the spawn).
    assert.ok(existsSync(jobFile.replace(/\.json$/, '.log')), 'the guard spawned the job recovery')
  })
})

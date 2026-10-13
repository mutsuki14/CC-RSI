// SPEC §15.3 WP5 `test/interactive/flow.test.mjs`: the interactive mode end to end with the fake
// claude, the real MCP server over stdio, the real hooks and the real detached verification job.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'
import {
  McpClient, TOOL_PREFIX, callTool, confirmCodeIn, hook, jobsOf, layouts, payloads, reapJobs, setupProject, taskState, until,
} from './harness.mjs'

const homes = []
after(async () => {
  for (const home of homes) await reapJobs(home)
})

async function project(opts) {
  const p = await setupProject(opts)
  homes.push(p.home)
  const ss = await hook('session-start', payloads.sessionStart(p), p.env)
  assert.equal(ss.code, 0, ss.stderr)
  return p
}

async function userSays(p, text) {
  const r = await hook('prompt', payloads.prompt(p, text), p.env)
  assert.equal(r.code, 0, r.stderr)
  return r
}

async function withClient(p, fn) {
  const client = new McpClient(p.env, { cwd: p.repo })
  try {
    await client.initialize()
    return await fn(client)
  } finally {
    await client.close()
  }
}

const verifierLog = p => p.fake.log().filter(entry => entry.ccRsi?.CC_RSI_ROLE === 'verifier')

/** Every stdin a Verifier context received (the invocation prompt.md files). */
function verifierPrompts(p) {
  const ctxDir = layouts(p).sl.ctx
  const out = []
  for (const key of readdirSync(ctxDir)) {
    for (const n of readdirSync(join(ctxDir, key))) {
      const file = join(ctxDir, key, n, 'prompt.md')
      if (existsSync(file)) out.push(readFileSync(file, 'utf8'))
    }
  }
  return out
}

function openStoreOf(p) {
  return MemoryStore.open(layouts(p).pl.store, { sessionsDir: layouts(p).pl.sessions, lineagesDir: layouts(p).pl.lineages })
}

describe('interactive flow (fake claude + real server + real job)', () => {
  it('refuses unattested calls and subagent callers, and never starts a job for them', async () => {
    const p = await project({ script: { verifier: { default: { text: 'VERDICT: PASS' } } } })
    await userSays(p, 'Make the README say hello')
    await withClient(p, async client => {
      const unattested = await callTool(p, client, 'submit', {}, { attest: false })
      assert.equal(unattested.isError, true)
      assert.match(unattested.text, /cannot attest this call/)
      const sub = await callTool(p, client, 'submit', {}, { agentId: 'a63db51518b9169b6' })
      assert.equal(sub.isError, true)
      assert.match(sub.text, /reserved for the main Actor conversation/)
      const learn = await callTool(p, client, 'learn', {}, { agentId: 'a1' })
      assert.match(learn.text, /reserved for the main Actor conversation/)
      // status is read-only and open to subagents.
      const status = await callTool(p, client, 'status', {}, { agentId: 'a1' })
      assert.equal(status.isError, undefined)
      assert.match(status.text, /^cc-rsi status — session /)
    })
    assert.equal(jobsOf(p).length, 0)
    assert.equal(verifierLog(p).length, 0)
  })

  it('FAIL → repair → the SAME Verifier context (--resume) → PASS → learn → memory_commit twice', async () => {
    const p = await project({
      script: {
        verifier: {
          turns: [
            { actions: [{ tool: 'Bash', command: 'cat src/app.txt' }], text: 'src/app.txt still says version 1.\nVERDICT: FAIL' },
            { actions: [{ tool: 'Bash', command: 'cat src/app.txt' }], text: 'src/app.txt says version 2 now.\nVERDICT: PASS' },
          ],
        },
      },
    })
    await userSays(p, 'Change src/app.txt to say version 2')
    await withClient(p, async client => {
      const first = await callTool(p, client, 'submit', {})
      assert.equal(first.isError, undefined)
      assert.match(first.text, /^cc-rsi · Verifier: VERDICT: FAIL \(generation 1, isolation=rollback, model=test-verifier-model\)/)
      assert.match(first.text, /src\/app\.txt still says version 1\./)
      // The Actor repairs; the lock was released when the job finished.
      const edit = await hook('guard', payloads.pre(p, 'Edit', { file_path: join(p.repo, 'src/app.txt'), old_string: '1', new_string: '2' }), p.env)
      assert.equal(edit.json, null)
      p.write('src/app.txt', 'version 2\n')
      const second = await callTool(p, client, 'submit', {})
      assert.match(second.text, /^cc-rsi · Verifier: VERDICT: PASS \(generation 2, isolation=rollback, model=test-verifier-model\)/)
      assert.match(second.text, /Next: call learn/)

      // One Verifier context: --session-id first, --resume of the same id afterwards (no reuse of --session-id).
      const log = verifierLog(p)
      assert.equal(log.length, 2)
      assert.equal(log[0].mode, 'new')
      assert.equal(log[1].mode, 'resume')
      assert.equal(log[0].sessionId, log[1].sessionId)
      assert.ok(log[0].argv.includes('--session-id') && !log[0].argv.includes('--resume'))
      assert.ok(log[1].argv.includes('--resume') && !log[1].argv.includes('--session-id'))
      assert.equal(log[1].argv[log[1].argv.indexOf('--model') + 1], 'test-verifier-model')
      const state = taskState(p)
      assert.equal(state.task.generation, 2)
      assert.deepEqual(state.task.reports.map(r => r.verdict), ['FAIL', 'PASS'])
      assert.equal(state.task.verifier.sessionId, log[0].sessionId)
      assert.equal(state.job, null)

      // Learning: distill (code 1) → reconcile (code 2) → promote.
      const learn = await callTool(p, client, 'learn', {})
      assert.equal(learn.isError, undefined)
      const code1 = confirmCodeIn(learn.text)
      assert.ok(code1, learn.text)
      const draftDir = taskState(p).learning.draftDir
      assert.ok(learn.text.includes(draftDir))
      const wrong = await callTool(p, client, 'memory_commit', { confirm: code1 === 'abcdef' ? '123456' : 'abcdef' })
      assert.equal(wrong.isError, true)
      assert.match(wrong.text, /confirmation code does not match/)
      // The Actor edits the draft; the guard allows it while learning is open.
      const allowWrite = await hook('guard', payloads.pre(p, 'Write', { file_path: join(draftDir, 'lessons/app.md'), content: 'x' }), p.env)
      assert.equal(allowWrite.json.hookSpecificOutput.permissionDecision, 'allow')
      writeFileSync(join(draftDir, 'app-version-lesson.md'), 'Version strings live in src/app.txt; check them with cat.\n')
      const reconcile = await callTool(p, client, 'memory_commit', { confirm: code1 })
      const code2 = confirmCodeIn(reconcile.text)
      assert.ok(code2 && code2 !== code1, reconcile.text)
      const stale = await callTool(p, client, 'memory_commit', { confirm: code1 })
      assert.equal(stale.isError, true)
      const promoted = await callTool(p, client, 'memory_commit', { confirm: code2 })
      assert.equal(promoted.isError, undefined, promoted.text)
      assert.match(promoted.text, /^Memory promoted \(PASS experience\)\. created: app-version-lesson\.md; modified: -; deleted: -\. Tree [0-9a-f]{12}, 1 files\.$/)
      const end = taskState(p)
      assert.equal(end.learning, null)
      assert.equal(end.task.learned, true)
      assert.equal(end.task.closed, true)
      // Memory changed only through the commit; the session's read-only view shows it.
      const store = await openStoreOf(p)
      const journal = await store.journal()
      assert.equal(journal.length, 1)
      assert.equal(journal[0].kind, 'task')
      assert.equal(journal[0].outcome, 'PASS')
      await store.assertCanonicalIntact()
      assert.equal(readFileSync(join(layouts(p).sl.viewDir, 'app-version-lesson.md'), 'utf8'), 'Version strings live in src/app.txt; check them with cat.\n')
      const again = await callTool(p, client, 'learn', {})
      assert.match(again.text, /already promoted|No learning phase|terminal Verifier verdict/)
      // verdicts.jsonl records both verdicts.
      const verdicts = readFileSync(layouts(p).sl.verdicts, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      assert.deepEqual(verdicts.map(v => v.verdict), ['FAIL', 'PASS'])
    })
  })

  it('UNVERIFIED → only formatted LEAD blocks reach the Verifier; Actor narrative never does', async () => {
    const SENTINEL = 'SENTINEL-ACTOR-NARRATIVE-7f3a'
    const p = await project({
      script: {
        verifier: {
          turns: [
            { actions: [{ tool: 'Bash', command: 'ls' }], text: 'I could not confirm the output format.\nVERDICT: UNVERIFIED' },
            { actions: [{ tool: 'Bash', command: 'ls' }], text: 'The lead reproduces.\nVERDICT: PASS' },
          ],
        },
      },
    })
    writeFileSync(join(p.home, 'transcript.jsonl'), `{"type":"assistant","text":"${SENTINEL} my private reasoning"}\n`)
    await userSays(p, 'Print the version in JSON')
    await withClient(p, async client => {
      // Leads before an UNVERIFIED verdict are ignored, with a note.
      const lead = { claim: 'the output is JSON', probe: 'python3 -c "import json;print(\'PASS\')"' }
      const first = await callTool(p, client, 'submit', { evidence_leads: [lead] })
      assert.match(first.text, /VERDICT: UNVERIFIED \(generation 1/)
      assert.match(first.text, /evidence_leads are forwarded only after an UNVERIFIED verdict/)
      assert.match(first.text, /UNVERIFIED is not a terminal verdict and cannot be learned/)
      // Unknown properties are rejected (never forwarded).
      const bad = await callTool(p, client, 'submit', { evidence_leads: [{ ...lead, note: SENTINEL }] })
      assert.equal(bad.isError, true)
      assert.match(bad.text, /Invalid arguments/)
      const narrative = await callTool(p, client, 'submit', { evidence_leads: [lead], handoff: SENTINEL })
      assert.equal(narrative.isError, true)
      const learn = await callTool(p, client, 'learn', {})
      assert.match(learn.text, /UNVERIFIED is not a terminal verdict/)
      const second = await callTool(p, client, 'submit', { evidence_leads: [lead] })
      assert.match(second.text, /VERDICT: PASS \(generation 2/)
    })
    const prompts = verifierPrompts(p)
    assert.equal(prompts.length, 2)
    assert.ok(!prompts[0].includes('LEAD 1'), 'no leads before UNVERIFIED')
    assert.match(prompts[1], /LEAD 1\nActor-stated claim: the output is JSON\nExact reproducible probe proposed by Actor:\n--- BEGIN PROBE ---\npython3 -c "import json;print\('PASS'\)"\n--- END PROBE ---\nHarness execution classification: NOT_RUN/)
    for (const text of prompts) {
      assert.ok(!text.includes(SENTINEL), 'Actor narrative never reaches the Verifier')
      assert.match(text, /Print the version in JSON/)
    }
    assert.equal(jobsOf(p).length, 2)
  })

  it('the Verifier mutates and creates files → the candidate is restored, displaced copies kept, HARNESS NOTE', async () => {
    const p = await project({
      script: {
        verifier: {
          turns: [{
            actions: [{ tool: 'Bash', command: 'echo tampered > src/app.txt && echo scratch > created-by-verifier.txt && cat README.md' }],
            text: 'Checked.\nVERDICT: PASS',
          }],
        },
      },
    })
    await userSays(p, 'Keep the app at version 1')
    await withClient(p, async client => {
      const r = await callTool(p, client, 'submit', {})
      assert.match(r.text, /VERDICT: PASS \(generation 1/)
      assert.match(r.text, /HARNESS NOTE: 2 path\(s\) changed during the inspection and were restored: created-by-verifier\.txt, src\/app\.txt|HARNESS NOTE: \d path\(s\) changed during the inspection and were restored: .*src\/app\.txt/)
      assert.match(r.text, /HARNESS NOTE: \d file version\(s\) present at the end of the inspection were moved aside/)
    })
    assert.equal(p.read('src/app.txt'), 'version 1\n')
    assert.equal(existsSync(join(p.repo, 'created-by-verifier.txt')), false)
    const [job] = jobsOf(p)
    const displaced = join(layouts(p).sl.displaced, job.id)
    assert.equal(readFileSync(join(displaced, 'src/app.txt'), 'utf8'), 'tampered\n')
    assert.equal(readFileSync(join(displaced, 'created-by-verifier.txt'), 'utf8'), 'scratch\n')
    assert.equal(job.checkpoint.open, false)
    assert.equal(existsSync(job.checkpoint.dir), false)
    assert.equal(readdirSync(layouts(p).g.locks).length, 0, 'the workspace lock is released')
  })

  it('RUNNING after the bounded wait; the lock pauses edits in every session; rewake; wait_verdict delivers', async () => {
    const p = await project({
      config: { interactive: { waitSeconds: 10 } },
      script: { verifier: { turns: [{ hangMs: 13000, actions: [{ tool: 'Bash', command: 'ls' }], text: 'Slow but fine.\nVERDICT: PASS' }] } },
    })
    await userSays(p, 'Tidy the README')
    await withClient(p, async client => {
      const started = Date.now()
      const running = await callTool(p, client, 'submit', {}, { progressToken: 7 })
      const waited = Date.now() - started
      assert.match(running.text, /^VERIFICATION RUNNING \(job j-\d{14}-[0-9a-f]{6}, generation 1\)/)
      assert.ok(waited >= 9500 && waited < 13000, `bounded wait (${waited} ms)`)
      const progress = client.notifications.filter(n => n.method === 'notifications/progress')
      assert.ok(progress.length >= 1)
      assert.equal(progress[0].params.progressToken, 7)
      assert.match(progress[0].params.message, /independent verification running/)
      const jobId = /job (j-[^,]+),/.exec(running.text)[1]
      // The lock: Bash/Edit denied in this session, in a subagent, and in a second session; Read allowed.
      for (const extra of [{}, { agent_id: 'sub1', agent_type: 'Explore' }, { session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]) {
        const bash = await hook('guard', payloads.pre(p, 'Bash', { command: 'touch x' }, extra), p.env)
        assert.equal(bash.json.hookSpecificOutput.permissionDecision, 'deny')
        assert.match(bash.json.hookSpecificOutput.permissionDecisionReason, new RegExp(`independent verification of this workspace is running \\(job ${jobId}`))
      }
      const write = await hook('guard', payloads.pre(p, 'Write', { file_path: join(p.repo, 'new.txt'), content: 'x' }, { cwd: '/' }), p.env)
      assert.equal(write.json.hookSpecificOutput.permissionDecision, 'deny')
      const read = await hook('guard', payloads.pre(p, 'Read', { file_path: join(p.repo, 'README.md') }), p.env)
      assert.equal(read.json, null)
      // The next user turn is told that a verification runs.
      const ups = await userSays(p, 'any news?')
      assert.match(ups.json.hookSpecificOutput.additionalContext, new RegExp(`verification is running \\(job ${jobId}\\)`))
      // The async rewake hook wakes the Actor when the verdict lands undelivered.
      const rewake = await hook('rewake', {
        ...payloads.pre(p, `${TOOL_PREFIX}submit`, {}), hook_event_name: 'PostToolUse', tool_response: running.content, duration_ms: waited,
      }, p.env, { timeoutMs: 30000 })
      assert.equal(rewake.code, 2)
      assert.match(rewake.stderr, new RegExp(`the independent verification \\(job ${jobId}\\) finished — VERDICT: PASS \\(generation 1\\)\\. Call wait_verdict`))
      const verdict = await callTool(p, client, 'wait_verdict', {})
      assert.match(verdict.text, /^cc-rsi · Verifier: VERDICT: PASS \(generation 1/)
      const none = await callTool(p, client, 'wait_verdict', {})
      assert.match(none.text, /^No verification is pending\. Last verdict: PASS \(task 1, generation 1\)\./)
    })
  })

  it('a job SIGKILLed mid-inspection is recovered: candidate restored, job_died infra, no verdict', async () => {
    const p = await project({
      script: { verifier: { turns: [{ actions: [{ tool: 'Bash', command: 'echo mutated > src/app.txt; echo new > stray.txt; sleep 25' }], text: 'VERDICT: PASS' }] } },
    })
    await userSays(p, 'Bump the version')
    await withClient(p, async client => {
      const pending = callTool(p, client, 'submit', {})
      const job = await until(() => {
        const [j] = jobsOf(p)
        return j && j.status === 'running' && Number.isInteger(j.pid) && existsSync(join(p.repo, 'stray.txt')) ? j : null
      }, { timeoutMs: 15000, what: 'the Verifier to mutate the candidate' })
      process.kill(job.pid, 'SIGKILL')
      const r = await pending
      assert.equal(r.isError, true)
      assert.match(r.text, /^INFRASTRUCTURE: the independent inspection could not reach a verdict \(job_died\)\. This is not a verdict about your work\./)
      assert.match(r.text, /the candidate was restored; this is not a verdict/)
    })
    assert.equal(p.read('src/app.txt'), 'version 1\n')
    assert.equal(existsSync(join(p.repo, 'stray.txt')), false)
    const state = taskState(p)
    assert.equal(state.job, null)
    assert.equal(state.task.lastVerdict, null)
    assert.equal(state.task.reports.length, 0)
    const [job] = jobsOf(p)
    assert.equal(job.status, 'infra')
    assert.equal(job.infra.cls, 'job_died')
    assert.equal(readdirSync(layouts(p).g.locks).length, 0)
  })

  it('infra never sets a verdict, never enables learn (transport liveness)', async () => {
    const p = await project({ script: { verifier: { default: { text: 'Still thinking about it.' } } } })
    await userSays(p, 'Do the thing')
    await withClient(p, async client => {
      const r = await callTool(p, client, 'submit', {})
      assert.equal(r.isError, true)
      assert.match(r.text, /^INFRASTRUCTURE: the independent inspection could not reach a verdict \(transport_liveness\)/)
      const learn = await callTool(p, client, 'learn', {})
      assert.match(learn.text, /needs a terminal Verifier verdict/)
    })
    const state = taskState(p)
    assert.equal(state.task.lastVerdict, null)
    assert.equal(state.job, null)
    assert.equal(verifierLog(p).length, 3, 'three actionless replies, then infra')
  })

  it('stale PASS → learn refused; frozen, sealed and tamper refusals; verdict files are not writable through the guard', async () => {
    const p = await project({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'Fine.\nVERDICT: PASS' } } } })
    await userSays(p, 'Write docs')
    await withClient(p, async client => {
      assert.match((await callTool(p, client, 'submit', {})).text, /VERDICT: PASS/)
      // The guard keeps the harness state private.
      const { sl } = layouts(p)
      for (const target of [sl.task, sl.verdicts, join(sl.jobs, 'x.json'), join(p.home, 'config.json')]) {
        const w = await hook('guard', payloads.pre(p, 'Write', { file_path: target, content: '{}' }), p.env)
        assert.equal(w.json.hookSpecificOutput.permissionDecision, 'deny')
        assert.match(w.json.hookSpecificOutput.permissionDecisionReason, /cc-rsi private state/)
      }
      const bash = await hook('guard', payloads.pre(p, 'Bash', { command: `echo '{}' > ${sl.task}` }), p.env)
      assert.equal(bash.json.hookSpecificOutput.permissionDecision, 'deny')
      // Stale: the workspace changed after the inspection.
      p.write('README.md', '# changed after the verdict\n')
      const stale = await callTool(p, client, 'learn', {})
      assert.equal(stale.isError, true)
      assert.match(stale.text, /no longer covers the workspace/)
      const status = await callTool(p, client, 'status', {})
      assert.match(status.text, /last verdict PASS \(stale: workspace changed since inspection\)/)
      p.write('README.md', '# demo\n')
      // Tamper: canonical memory changed outside a commit.
      const store = await openStoreOf(p)
      writeFileSync(join(store.memoryDir, 'forged.md'), 'forged\n')
      const tamper = await callTool(p, client, 'learn', {})
      assert.match(tamper.text, /Canonical memory changed outside a commit/)
      await store.acceptExternal({ by: 'test' })
      // Frozen and sealed.
      await store.freeze({ by: 'test' })
      assert.match((await callTool(p, client, 'learn', {})).text, /Memory is frozen/)
      await store.unfreeze()
      await store.markSealed({ lineage: 'deep-1', runId: 'r-1' })
      assert.match((await callTool(p, client, 'learn', {})).text, /Memory is sealed/)
    })
  })

  it('a canonical change during learning → conflict: rebased draft with .prev, new code, then promoted', async () => {
    const p = await project({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'Bad.\nVERDICT: FAIL' } } } })
    await userSays(p, 'Fix the bug')
    await withClient(p, async client => {
      assert.match((await callTool(p, client, 'submit', {})).text, /VERDICT: FAIL/)
      const learn = await callTool(p, client, 'learn', {})
      const draftDir = taskState(p).learning.draftDir
      writeFileSync(join(draftDir, 'mine.md'), 'my lesson\n')
      const code2 = confirmCodeIn((await callTool(p, client, 'memory_commit', { confirm: confirmCodeIn(learn.text) })).text)
      // Another writer (e.g. a lineage) commits meanwhile.
      const store = await openStoreOf(p)
      const other = await mkdtemp(join(await tmpDir(), 'draft-'))
      await store.openDraft('other-episode', { dir: other, owner: { kind: 'engine', pid: process.pid } })
      writeFileSync(join(other, 'theirs.md'), 'their lesson\n')
      await store.commit('other-episode', { kind: 'practice', outcome: 'PASS' })
      const conflict = await callTool(p, client, 'memory_commit', { confirm: code2 })
      const code3 = confirmCodeIn(conflict.text)
      assert.ok(code3 && code3 !== code2, conflict.text)
      assert.ok(conflict.text.includes(`${draftDir}.prev`))
      assert.equal(readFileSync(join(`${draftDir}.prev`, 'mine.md'), 'utf8'), 'my lesson\n')
      assert.equal(readFileSync(join(draftDir, 'theirs.md'), 'utf8'), 'their lesson\n')
      writeFileSync(join(draftDir, 'mine.md'), 'my lesson\n')
      const promoted = await callTool(p, client, 'memory_commit', { confirm: code3 })
      assert.match(promoted.text, /^Memory promoted \(FAIL experience\)\. created: mine\.md; modified: -; deleted: -\./)
      const journal = await store.journal()
      assert.deepEqual(journal.map(r => r.episode).sort(), ['other-episode', taskState(p).task ? journal.find(r => r.kind === 'task').episode : ''].sort())
    })
  })

  it('abandon discards the draft and leaves memory unchanged; the task is skipped', async () => {
    const p = await project({ script: { verifier: { default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'Good.\nVERDICT: PASS' } } } })
    await userSays(p, 'Rename the file')
    await withClient(p, async client => {
      await callTool(p, client, 'submit', {})
      const learn = await callTool(p, client, 'learn', {})
      const draftDir = taskState(p).learning.draftDir
      assert.ok(existsSync(draftDir))
      const r = await callTool(p, client, 'memory_commit', { confirm: confirmCodeIn(learn.text), abandon: true })
      assert.match(r.text, /abandoned/)
      assert.equal(existsSync(draftDir), false)
      assert.equal(taskState(p).learning, null)
      assert.equal(taskState(p).task.learned, true)
      const store = await openStoreOf(p)
      assert.equal((await store.journal()).length, 0)
    })
  })
})

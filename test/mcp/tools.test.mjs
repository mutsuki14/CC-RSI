// WP5 unit tests of lib/mcp/tools.mjs (SPEC §11.4, §11.11, §11.12): waitSeconds (J2-12), argument
// validation, attestation binding (tool name, subagents), the unattested `status` fallback to
// CLAUDE_CODE_SESSION_ID, `interactive.enabled = false`, and the status text shape.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { writeJsonAtomic } from '../../lib/core/atomic.mjs'
import { LeaseLock } from '../../lib/core/lock.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { writeAttestation } from '../../lib/interactive/attest.mjs'
import { withTask } from '../../lib/interactive/task.mjs'
import { TOOLS, callTool, memoryIntegrity, validateArgs, waitBudgetMs, waitSeconds } from '../../lib/mcp/tools.mjs'
import { fixture, hook, jobsOf, layouts, reapJobs, setupProject, taskState, until } from '../interactive/harness.mjs'

const homes = []
after(async () => { for (const h of homes) await reapJobs(h) })

describe('waitSeconds', () => {
  it('is min(config ≤ 110, auto-background − 10 s) with a floor of 10', () => {
    assert.equal(waitSeconds({ interactive: { waitSeconds: 100 } }, {}), 100)
    assert.equal(waitSeconds({ interactive: { waitSeconds: 500 } }, {}), 110)
    assert.equal(waitSeconds({}, {}), 100)
    assert.equal(waitSeconds({ interactive: { waitSeconds: 100 } }, { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '60000' }), 50)
    assert.equal(waitSeconds({ interactive: { waitSeconds: 100 } }, { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '5000' }), 10)
    assert.equal(waitSeconds({ interactive: { waitSeconds: 100 } }, { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' }), 100)
    assert.equal(waitSeconds({ interactive: { waitSeconds: 3 } }, {}), 10)
  })

  it('waitBudgetMs keeps the whole call under the auto-background threshold, counting from its arrival (cc-integration-8)', () => {
    const now = 1_000_000
    assert.equal(waitBudgetMs({}, {}), 100000, 'without an arrival time: waitSeconds')
    assert.equal(waitBudgetMs({}, {}, { receivedAt: now, now }), 100000)
    // 30 s of lock and I/O waits before the wait began: 120 − 10 − 30 − 8 (delivery reserve) = 72 s.
    assert.equal(waitBudgetMs({}, {}, { receivedAt: now - 30000, now }), 72000)
    assert.equal(waitBudgetMs({ interactive: { waitSeconds: 110 } }, {}, { receivedAt: now - 5000, now }), 97000)
    assert.equal(waitBudgetMs({}, { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '30000' }, { receivedAt: now - 2000, now }), 10000)
    assert.equal(waitBudgetMs({}, {}, { receivedAt: now - 200000, now }), 1000, 'floor 1 s')
  })
})

describe('argument validation', () => {
  const schema = name => TOOLS.find(t => t.name === name).inputSchema
  it('accepts valid arguments and names the problem otherwise', () => {
    assert.equal(validateArgs(schema('submit'), {}), null)
    assert.equal(validateArgs(schema('submit'), undefined), null)
    assert.equal(validateArgs(schema('submit'), { evidence_leads: [{ claim: 'c', probe: 'p' }] }), null)
    assert.match(validateArgs(schema('submit'), { evidence_leads: Array.from({ length: 17 }, () => ({ claim: 'c', probe: 'p' })) }), /at most 16/)
    assert.match(validateArgs(schema('submit'), { evidence_leads: [{ claim: 'c'.repeat(2001), probe: 'p' }] }), /at most 2000/)
    assert.match(validateArgs(schema('submit'), { evidence_leads: [{ claim: 'c' }] }), /"probe" is required/)
    assert.match(validateArgs(schema('memory_commit'), { confirm: 'ABCDEF' }), /must match/)
    assert.equal(validateArgs(schema('memory_commit'), { confirm: 'abcdef', abandon: true }), null)
    assert.match(validateArgs(schema('wait_verdict'), { x: 1 }), /unknown argument "x"/)
    assert.match(validateArgs(schema('status'), []), /must be an object/)
  })
})

describe('undelivered and missing jobs', () => {
  const attested = async (p, name, args = {}, opts = {}) => {
    const id = `toolu_${Math.random().toString(16).slice(2)}`
    await writeAttestation(layouts(p).g.att, { tool_use_id: id, tool_name: `mcp__plugin_cc-rsi_rsi__${name}`, session_id: p.sid, cwd: p.repo })
    const r = await callTool(name, args, { meta: { 'claudecode/toolUseId': id }, env: p.env, ...opts })
    return { ...r, text: r.content[0].text }
  }
  const finished = async p => until(() => jobsOf(p).every(j => j.status === 'done' || j.status === 'infra') && jobsOf(p).length > 0, { what: 'the job' })

  it('the next submit delivers a still-current undelivered verdict instead of inspecting again; a stale one is superseded', async () => {
    const p = await setupProject({ script: { verifier: { turns: [{ actions: [{ tool: 'Bash', command: 'sleep 1' }], text: 'First.\nVERDICT: PASS' }, { actions: [{ tool: 'Bash', command: 'ls' }], text: 'Second.\nVERDICT: FAIL' }], default: { actions: [{ tool: 'Bash', command: 'ls' }], text: 'Third.\nVERDICT: PASS' } } } })
    homes.push(p.home)
    await hook('session-start', fixture('session-start', p), p.env)
    await hook('prompt', fixture('user-prompt-submit', p), p.env)
    const running = await attested(p, 'submit', {}, { waitMs: 1 })
    assert.match(running.text, /^VERIFICATION RUNNING \(job /)
    await finished(p)
    const delivered = await attested(p, 'submit')
    assert.match(delivered.text, /^cc-rsi · Verifier: VERDICT: PASS \(generation 1/)
    assert.equal(jobsOf(p).length, 1, 'no second inspection')
    // Undelivered and stale: a new inspection (generation 2) supersedes it.
    p.write('README.md', '# changed\n')
    const again = await attested(p, 'submit', {}, { waitMs: 1 })
    assert.match(again.text, /^VERIFICATION RUNNING/)
    await finished(p)
    p.write('README.md', '# changed twice\n')
    const third = await attested(p, 'submit')
    assert.match(third.text, /generation 3/)
    assert.equal(jobsOf(p).length, 3)
  })

  it('a task job without a job record is released with job_missing', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    await hook('prompt', fixture('user-prompt-submit', p), p.env)
    await withTask(layouts(p).sl, s => { s.job = { id: 'j-20260101000000-0f0f0f', pid: null, taskSeq: 1, gen: 1 } })
    const r = await attested(p, 'wait_verdict')
    assert.equal(r.isError, true)
    assert.match(r.text, /\(job_missing\)/)
    assert.equal(taskState(p).job, null)
    assert.match((await attested(p, 'wait_verdict')).text, /^No verification is pending/)
  })
})

describe('wait budget and lock waits (cc-integration-8)', () => {
  it('a busy memory store and slow pre-wait work never push submit past the auto-background threshold', async () => {
    const p = await setupProject({ script: { verifier: { default: { hangMs: 20000, actions: [{ tool: 'Bash', command: 'ls' }], text: 'VERDICT: PASS' } } } })
    homes.push(p.home)
    await hook('session-start', fixture('session-start', p), p.env)
    await hook('prompt', fixture('user-prompt-submit', p), p.env)
    // Another writer (a lineage commit, another session learning) holds the store's mutation lock.
    const holder = new LeaseLock(join(layouts(p).pl.store, '.lock'), { leaseMs: 60000, heartbeatMs: 1000 })
    mkdirSync(layouts(p).pl.store, { recursive: true })
    assert.ok(await holder.acquire({ wait: false }))
    try {
      const env = { ...p.env, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '25000' }
      const id = 'toolu_budget1'
      await writeAttestation(layouts(p).g.att, { tool_use_id: id, tool_name: 'mcp__plugin_cc-rsi_rsi__submit', session_id: p.sid, cwd: p.repo })
      // The call already spent 2 s before it reached the tool (attestation, queueing).
      const receivedAt = Date.now() - 2000
      const r = await callTool('submit', {}, { meta: { 'claudecode/toolUseId': id }, env, receivedAt })
      const total = Date.now() - receivedAt
      assert.match(r.content[0].text, /^VERIFICATION RUNNING/)
      assert.ok(total < 15000, `the call returned ${total} ms after it arrived (threshold 25 s − 10 s)`)
    } finally {
      await holder.release()
    }
  })
})

describe('memory integrity without the lock (memory-crash-10)', () => {
  it('an install in flight is not tamper; a mismatch is read again before it is reported', async () => {
    const p = await setupProject()
    homes.push(p.home)
    await hook('session-start', fixture('session-start', p), p.env)
    const { pl } = layouts(p)
    const store = await MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
    // The tree is already swapped in, the journal still lags, the pending marker names the new tree.
    writeFileSync(join(store.memoryDir, 'installed.md'), 'new lesson\n')
    const installed = await store.treeHash()
    await writeJsonAtomic(join(store.root, 'commit.pending.json'), { v: 1, record: { episode: 'e-inflight', treeAfter: installed } })
    const r = await callTool('status', {}, { meta: {}, env: { ...p.env, CLAUDE_CODE_SESSION_ID: p.sid } })
    assert.match(r.content[0].text.split('\n')[1], /\(intact\)/)
    // Without the marker it is tamper.
    const { rm } = await import('node:fs/promises')
    await rm(join(store.root, 'commit.pending.json'))
    const t = await callTool('status', {}, { meta: {}, env: { ...p.env, CLAUDE_CODE_SESSION_ID: p.sid } })
    assert.match(t.content[0].text.split('\n')[1], /CHANGED OUTSIDE A COMMIT/)
    // A transient scan failure (a scan between the two renames of an install) is read again.
    let calls = 0
    const stub = { root: store.root, treeHash: async () => { calls++; if (calls === 1) throw new Error('ENOENT'); return 'e' }, expectedTreeHash: async () => 'e' }
    assert.equal((await memoryIntegrity(stub, { retryMs: 5 })).intact, true)
    assert.equal(calls, 2)
  })
})

describe('honest infra results and the learning way out', () => {
  const attested = async (p, name, args = {}) => {
    const id = `toolu_${Math.random().toString(16).slice(2)}`
    await writeAttestation(layouts(p).g.att, { tool_use_id: id, tool_name: `mcp__plugin_cc-rsi_rsi__${name}`, session_id: p.sid, cwd: p.repo })
    const r = await callTool(name, args, { meta: { 'claudecode/toolUseId': id }, env: p.env })
    return { ...r, text: r.content[0].text }
  }

  it('an infra job whose changes were not rolled back lists them (memory-crash-7)', async () => {
    const p = await setupProject()
    homes.push(p.home)
    await hook('session-start', fixture('session-start', p), p.env)
    await hook('prompt', fixture('user-prompt-submit', p), p.env)
    const { sl } = layouts(p)
    const id = 'j-20260101000000-abcdef'
    await writeJsonAtomic(join(sl.jobs, `${id}.json`), {
      v: 1, id, status: 'infra', sessionId: p.sid, taskSeq: 1, generation: 1, candidateRoot: p.repo, createdAt: new Date().toISOString(), delivered: false,
      infra: { cls: 'cancelled', detail: 'the verification was cancelled; this is not a verdict; the workspace was too large to checkpoint, so 1 path(s) changed during the inspection were NOT rolled back: src/app.txt', notRestored: ['src/app.txt'] },
    })
    const r = await attested(p, 'wait_verdict')
    assert.equal(r.isError, true)
    assert.match(r.text, /^INFRASTRUCTURE: .*\(cancelled\)/)
    assert.doesNotMatch(r.text, /candidate was restored/)
    assert.match(r.text, /HARNESS NOTE: 1 path\(s\) changed during the inspection; the workspace was too large to checkpoint, so inspect them: src\/app\.txt/)
  })

  it('memory_commit without a code abandons; every learning refusal names learn as the way back to the code (cc-integration-5)', async () => {
    const p = await setupProject()
    homes.push(p.home)
    await hook('session-start', fixture('session-start', p), p.env)
    await hook('prompt', fixture('user-prompt-submit', p), p.env)
    await withTask(layouts(p).sl, s => {
      s.learning = { episode: 'ep-x', taskSeq: 1, gen: 1, verdict: 'PASS', stage: 'distill', code: 'a1b2c3', draftDir: join(p.home, 'draft-x') }
    })
    const none = await attested(p, 'memory_commit', {})
    assert.equal(none.isError, true)
    assert.match(none.text, /needs confirm .* or abandon:true/)
    assert.match(none.text, /Call learn to re-show the current stage message/)
    const bad = await attested(p, 'memory_commit', { confirm: 'ffffff' })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /[Cc]all learn to re-show/)
    const submit = await attested(p, 'submit')
    assert.equal(submit.isError, true)
    assert.match(submit.text, /[Cc]all learn to re-show/)
    const abandoned = await attested(p, 'memory_commit', { abandon: true })
    assert.equal(abandoned.isError, undefined, abandoned.text)
    assert.match(abandoned.text, /abandoned/)
    assert.equal(taskState(p).learning, null)
  })
})

describe('callTool binding', () => {
  it('an attestation for another tool or without a session is not an attestation', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    const att = layouts(p).g.att
    await writeAttestation(att, { tool_use_id: 'toolu_a', tool_name: 'mcp__plugin_cc-rsi_rsi__status', session_id: p.sid, cwd: p.repo })
    const wrongTool = await callTool('learn', {}, { meta: { 'claudecode/toolUseId': 'toolu_a' }, env: p.env })
    assert.match(wrongTool.content[0].text, /cannot attest this call/)
    await writeAttestation(att, { tool_use_id: 'toolu_b', tool_name: 'mcp__plugin_cc-rsi_rsi__learn', cwd: p.repo })
    const noSession = await callTool('learn', {}, { meta: { 'claudecode/toolUseId': 'toolu_b' }, env: p.env })
    assert.match(noSession.content[0].text, /cannot attest this call/)
    await writeAttestation(att, { tool_use_id: 'toolu_c', tool_name: 'mcp__plugin_cc-rsi_rsi__wait_verdict', session_id: p.sid, cwd: p.repo, agent_id: 'abc' })
    const sub = await callTool('wait_verdict', {}, { meta: { 'claudecode/toolUseId': 'toolu_c' }, env: p.env })
    assert.equal(sub.isError, true)
    assert.match(sub.content[0].text, /reserved for the main Actor conversation/)
    await writeAttestation(att, { tool_use_id: 'toolu_d', tool_name: 'mcp__plugin_cc-rsi_rsi__wait_verdict', session_id: p.sid, cwd: p.repo })
    const ok = await callTool('wait_verdict', {}, { meta: { 'claudecode/toolUseId': 'toolu_d' }, env: p.env })
    assert.equal(ok.content[0].text, 'No verification is pending. Last verdict: none.')
  })

  it('status falls back to CLAUDE_CODE_SESSION_ID when unattested and prints the SPEC §11.12 shape', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    await hook('prompt', fixture('user-prompt-submit', p), p.env)
    const r = await callTool('status', {}, { meta: {}, env: { ...p.env, CLAUDE_CODE_SESSION_ID: p.sid } })
    const lines = r.content[0].text.split('\n')
    assert.match(lines[0], new RegExp(`^cc-rsi status — session ${p.sid.slice(0, 8)}, project cc-rsi-repo-`))
    assert.match(lines[1], /^mode: learn \| memory: 0 files, 0 KiB, tree 44136fa355b3 \(intact\) \| frozen: no \| sealed: no$/)
    assert.equal(lines[2], 'task 1: generation 0; last verdict none')
    assert.equal(lines[3], 'verification: none')
    assert.equal(lines[4], 'learning: none')
    assert.match(lines[5], /^isolation: Verifier (rollback|sandbox) \(.+\) \| Verifier model: test-verifier-model \(config\)$/)
    assert.equal(lines[6], 'lineages: none')
    assert.equal(lines[7], 'sealed evaluations: 0 recorded (scores are shown only in a terminal: cc-rsi eval show)')
    const none = await callTool('status', {}, { meta: {}, env: { ...p.env, CLAUDE_CODE_SESSION_ID: 'unknown-session' } })
    assert.match(none.content[0].text, /no session state was found/)
  })

  it('interactive.enabled = false refuses every tool with a pointer', async () => {
    const p = await setupProject()
    writeFileSync(join(p.home, 'config.json'), JSON.stringify({ interactive: { enabled: false } }))
    await hook('session-start', fixture('session-start', p), p.env)
    await writeAttestation(layouts(p).g.att, { tool_use_id: 'toolu_e', tool_name: 'mcp__plugin_cc-rsi_rsi__submit', session_id: p.sid, cwd: p.repo })
    const r = await callTool('submit', {}, { meta: { 'claudecode/toolUseId': 'toolu_e' }, env: p.env })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /interactive mode is disabled/)
  })
})

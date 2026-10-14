// SPEC §15.3 WP5 hooks: attest file contents + role deny, CC_RSI_ROLE no-op, malformed stdin exits 0,
// PostModelSwitch, SessionEnd, the async rewake hook, and the exact hooks.json / .mcp.json.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { writeJsonAtomic } from '../../lib/core/atomic.mjs'
import { run as rewakeRun, wakeClaimPath } from '../../lib/hooks/rewake.mjs'
import { resolveVerifierModel, transcriptModelSync } from '../../lib/interactive/session.mjs'
import { ROOT, deadPid, fixture, hook, layouts, setupProject } from '../interactive/harness.mjs'

const SUBS = ['session-start', 'prompt', 'guard', 'attest', 'rewake', 'schedule', 'stop', 'model', 'session-end']

describe('attest hook', () => {
  it('writes one 0600 attestation per tool_use_id with the caller identity', async () => {
    const p = await setupProject()
    const payload = fixture('pre-tool-use-mcp', p, { extra: { agent_id: 'a1b2', agent_type: 'Explore' } })
    const r = await hook('attest', payload, p.env)
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
    const file = join(layouts(p).g.att, `${payload.tool_use_id}.json`)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(record).sort(), ['agent_id', 'agent_type', 'cwd', 'permission_mode', 'prompt_id', 'session_id', 'tool_name', 'tool_use_id', 'transcript_path', 'ts', 'v'])
    assert.equal(record.session_id, p.sid)
    assert.equal(record.tool_name, 'mcp__plugin_cc-rsi_rsi__submit')
    assert.equal(record.agent_id, 'a1b2')
    assert.equal(record.cwd, p.repo)
  })

  it('fills the session model from the transcript first, so an inheriting Verifier gets the session model (cc-integration-3)', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    const { sl } = layouts(p)
    assert.equal(JSON.parse(readFileSync(sl.sessionJson, 'utf8')).model, null, 'the 2.1.296 SessionStart payload has no model')
    const transcript = join(p.home, 'transcript.jsonl')
    writeFileSync(transcript, `${'x'.repeat(300 * 1024)}\n${JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [] } })}\n${JSON.stringify({ type: 'user', message: { content: 'go' } })}\n`)
    const r = await hook('attest', fixture('pre-tool-use-mcp', p), p.env)
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
    const session = JSON.parse(readFileSync(sl.sessionJson, 'utf8'))
    assert.equal(session.model, 'claude-haiku-5-5')
    assert.equal(session.modelSource, 'transcript')
    const resolved = resolveVerifierModel({ models: { verifier: '' } }, session, { HOME: p.home })
    assert.deepEqual(resolved, { model: 'claude-haiku-5-5', source: 'session' })
    // A missing transcript yields no model.
    assert.equal(transcriptModelSync(join(p.home, 'missing.jsonl')), null)
  })

  it('denies inside a role context and writes nothing for unusable ids', async () => {
    const p = await setupProject()
    const role = await hook('attest', fixture('pre-tool-use-mcp', p), { ...p.env, CC_RSI_ROLE: 'verifier' })
    assert.equal(role.code, 0)
    assert.deepEqual(role.json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'cc-rsi tools are not available inside role contexts' } })
    const roleMalformed = await hook('attest', 'not json', { ...p.env, CC_RSI_ROLE: 'actor' })
    assert.equal(roleMalformed.json.hookSpecificOutput.permissionDecision, 'deny')
    for (const id of [undefined, '../escape', '']) {
      const r = await hook('attest', fixture('pre-tool-use-mcp', p, { extra: { tool_use_id: id } }), p.env)
      assert.equal(r.code, 0)
      assert.equal(r.stdout, '')
    }
    assert.equal(existsSync(layouts(p).g.att) ? readdirSync(layouts(p).g.att).length : 0, 0)
  })
})

describe('dispatcher rules', () => {
  it('every sub is a silent no-op inside a role child (except attest) and with malformed stdin', async () => {
    const p = await setupProject()
    for (const sub of SUBS) {
      const payload = sub === 'stop' ? fixture('stop', p) : fixture('pre-tool-use', p)
      const role = await hook(sub, payload, { ...p.env, CC_RSI_ROLE: 'actor' })
      assert.equal(role.code, 0, sub)
      if (sub !== 'attest') assert.equal(role.stdout, '', sub)
      for (const bad of ['', '{', '[1,2]', 'null', '"text"']) {
        const r = await hook(sub, bad, p.env)
        assert.equal(r.code, 0, `${sub} ${bad}`)
        assert.equal(r.stdout, '', `${sub} ${bad}`)
      }
    }
    const unknown = await hook('nope', fixture('pre-tool-use', p), p.env)
    assert.equal(unknown.code, 0)
    assert.equal(unknown.stdout, '')
    assert.equal(existsSync(join(p.home, 'projects')), false, 'role children and malformed payloads leave no state')
  })

  it('PostModelSwitch records the new model; SessionEnd marks the session ended', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    const m = await hook('model', fixture('post-model-switch', p), p.env)
    assert.equal(m.code, 0)
    const { sl } = layouts(p)
    let session = JSON.parse(readFileSync(sl.sessionJson, 'utf8'))
    assert.equal(session.model, 'claude-opus-5')
    assert.equal(session.modelSource, 'model-switch')
    const t0 = Date.now()
    const e = await hook('session-end', fixture('session-end', p), p.env)
    assert.equal(e.code, 0)
    assert.ok(Date.now() - t0 < 1500)
    session = JSON.parse(readFileSync(sl.sessionJson, 'utf8'))
    assert.match(session.endedAt, /^\d{4}-\d\d-\d\dT/)
    assert.equal(session.endReason, 'other')
    // A session that never started is left alone.
    const other = await hook('session-end', { ...fixture('session-end', p), session_id: 'never-started' }, p.env)
    assert.equal(other.code, 0)
  })
})

describe('rewake hook', () => {
  async function jobFixture(p, patch) {
    await hook('session-start', fixture('session-start', p), p.env)
    const { sl } = layouts(p)
    const id = 'j-20260101000000-abcdef'
    mkdirSync(sl.jobs, { recursive: true })
    const job = { v: 1, id, status: 'running', sessionId: p.sid, generation: 2, pid: process.pid, createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), delivered: false, ...patch }
    await writeJsonAtomic(join(sl.jobs, `${id}.json`), job)
    return { id, path: join(sl.jobs, `${id}.json`), job }
  }
  const running = id => `VERIFICATION RUNNING (job ${id}, generation 2): the independent Verifier has been inspecting for 100 s.`
  const opts = { pollMs: 20, maxMs: 5000, graceMs: 20 }

  it('exits 2 with the verdict line when the job finishes undelivered', async () => {
    const p = await setupProject()
    const { id, path, job } = await jobFixture(p, {})
    setTimeout(() => { writeJsonAtomic(path, { ...job, status: 'done', result: { verdict: 'FAIL' } }) }, 100)
    const r = await rewakeRun(fixture('post-tool-use-mcp', p, { text: running(id) }), { env: p.env, ...opts })
    assert.equal(r.exitCode, 2)
    assert.equal(r.stderr, `cc-rsi: the independent verification (job ${id}) finished — VERDICT: FAIL (generation 2). Call wait_verdict to receive the report and guidance.`)
  })

  it('stays silent when the verdict was delivered, and reports infra and dead jobs', async () => {
    const p = await setupProject()
    const { id, path, job } = await jobFixture(p, { status: 'done', result: { verdict: 'PASS' }, delivered: true })
    const payload = fixture('post-tool-use-mcp', p, { text: running(id) })
    assert.deepEqual(await rewakeRun(payload, { env: p.env, ...opts }), {})
    await writeJsonAtomic(path, { ...job, status: 'infra', delivered: false, infra: { cls: 'timeout' } })
    const infra = await rewakeRun(payload, { env: p.env, ...opts })
    assert.equal(infra.exitCode, 2)
    assert.match(infra.stderr, /finished without a verdict \(infrastructure\)\. Call wait_verdict for details\.$/)
    assert.deepEqual(await rewakeRun(payload, { env: p.env, ...opts }), {}, 'one wake per job')
    rmSync(wakeClaimPath(path))
    await writeJsonAtomic(path, { ...job, status: 'running', pid: deadPid(), delivered: false })
    const dead = await rewakeRun(payload, { env: p.env, ...opts })
    assert.equal(dead.exitCode, 2)
    rmSync(wakeClaimPath(path))
    // Unrelated tool responses and the disabled option never wait.
    assert.deepEqual(await rewakeRun(fixture('post-tool-use-mcp', p, { text: 'cc-rsi · Verifier: VERDICT: PASS' }), { env: p.env, ...opts }), {})
    const disabledEnv = { ...p.env }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(p.home, 'config.json'), JSON.stringify({ interactive: { rewake: false } }))
    await writeJsonAtomic(path, { ...job, status: 'done', result: { verdict: 'PASS' }, delivered: false })
    assert.deepEqual(await rewakeRun(payload, { env: disabledEnv, ...opts }), {})
  })

  it('several pollers of one job wake the session once', async () => {
    const p = await setupProject()
    const { id, path, job } = await jobFixture(p, {})
    const payload = fixture('post-tool-use-mcp', p, { text: running(id) })
    // submit → RUNNING, wait_verdict → RUNNING, wait_verdict → RUNNING: three pollers, then the turn ends.
    const pollers = [1, 2, 3].map(() => rewakeRun(payload, { env: p.env, ...opts }))
    setTimeout(() => { writeJsonAtomic(path, { ...job, status: 'done', result: { verdict: 'PASS' } }) }, 100)
    const results = await Promise.all(pollers)
    assert.equal(results.filter(r => r.exitCode === 2).length, 1, JSON.stringify(results))
    assert.equal(results.filter(r => r.exitCode === undefined && r.stderr === undefined).length, 2)
    assert.ok(existsSync(wakeClaimPath(path)))
    // A late poller (another wait_verdict that answered RUNNING before the end) stays silent too.
    assert.deepEqual(await rewakeRun(payload, { env: p.env, ...opts }), {})
  })

  it('through the dispatcher: exit code 2 and the stderr line', async () => {
    const p = await setupProject()
    const { id } = await jobFixture(p, { status: 'infra', infra: { cls: 'auth' } })
    const r = await hook('rewake', fixture('post-tool-use-mcp', p, { text: running(id) }), p.env)
    assert.equal(r.code, 2)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^cc-rsi: the independent verification \(job j-20260101000000-abcdef\) finished without a verdict \(infrastructure\)/)
  })
})

describe('plugin wiring files', () => {
  it('hooks/hooks.json is exactly the SPEC §11.7 content', () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
    const cmd = (sub, timeout, extra = {}) => ({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs', sub], timeout, ...extra })
    assert.deepEqual(hooks, {
      description: 'cc-rsi: RSI protocol for the main (Actor) session — protocol context, verbatim request capture, private-path guard, verification lock, MCP attestation, scheduled-prompt ledger, verdict wake-up, stop policy',
      hooks: {
        SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [cmd('session-start', 20)] }],
        UserPromptSubmit: [{ hooks: [cmd('prompt', 15)] }],
        PreToolUse: [
          { matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|PowerShell|Monitor', hooks: [cmd('guard', 10)] },
          { matcher: '^mcp__plugin_cc-rsi_rsi__', hooks: [cmd('attest', 10)] },
        ],
        PostToolUse: [
          { matcher: '^mcp__plugin_cc-rsi_rsi__(submit|wait_verdict)$', hooks: [cmd('rewake', 7200, { asyncRewake: true })] },
          // The scheduled-prompt ledger is written after a scheduling call succeeded (r2-overblock-3).
          { matcher: 'CronCreate|ScheduleWakeup|RemoteTrigger|CronDelete', hooks: [cmd('schedule', 10)] },
        ],
        Stop: [{ hooks: [cmd('stop', 15)] }],
        PostModelSwitch: [{ hooks: [cmd('model', 10)] }],
        SessionEnd: [{ hooks: [cmd('session-end', 1)] }],
      },
    })
    // The first PreToolUse matcher and the ledger matcher are exact lists; no hook declares onFailure (main-session hooks fail open).
    assert.match(hooks.hooks.PreToolUse[0].matcher, /^[A-Za-z0-9_\- ,|]+$/)
    assert.match(hooks.hooks.PostToolUse[1].matcher, /^[A-Za-z0-9_\- ,|]+$/)
    assert.ok(!JSON.stringify(hooks).includes('onFailure'))
    assert.ok(!JSON.stringify(hooks).includes('user_config'))
  })

  it('.mcp.json is exactly the SPEC §11.11 content', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')), {
      mcpServers: {
        rsi: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'],
          timeout: 600000,
          alwaysLoad: true,
          env: {
            CC_RSI_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}',
            CC_RSI_OPT_VERIFIER_MODEL: '${user_config.verifier_model}',
            CC_RSI_OPT_STOP_POLICY: '${user_config.stop_policy}',
            CC_RSI_OPT_SANDBOX: '${user_config.sandbox}',
          },
        },
      },
    })
  })
})

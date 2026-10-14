// SPEC §15.3 WP5 hooks: SessionStart JSON shape, ≤ 9000 chars, systemMessage content, shim, the
// compact task pin, session.json + index, read-only view, notices, dead-job recovery.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { writeJsonAtomic } from '../../lib/core/atomic.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'
import { MCP_OPT_PREFIX, effectiveConfig, pluginCodeFingerprint, sessionContext } from '../../lib/interactive/session.mjs'
import { callTool } from '../../lib/mcp/tools.mjs'
import { ROOT, deadPid, fixture, hook, layouts, setupProject, taskState, until } from '../interactive/harness.mjs'

async function seedMemory(p, files) {
  const { pl } = layouts(p)
  const store = await MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
  const dir = join(pl.drafts, 'seed')
  await store.openDraft('seed-episode', { dir, owner: { kind: 'engine', pid: process.pid } })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  await store.commit('seed-episode', { kind: 'practice', outcome: 'PASS' })
  return store
}

describe('SessionStart hook', () => {
  it('injects the protocol and the memory preamble (≤ 9000 chars) and records the session', async () => {
    const p = await setupProject()
    // Claude Code exports CLAUDE_PLUGIN_ROOT to plugin hooks; the shim refresh needs it.
    const r = await hook('session-start', fixture('session-start', p), { ...p.env, CLAUDE_PLUGIN_ROOT: ROOT })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stderr, '')
    assert.deepEqual(Object.keys(r.json).sort(), ['hookSpecificOutput', 'systemMessage'])
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart')
    const C = r.json.hookSpecificOutput.additionalContext
    assert.ok(C.length <= 9000, `${C.length} chars`)
    assert.match(C, /^## Recursive self-improvement protocol \(cc-rsi\)/)
    const { sl, g } = layouts(p)
    assert.ok(C.includes(`Your durable memory is a read-only directory: ${sl.viewDir}`))
    assert.match(C, /Current durable-memory inventory: empty \(0 files\)\./)
    // The session model is unknown at startup (no model in the 2.1.296 payload): no false warning.
    assert.match(r.json.systemMessage, /^cc-rsi: Verifier isolation = (rollback|sandbox) \(.+\); Verifier model = inherit \(session model not yet known\); memory 0 files \(learn\)$/)
    const session = JSON.parse(readFileSync(sl.sessionJson, 'utf8'))
    assert.equal(session.sessionId, p.sid)
    assert.equal(session.source, 'startup')
    assert.equal(session.projectRoot, p.repo)
    assert.equal(session.endedAt, null)
    const index = JSON.parse(readFileSync(join(g.runSessions, `${p.sid}.json`), 'utf8'))
    assert.equal(index.projectRoot, p.repo)
    assert.equal(readFileSync(join(p.home, '.gitignore'), 'utf8'), '*\n')
    // The read-only view exists.
    assert.equal(statSync(sl.viewDir).mode & 0o777, 0o555)
    const shimModule = existsSync(join(ROOT, 'lib', 'cli', 'shim.mjs'))
    if (shimModule) assert.ok(existsSync(join(p.home, 'bin', 'cc-rsi')), 'the shim is written when lib/cli/shim.mjs exists')
  })

  it('uses the configured Verifier model and the payload model; no warning when they differ', async () => {
    const p = await setupProject()
    const env = { ...p.env, CLAUDE_PLUGIN_OPTION_VERIFIER_MODEL: 'opus' }
    const r = await hook('session-start', fixture('session-start', p, { extra: { model: 'claude-sonnet-4-6' } }), env)
    assert.match(r.json.systemMessage, /Verifier model = opus; memory 0 files \(learn\)$/)
    const session = JSON.parse(readFileSync(layouts(p).sl.sessionJson, 'utf8'))
    assert.equal(session.model, 'claude-sonnet-4-6')
    assert.equal(session.modelSource, 'session-start')
    assert.deepEqual(session.pluginOptions, { verifier_model: 'opus' }, 'the saved options the hooks see')
    // Two known, equal models still warn.
    const same = await hook('session-start', fixture('session-start', p, { extra: { model: 'opus' } }), env)
    assert.match(same.json.systemMessage, /Verifier model = opus; memory 0 files \(learn\); WARNING: Verifier model equals the session model$/)
  })

  it('records the plugin code fingerprint once per session (security-4)', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    const { sl } = layouts(p)
    const first = JSON.parse(readFileSync(sl.sessionJson, 'utf8'))
    assert.match(first.pluginFingerprint, /^[0-9a-f]{64}$/)
    assert.equal(first.pluginFingerprint, pluginCodeFingerprint(ROOT))
    assert.equal(first.codeRoot, ROOT)
    // A compaction keeps the baseline (an edit made meanwhile must not be re-baselined).
    await writeJsonAtomic(sl.sessionJson, { ...first, pluginFingerprint: 'f'.repeat(64) })
    await hook('session-start', fixture('session-start', p, { extra: { source: 'compact' } }), p.env)
    assert.equal(JSON.parse(readFileSync(sl.sessionJson, 'utf8')).pluginFingerprint, 'f'.repeat(64))
    // The fingerprint covers code, hooks, bin, the MCP entry and the role prompts.
    const tree = await tmpDir('cc-rsi-plugin-tree-')
    for (const rel of ['lib/interactive/verify-job.mjs', 'hooks/role-guard.mjs', 'bin/cc-rsi', 'mcp/server.mjs', 'prompts/verifier-system.md', 'README.md']) {
      mkdirSync(join(tree, rel, '..'), { recursive: true })
      writeFileSync(join(tree, rel), 'v1\n')
    }
    const base = pluginCodeFingerprint(tree)
    writeFileSync(join(tree, 'README.md'), 'docs only\n')
    assert.equal(pluginCodeFingerprint(tree), base)
    for (const rel of ['lib/interactive/verify-job.mjs', 'hooks/role-guard.mjs', 'prompts/verifier-system.md']) {
      writeFileSync(join(tree, rel), 'tampered\n')
      assert.notEqual(pluginCodeFingerprint(tree), base, rel)
      writeFileSync(join(tree, rel), 'v1\n')
    }
    assert.equal(pluginCodeFingerprint(tree), base)
  })

  it('the MCP server applies the options the hooks see, not the substituted manifest defaults', async () => {
    const p = await setupProject({ config: { isolation: { sandbox: 'require' }, interactive: { stopPolicy: 'gate' } } })
    const r = await hook('session-start', fixture('session-start', p), p.env)
    const banner = /^cc-rsi: Verifier isolation = (\w+) /.exec(r.json.systemMessage)[1]
    const { sl } = layouts(p)
    assert.deepEqual(JSON.parse(readFileSync(sl.sessionJson, 'utf8')).pluginOptions, {}, 'no option was saved')
    // Claude Code substitutes the manifest defaults of unsaved options into the server's env.
    const mcpEnv = { ...p.env, CC_RSI_OPT_SANDBOX: 'auto', CC_RSI_OPT_STOP_POLICY: 'nudge', CC_RSI_OPT_VERIFIER_MODEL: '' }
    const ctx = await sessionContext({ payload: { session_id: p.sid, cwd: p.repo }, env: mcpEnv, optPrefix: MCP_OPT_PREFIX, create: false })
    assert.equal(ctx.config.isolation.sandbox, 'require')
    assert.equal(ctx.config.interactive.stopPolicy, 'gate')
    assert.equal(effectiveConfig({ home: p.home, projectRoot: p.repo, env: mcpEnv, optPrefix: MCP_OPT_PREFIX, session: ctx.session }).config.isolation.sandbox, 'require')
    // The status tool (unattested: the spawn-time session) reports what the SessionStart banner said.
    const status = await callTool('status', {}, { env: { ...mcpEnv, CLAUDE_CODE_SESSION_ID: p.sid } })
    const line = status.content[0].text.split('\n').find(l => l.startsWith('isolation: '))
    assert.match(line, new RegExp(`^isolation: Verifier ${banner} \\(`))
    // An option the user saved reaches both sides; a non-default env value the record lacks still counts.
    const saved = { ...p.env, CLAUDE_PLUGIN_OPTION_SANDBOX: 'off' }
    await hook('session-start', fixture('session-start', p, { extra: { source: 'resume' } }), saved)
    const again = await sessionContext({ payload: { session_id: p.sid, cwd: p.repo }, env: { ...mcpEnv, CC_RSI_OPT_SANDBOX: 'off', CC_RSI_OPT_VERIFIER_MODEL: 'test-verifier-model' }, optPrefix: MCP_OPT_PREFIX, create: false })
    assert.equal(again.config.isolation.sandbox, 'off')
    assert.equal(again.config.models.verifier, 'test-verifier-model')
    assert.equal(again.config.interactive.stopPolicy, 'gate')
  })

  it('lists memory files, warns about tamper, frozen mode, and live lineages', async () => {
    const p = await setupProject()
    const store = await seedMemory(p, { 'lessons/first.md': 'one\n', 'INDEX.md': 'index\n' })
    writeFileSync(join(store.memoryDir, 'forged.md'), 'outside a commit\n')
    const { pl } = layouts(p)
    mkdirSync(join(pl.lineages, 'deep-20261013120000'), { recursive: true })
    await writeJsonAtomic(join(pl.lineages, 'deep-20261013120000', 'state.json'), { v: 1, id: 'deep-20261013120000', phase: 'deep', status: 'paused_infra', wave: null, projectsDone: 2, targetCycles: 1 })
    mkdirSync(join(pl.lineages, 'broad-1'), { recursive: true })
    await writeJsonAtomic(join(pl.lineages, 'broad-1', 'state.json'), { v: 1, id: 'broad-1', phase: 'broad', status: 'completed' })
    const r = await hook('session-start', fixture('session-start', p), p.env)
    const C = r.json.hookSpecificOutput.additionalContext
    // The view and its listing show committed memory only; the forged file never reaches the Actor.
    assert.match(C, /Current durable-memory inventory \(2 files\):/)
    assert.match(C, / {2}\d+ {2}lessons\/first\.md/)
    assert.ok(!C.includes('forged.md'))
    assert.equal(existsSync(join(layouts(p).sl.viewDir, 'forged.md')), false)
    assert.ok(existsSync(join(layouts(p).sl.viewDir, 'lessons', 'first.md')))
    assert.match(C, /Canonical memory changed outside a commit/)
    assert.match(C, /deep-20261013120000 deep paused_infra \(2 projects, 1 target cycles\)/)
    assert.ok(!C.includes('broad-1'), 'terminal lineages are not listed')
    assert.match(r.json.systemMessage, /memory 2 files \(learn\).*; WARNING: memory changed outside a commit \(cc-rsi memory verify\)$/)
    await store.acceptExternal({ by: 'test' })
    await store.freeze({ by: 'test' })
    const frozen = await hook('session-start', fixture('session-start', p, { extra: { source: 'resume' } }), p.env)
    assert.match(frozen.json.systemMessage, /memory 3 files \(frozen\)/)
    assert.ok(!frozen.json.systemMessage.includes('WARNING: memory changed'))
  })

  it('on compact: no systemMessage; the verbatim task pin and the fold revisit are re-injected', async () => {
    const p = await setupProject()
    await seedMemory(p, { 'a.md': 'x\n' })
    await hook('session-start', fixture('session-start', p), p.env)
    await hook('prompt', fixture('user-prompt-submit', p, { extra: { prompt: 'Refactor the parser\nKeep the API stable' } }), p.env)
    const r = await hook('session-start', fixture('session-start', p, { extra: { source: 'compact' } }), p.env)
    assert.equal(r.json.systemMessage, undefined)
    const C = r.json.hookSpecificOutput.additionalContext
    assert.match(C, /TASK \(verbatim, unchanged — this is the actual goal\):\nRefactor the parser\nKeep the API stable/)
    assert.ok(C.includes(layouts(p).sl.viewDir))
    assert.ok(C.length <= 9000)
  })

  it('stays within 9000 characters with a large inventory and a long task', async () => {
    const p = await setupProject()
    const files = {}
    for (let i = 0; i < 60; i++) files[`notes/very-long-memory-file-name-number-${String(i).padStart(3, '0')}-with-padding.md`] = `${i}\n`
    await seedMemory(p, files)
    await hook('prompt', fixture('user-prompt-submit', p, { extra: { prompt: 'x'.repeat(20000) } }), p.env)
    for (const source of ['startup', 'compact']) {
      const r = await hook('session-start', fixture('session-start', p, { extra: { source } }), p.env)
      const C = r.json.hookSpecificOutput.additionalContext
      assert.ok(C.length <= 9000, `${source}: ${C.length}`)
      assert.match(C, /more files/)
    }
  })

  it('spawns recovery for a dead running job of this session', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    const { sl } = layouts(p)
    const jobId = 'j-20260101000000-abcdef'
    const dead = deadPid()
    mkdirSync(sl.jobs, { recursive: true })
    await writeJsonAtomic(join(sl.jobs, `${jobId}.json`), {
      v: 1, id: jobId, status: 'running', sessionId: p.sid, projectKey: layouts(p).pl.dir.split('/').pop(), taskSeq: 1, generation: 1, candidateRoot: p.repo,
      home: p.home, verifier: { ctxKey: 'task-1-v1', sessionId: '6f1c0000-0000-4000-8000-000000000000', fresh: true }, config: {}, createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', pid: dead, checkpoint: null, result: null, infra: null, delivered: false,
    })
    const r = await hook('session-start', fixture('session-start', p, { extra: { source: 'resume' } }), p.env)
    assert.equal(r.code, 0)
    const job = await until(() => {
      const j = JSON.parse(readFileSync(join(sl.jobs, `${jobId}.json`), 'utf8'))
      return j.status === 'infra' ? j : null
    }, { what: 'the recovery to finish' })
    assert.equal(job.infra.cls, 'job_died')
    assert.equal(taskState(p)?.job ?? null, null)
  })

  it('recovers a job of another session that died with its checkpoint open (memory-crash-2)', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    const other = layouts(p, '0b0b0b0b-1111-4222-8333-444444444444').sl
    const { g } = layouts(p)
    const jobId = 'j-20260101000000-c0ffee'
    const jobFile = join(other.jobs, `${jobId}.json`)
    const dead = deadPid()
    mkdirSync(other.jobs, { recursive: true })
    await writeJsonAtomic(jobFile, {
      v: 1, id: jobId, status: 'running', sessionId: '0b0b0b0b-1111-4222-8333-444444444444', projectKey: layouts(p).pl.dir.split('/').pop(), taskSeq: 1, generation: 1,
      candidateRoot: p.repo, home: p.home, verifier: { ctxKey: 'task-1-v1', sessionId: '6f1c0000-0000-4000-8000-000000000001', fresh: true }, config: {},
      createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', pid: dead, checkpoint: null, result: null, infra: null, delivered: false,
    })
    const { lockFileFor } = await import('../../lib/interactive/wslock.mjs')
    const { hostname } = await import('node:os')
    const lockFile = lockFileFor(g.locks, p.repo)
    mkdirSync(g.locks, { recursive: true })
    writeFileSync(lockFile, `${JSON.stringify({
      pid: dead, host: hostname(), token: 'x:y', at: '2026-01-01T00:00:00.000Z',
      owner: { root: p.repo, jobId, sessionId: '0b0b0b0b-1111-4222-8333-444444444444', jobFile, restoreFailed: false, checkpointOpen: true },
    })}\n`)
    // This session's SessionStart (not the dead job's own session) starts the recovery.
    const r = await hook('session-start', fixture('session-start', p, { extra: { source: 'resume' } }), p.env)
    assert.equal(r.code, 0)
    const job = await until(() => {
      const j = JSON.parse(readFileSync(jobFile, 'utf8'))
      return j.status === 'infra' ? j : null
    }, { what: 'the recovery of the other session\'s job' })
    assert.equal(job.infra.cls, 'job_died')
    await until(() => !existsSync(lockFile), { what: 'the lock release' })
  })

  it('reminds a compacted or resumed session of an open learning phase and the way back to its code (cc-integration-5)', async () => {
    const p = await setupProject()
    await hook('session-start', fixture('session-start', p), p.env)
    const { sl, pl } = layouts(p)
    const draftDir = join(pl.drafts, 'task-x-1-g1')
    const { withTask } = await import('../../lib/interactive/task.mjs')
    await withTask(sl, s => { s.learning = { episode: 'task-x-1-g1', taskSeq: 1, gen: 1, verdict: 'PASS', stage: 'reconcile', code: 'abcdef', draftDir } })
    for (const source of ['compact', 'resume']) {
      const r = await hook('session-start', fixture('session-start', p, { extra: { source } }), p.env)
      const C = r.json.hookSpecificOutput.additionalContext
      assert.ok(C.includes(`A cc-rsi learning phase is open (stage reconcile, draft ${draftDir}); call learn to see its current instructions and confirmation code, or memory_commit with abandon:true to discard it.`), source)
      assert.ok(!C.includes('abcdef'), 'the code itself is never injected')
    }
    const fresh = await hook('session-start', fixture('session-start', p, { extra: { source: 'startup' } }), p.env)
    assert.ok(!fresh.json.hookSpecificOutput.additionalContext.includes('learning phase is open'))
  })
})

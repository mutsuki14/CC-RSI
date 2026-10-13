// SPEC §10.9 / §15.3 WP4 `context.test.mjs` (fake claude, real hooks/role-guard.mjs): transient 529 then success →
// TRANSPORT_PAUSE + recovery note embedding the message, same session; pauseCeiling → transient_exhausted; watchdog →
// timeout and the child killed; abort → InterruptedError; sandbox_unavailable + degrade → re-run without the sandbox
// block; hooks_not_run when hooks do not run; guard gaps are warn-only; a tool absent from --tools is never a gap;
// plus the R3 recovery inputs, invocation logs, liveness and pin hooks end to end.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../../lib/core/digest.mjs'
import { DEGRADE_NOTE, RoleContext, recoveryNoteFor } from '../../lib/runtime/context.mjs'
import { InfraError, InterruptedError } from '../../lib/runtime/errors.mjs'
import { fakeClaude, scenarioPath, writeScript } from '../_helpers/fake.mjs'
import { tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function setup({ scenario = scenarioPath('ok'), runHooks = true, sandbox } = {}) {
  const { home } = await tmpHome()
  const fake = await fakeClaude({ scenario, home, runHooks, sandbox })
  const cwd = await tmpDir('cc-rsi-ctx-cwd-')
  return { home, fake, cwd }
}

function vspec({ home, fake, cwd }, extra = {}) {
  return {
    key: 'task-1-v1',
    role: 'verifier',
    phase: null,
    cwd,
    addDirs: [],
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    allow: ['Read', 'Grep', 'Glob', 'Bash'],
    deny: ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill'],
    readRoots: [],
    writeRoots: [],
    readOnlyRoots: [cwd],
    hidden: [],
    hiddenTokens: [],
    bashDeny: [],
    sandbox: null,
    sandboxDegrade: 'refuse',
    systemText: 'You are the Verifier (test system text).',
    model: 'test-model',
    effort: null,
    lossless: true,
    pinText: null,
    liveness: false,
    stagnationRevisit: null,
    maxTurns: 50,
    turnTimeoutSec: 60,
    pauseCeilingSecs: 10,
    pauseSecs: 0.01,
    pauseMaxSecs: 0.05,
    killGraceMs: 300,
    watchdogMaxWaitMs: 1800000,
    maxBudgetUsd: null,
    noSessionPersistence: false,
    extraEnv: {},
    logDir: join(home, 'ctx', 'task-1-v1'),
    home,
    pluginRoot: ROOT,
    config: { ...fake.config, transport: { retryWatchdog: true, livenessNotes: true } },
    ...extra,
  }
}

function events() {
  const list = []
  return { list, on: (type, data) => list.push({ type, ...data }) }
}

async function writeScenario(source) {
  const dir = await tmpDir('cc-rsi-scenario-')
  const file = join(dir, 'scenario.mjs')
  writeFileSync(file, source)
  return file
}

test('a reply: Reply fields, invocation logs, registry, --session-id then --resume, child env and settings', async () => {
  const s = await setup({ scenario: scenarioPath('verifier-fail-then-pass') })
  const ev = events()
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env, onRuntimeEvent: ev.on })
  const msg1 = 'Inspect the candidate.\n  (trailing spaces kept)   \n'
  const r1 = await ctx.send(msg1)
  assert.equal(r1.text, 'Inspection 1.\nVERDICT: FAIL')
  assert.equal(r1.actions, 1)
  assert.equal(r1.sessionId, ctx.sessionId)
  assert.equal(r1.invocation, 1)
  assert.equal(r1.truncated, false)
  assert.equal(r1.model, 'test-model')
  assert.equal(r1.guardGaps, 0)
  assert.equal(r1.permissionDenials, 0)
  assert.ok(Math.abs(r1.costUsdTotal - 0.002) < 1e-9)
  assert.ok(Math.abs(r1.costUsdDelta - 0.002) < 1e-9)
  const r2 = await ctx.send('Inspect again.\n')
  assert.equal(r2.text, 'Inspection 2.\nVERDICT: PASS')
  assert.equal(r2.invocation, 2)
  assert.ok(Math.abs(r2.costUsdDelta - 0.002) < 1e-9, 'cost is cumulative per session; the delta is per message')

  const log = s.fake.log()
  assert.deepEqual(log.map(l => l.mode), ['new', 'resume'])
  assert.deepEqual(log.map(l => l.sessionId), [ctx.sessionId, ctx.sessionId])
  assert.equal(log[0].argv[log[0].argv.indexOf('--session-id') + 1], ctx.sessionId)
  assert.equal(log[1].argv[log[1].argv.indexOf('--resume') + 1], ctx.sessionId)
  assert.equal(log[0].stdinSha, sha256Hex(msg1), 'stdin carries the exact message bytes')
  assert.ok(log.every(l => l.allowSeen === false), 'the role guard never answers allow')
  assert.ok(log.every(l => l.hooksRun.some(h => h.event === 'UserPromptSubmit')))
  assert.equal(log[0].ccRsi.CC_RSI_ROLE, 'verifier')
  assert.equal(log[0].ccRsi.CC_RSI_HOME, s.home)
  assert.equal(log[0].ccRsi.CC_RSI_EXPECT, sha256Hex(msg1))
  assert.ok(log[0].envKeys.includes('DISABLE_AUTO_COMPACT'))
  assert.ok(log[0].envKeys.includes('CLAUDE_CODE_RETRY_WATCHDOG'))
  assert.ok(!log[0].envKeys.includes('FAKE_CLAUDE_HOME'), 'test variables do not leak through the allowlist')
  // identical system file bytes for every message of a context
  const sys = l => l.argv[l.argv.indexOf('--append-system-prompt-file') + 1]
  assert.equal(sys(log[0]), sys(log[1]))
  assert.equal(readFileSync(sys(log[0]), 'utf8'), 'You are the Verifier (test system text).')

  const dir1 = join(s.home, 'ctx', 'task-1-v1', '1')
  for (const f of ['prompt.md', 'stream.jsonl', 'stderr.txt', 'guard.jsonl', 'meta.json']) assert.ok(existsSync(join(dir1, f)), f)
  assert.equal(readFileSync(join(dir1, 'prompt.md'), 'utf8'), msg1)
  const meta = JSON.parse(readFileSync(join(dir1, 'meta.json'), 'utf8'))
  assert.equal(meta.cls, 'reply')
  assert.equal(meta.mode, 'new')
  assert.equal(meta.actions, 1)
  assert.equal(meta.exitCode, 0)
  assert.equal(meta.sessionId, ctx.sessionId)
  assert.ok(meta.argv.includes('--restricted'))
  const settings = JSON.parse(readFileSync(meta.settingsFile, 'utf8'))
  assert.equal(settings.permissions.defaultMode, 'dontAsk')
  assert.equal(settings.sandbox, undefined)
  assert.ok(meta.settingsFile.startsWith(join(s.home, 'run', 'settings')))
  assert.ok(meta.policyFile.startsWith(join(s.home, 'run', 'policies')))
  const guard = readFileSync(join(dir1, 'guard.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(guard.some(e => e.hook === 'prompt' && e.decision === 'pass' && e.digest === sha256Hex(msg1)))
  assert.ok(guard.some(e => e.hook === 'tool' && e.tool === 'Bash' && e.decision === 'pass'))
  const reg = JSON.parse(readFileSync(join(s.home, 'ctx', 'task-1-v1', 'sessions', `${ctx.sessionId}.json`), 'utf8'))
  assert.equal(reg.attempted, 2)
  assert.equal(reg.completed, 2)
  assert.deepEqual(ev.list.map(e => e.type), ['ROLE_INVOCATION', 'ROLE_INVOCATION'])
})

test('transient 529 then success: TRANSPORT_PAUSE, a recovery note embedding the message, same session', async () => {
  const s = await setup({ scenario: scenarioPath('transient-once') })
  const ev = events()
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env, onRuntimeEvent: ev.on })
  const reply = await ctx.send('the original charter\n')
  assert.equal(reply.text, 'RECOVERED true')
  const log = s.fake.log()
  assert.deepEqual(log.map(l => [l.mode, l.sessionId, l.exit]), [['new', ctx.sessionId, 1], ['resume', ctx.sessionId, 0]])
  assert.equal(log[1].stdinSha, sha256Hex(recoveryNoteFor('the original charter\n')))
  const prompt2 = readFileSync(join(s.home, 'ctx', 'task-1-v1', '2', 'prompt.md'), 'utf8')
  assert.match(prompt2, /^HARNESS RECOVERY:/)
  assert.ok(prompt2.endsWith('the original charter\n'))
  const pauses = ev.list.filter(e => e.type === 'TRANSPORT_PAUSE')
  assert.equal(pauses.length, 1)
  assert.equal(pauses[0].cls, 'transient')
  assert.equal(pauses[0].status, 529)
  assert.equal(pauses[0].secs, 0.01)
})

test('transient errors beyond the pause ceiling → InfraError(transient_exhausted)', async () => {
  const s = await setup({ scenario: scenarioPath('scripted') })
  writeScript(s.fake, { verifier: { default: { apiError: { status: 529, error: 'overloaded' } } } })
  const ev = events()
  const ctx = new RoleContext(vspec(s, { pauseCeilingSecs: 0.03 }), { parentEnv: s.fake.env, onRuntimeEvent: ev.on })
  await assert.rejects(ctx.send('charter\n'), err => {
    assert.ok(err instanceof InfraError)
    assert.equal(err.cls, 'transient_exhausted')
    return true
  })
  const pauses = ev.list.filter(e => e.type === 'TRANSPORT_PAUSE').map(e => e.secs)
  assert.deepEqual(pauses, [0.01, 0.02], 'exponential backoff until the ceiling')
  assert.equal(s.fake.log().length, 3)
})

test('the watchdog stops a hung child: InfraError(timeout), child killed', async () => {
  const s = await setup({ scenario: scenarioPath('hang') })
  const ctx = new RoleContext(vspec(s, { turnTimeoutSec: 0.8 }), { parentEnv: s.fake.env })
  const t0 = Date.now()
  await assert.rejects(ctx.send('charter\n'), err => err instanceof InfraError && err.cls === 'timeout')
  assert.ok(Date.now() - t0 < 15000)
  const log = s.fake.log()
  assert.equal(log.length, 1)
  assert.equal(log[0].exit, 130, 'SIGINT first (graceful stop)')
  const meta = JSON.parse(readFileSync(join(s.home, 'ctx', 'task-1-v1', '1', 'meta.json'), 'utf8'))
  assert.equal(meta.killedBy, 'watchdog')
  assert.equal(meta.cls, 'timeout')
})

test('abort → InterruptedError; the next recovering send resumes with the recovery note (R1)', async () => {
  const scenario = await writeScenario(`export default async function respond(ctx) {
    if (!ctx.recovering) return { hangMs: 60000, text: 'late' }
    return { text: 'RESUMED interrupted=' + ctx.history.some(t => t.interrupted) }
  }\n`)
  const s = await setup({ scenario })
  const ac = new AbortController()
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env, signal: ac.signal })
  setTimeout(() => ac.abort(), 600)
  await assert.rejects(ctx.send('the message\n'), err => err instanceof InterruptedError)
  // a new process would build a new RoleContext with the same session id and logDir
  const again = new RoleContext(vspec(s), { parentEnv: s.fake.env, sessionId: ctx.sessionId })
  const reply = await again.send('the message\n', { recovering: true })
  assert.equal(reply.text, 'RESUMED interrupted=true')
  assert.deepEqual(s.fake.log().map(l => [l.mode, l.exit]), [['new', 130], ['resume', 0]])
})

test('a recovering send on an unused session sends the plain message', async () => {
  const s = await setup({ scenario: scenarioPath('echo') })
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env })
  const reply = await ctx.send('plain\n', { recovering: true })
  assert.equal(reply.text, 'ROLE verifier TURN 1 RECOVERING false\nplain')
})

test('sandbox_unavailable on the first message with degrade allowed: re-run without the sandbox block, same uuid', async () => {
  const s = await setup({ scenario: scenarioPath('ok') })
  const ev = events()
  const sandboxed = vspec(s, { sandbox: { allowWrite: ['/tmp/x'], denyWrite: [s.cwd], denyRead: [], network: [] }, sandboxDegrade: 'allow', systemText: 'mechanics: sandbox' })
  const degradeCalls = []
  const ctx = new RoleContext(sandboxed, {
    parentEnv: s.fake.env,
    onRuntimeEvent: ev.on,
    onDegrade: first => {
      degradeCalls.push(first)
      return { ...sandboxed, sandbox: null, systemText: 'mechanics: rollback' }
    },
  })
  const reply = await ctx.send('charter\n')
  assert.equal(reply.text, 'OK')
  assert.deepEqual(degradeCalls, [true])
  const log = s.fake.log()
  assert.deepEqual(log.map(l => [l.mode, l.exit]), [['new', 1], ['new', 0]], 'no session was created by the failed start: --session-id again')
  const settingsOf = l => JSON.parse(readFileSync(l.argv[l.argv.indexOf('--settings') + 1], 'utf8'))
  assert.equal(settingsOf(log[0]).sandbox.failIfUnavailable, true)
  assert.equal(settingsOf(log[1]).sandbox, undefined)
  assert.equal(readFileSync(log[1].argv[log[1].argv.indexOf('--append-system-prompt-file') + 1], 'utf8'), 'mechanics: rollback')
  assert.equal(ev.list.filter(e => e.type === 'ISOLATION_DEGRADED').length, 1)
  const probe = JSON.parse(readFileSync(join(s.home, 'probe.json'), 'utf8'))
  assert.equal(probe.live.available, false)
  assert.match(probe.live.reason, /sandbox required but unavailable/)
})

test('sandbox lost after the first message: the note prefixes the message; refuse → InfraError', async () => {
  const s = await setup({ scenario: scenarioPath('ok') })
  const plain = vspec(s)
  const sandboxed = { ...plain, sandbox: { allowWrite: [], denyWrite: [s.cwd], denyRead: [], network: [] }, sandboxDegrade: 'allow' }
  const ctx = new RoleContext(plain, { parentEnv: s.fake.env, onDegrade: first => (first ? null : { ...plain }) })
  await ctx.send('first\n')
  ctx.setSpec(sandboxed)
  await ctx.send('second\n')
  const log = s.fake.log()
  assert.deepEqual(log.map(l => [l.mode, l.exit]), [['new', 0], ['resume', 1], ['resume', 0]])
  const prompt = readFileSync(join(s.home, 'ctx', 'task-1-v1', '3', 'prompt.md'), 'utf8')
  assert.equal(prompt, `${DEGRADE_NOTE}\n\nsecond\n`)

  const refusing = new RoleContext({ ...sandboxed, sandboxDegrade: 'refuse', logDir: join(s.home, 'ctx', 'other') }, { parentEnv: s.fake.env })
  await assert.rejects(refusing.send('x\n'), err => err instanceof InfraError && err.cls === 'sandbox_unavailable')
})

test('hooks that never run → InfraError(hooks_not_run)', async () => {
  const s = await setup({ scenario: scenarioPath('ok'), runHooks: false })
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env })
  await assert.rejects(ctx.send('charter\n'), err => err instanceof InfraError && err.cls === 'hooks_not_run')
})

test('guard gaps are warn-only, and a tool absent from --tools is never a gap', async () => {
  const s = await setup({ scenario: scenarioPath('scripted') })
  writeScript(s.fake, { verifier: { default: { actions: [{ tool: 'Bash', command: 'echo hi' }, { tool: 'Write', file_path: '{{CWD}}/x.txt', content: 'x' }], text: 'VERDICT: PASS' } } })
  // A plugin root whose role guard silently passes tool calls without logging them (a call that runs unattested).
  const pluginRoot = await tmpDir('cc-rsi-silent-guard-')
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true })
  writeFileSync(join(pluginRoot, 'hooks', 'role-guard.mjs'), `if (process.argv[2] === 'tool') process.exit(0)\nawait import(${JSON.stringify(join(ROOT, 'hooks', 'role-guard.mjs'))})\n`)
  const ev = events()
  const ctx = new RoleContext(vspec(s, { pluginRoot }), { parentEnv: s.fake.env, onRuntimeEvent: ev.on })
  const reply = await ctx.send('charter\n')
  assert.equal(reply.text, 'VERDICT: PASS')
  assert.equal(reply.guardGaps, 1, 'only the Bash call (in --tools) is a gap; Write is not a role tool')
  const gaps = ev.list.filter(e => e.type === 'GUARD_GAP')
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].toolUseIds.length, 1)
  assert.ok(!existsSync(join(s.cwd, 'x.txt')))
})

test('the real role guard denies hidden paths through the fake (tool_result error + permission denial)', async () => {
  const s = await setup({ scenario: scenarioPath('scripted') })
  const hidden = await tmpDir('cc-rsi-hidden-')
  writeFileSync(join(hidden, 'secret.txt'), 'SECRET')
  writeScript(s.fake, { verifier: { default: { actions: [{ tool: 'Read', file_path: join(hidden, 'secret.txt') }, { tool: 'Bash', command: `cat ${hidden}/secret.txt` }], text: 'VERDICT: FAIL' } } })
  const ctx = new RoleContext(vspec(s, { hidden: [hidden] }), { parentEnv: s.fake.env })
  const reply = await ctx.send('charter\n')
  assert.equal(reply.permissionDenials, 2)
  const stream = readFileSync(join(s.home, 'ctx', 'task-1-v1', '1', 'stream.jsonl'), 'utf8')
  assert.match(stream, /denied by your permission settings/, 'the Read(//hidden/**) deny rule refuses the Read before any hook')
  assert.match(stream, /PreToolUse:Bash hook error: .*harness-private path/, 'Bash is caught by the role guard')
  assert.ok(!stream.includes('SECRET'))
  const settings = JSON.parse(readFileSync(s.fake.log()[0].argv[s.fake.log()[0].argv.indexOf('--settings') + 1], 'utf8'))
  assert.ok(settings.permissions.deny.includes(`Read(/${hidden}/**)`))
})

test('R3 inputs: session_missing carries established false before any reply and true after one', async () => {
  const s = await setup({ scenario: scenarioPath('ok') })
  const crashFirst = await writeScenario("export default async () => ({ crash: 'before-init' })\n")
  const s2 = { ...s }
  const fakeCrash = await fakeClaude({ scenario: crashFirst, home: s.home })
  const ctx = new RoleContext(vspec(s2), { parentEnv: fakeCrash.env })
  await assert.rejects(ctx.send('m\n'), err => err.cls === 'crash')
  // the recovering resend resumes a session that the crashed start never created (R3)
  await assert.rejects(ctx.send('m\n', { recovering: true }), err => {
    assert.equal(err.cls, 'session_missing')
    assert.equal(err.extra.established, false)
    return true
  })
  const fakeOk = await fakeClaude({ scenario: scenarioPath('ok'), home: s.home })
  const est = new RoleContext(vspec(s, { logDir: join(s.home, 'ctx', 'est') }), { parentEnv: fakeOk.env })
  await est.send('hello\n')
  rmSync(join(fakeOk.fakeHome, 'sessions', `${est.sessionId}.json`)) // e.g. pruned after cleanupPeriodDays
  await assert.rejects(est.send('again\n'), err => err.cls === 'session_missing' && err.extra.established === true)
})

test('a reused session id is session_conflict (R4)', async () => {
  const s = await setup({ scenario: scenarioPath('ok') })
  const a = new RoleContext(vspec(s), { parentEnv: s.fake.env })
  await a.send('x\n')
  const b = new RoleContext(vspec(s, { logDir: join(s.home, 'ctx', 'fresh-registry') }), { parentEnv: s.fake.env, sessionId: a.sessionId })
  await assert.rejects(b.send('y\n'), err => err.cls === 'session_conflict')
})

test('liveness: an identical command with identical output gets the REPEAT note (+ stagnation revisit once)', async () => {
  const s = await setup({ scenario: scenarioPath('scripted') })
  writeScript(s.fake, { actor: { default: { actions: [{ tool: 'Bash', command: 'echo same' }, { tool: 'Bash', command: 'echo same' }, { tool: 'Bash', command: 'echo same' }], text: 'STATUS: SUBMIT' } } })
  const spec = vspec(s, { role: 'actor', key: 'w001/actor', tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'], allow: ['Read', 'Grep', 'Glob', 'Bash', `Edit(/${s.cwd}/**)`],
    deny: [], writeRoots: [s.cwd], readOnlyRoots: [], liveness: true, stagnationRevisit: '\n\nREVISIT MEMORY (stagnation).', logDir: join(s.home, 'ctx', 'actor') })
  const ctx = new RoleContext(spec, { parentEnv: s.fake.env })
  await ctx.send('work\n')
  const session = s.fake.session(ctx.sessionId)
  const contexts = session.turns[0].contexts.filter(c => c.event === 'PostToolUse').map(c => c.text)
  assert.equal(contexts.length, 2)
  assert.match(contexts[0], /^WARNING: you ran the IDENTICAL command/)
  assert.ok(contexts[0].endsWith('REVISIT MEMORY (stagnation).'))
  assert.ok(!contexts[1].includes('REVISIT MEMORY'), 'the stagnation revisit is added only the first time')
})

test('pin: a compaction re-pins the task through the role SessionStart(compact) hook', async () => {
  const s = await setup({ scenario: scenarioPath('scripted') })
  writeScript(s.fake, { actor: { default: { compact: true, text: 'STATUS: SUBMIT' } } })
  const spec = vspec(s, { role: 'actor', key: 't001/actor@0', tools: ['Read', 'Bash'], allow: ['Read', 'Bash'], deny: [], lossless: false,
    pinText: 'TASK (verbatim, unchanged — this is the actual goal):\nbuild the thing', logDir: join(s.home, 'ctx', 'pin') })
  const ctx = new RoleContext(spec, { parentEnv: s.fake.env })
  await ctx.send('go\n')
  assert.equal(readFileSync(join(s.home, 'ctx', 'pin', 'pin.md'), 'utf8'), spec.pinText)
  const turn = s.fake.session(ctx.sessionId).turns[0]
  assert.ok(turn.compacted)
  assert.deepEqual(turn.contexts.filter(c => c.event === 'SessionStart').map(c => c.text), [spec.pinText])
  assert.ok(!s.fake.log()[0].envKeys.includes('DISABLE_AUTO_COMPACT'), 'target Actors keep auto-compaction')
})

test('a crash mid-tool is infra; the recovering resend resumes and the interrupted call is visible (R1)', async () => {
  const scenario = await writeScenario(`export default async function respond(ctx) {
    if (!ctx.recovering) return { crash: 'mid-tool', actions: [{ tool: 'Bash', command: 'sleep 30' }] }
    return { text: 'history: ' + ctx.history.map(t => t.interrupted ? 'interrupted' : 'turn').join(',') }
  }\n`)
  const s = await setup({ scenario })
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env })
  await assert.rejects(ctx.send('job\n'), err => err.cls === 'crash' && /137/.test(err.detail))
  const reply = await ctx.send('job\n', { recovering: true })
  assert.equal(reply.text, 'history: interrupted')
})

test('a --no-session-persistence context (summarizer) retries in a fresh session with the original message', async () => {
  const scenario = await writeScenario(`import { existsSync, writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  export default async function respond(ctx) {
    const marker = join(ctx.fakeHome, 'failed-once')
    if (!existsSync(marker)) { writeFileSync(marker, '1'); return { apiError: { status: 529, error: 'overloaded' } } }
    return { text: 'SUMMARY of: ' + ctx.prompt.trim() }
  }\n`)
  const s = await setup({ scenario })
  const spec = vspec(s, { role: 'summarizer', key: 'summarize', tools: [], allow: [], deny: [], readOnlyRoots: [], maxTurns: 1, noSessionPersistence: true, logDir: join(s.home, 'ctx', 'sum') })
  const ctx = new RoleContext(spec, { parentEnv: s.fake.env })
  const firstId = ctx.sessionId
  const reply = await ctx.send('the worklog\n')
  assert.equal(reply.text, 'SUMMARY of: the worklog')
  const log = s.fake.log()
  assert.deepEqual(log.map(l => l.mode), ['new', 'new'])
  assert.equal(log[0].sessionId, firstId)
  assert.notEqual(log[1].sessionId, firstId)
  assert.equal(reply.sessionId, log[1].sessionId)
  assert.equal(log[1].stdinSha, sha256Hex('the worklog\n'))
  assert.ok(log.every(l => l.argv.includes('--no-session-persistence')))
})

test('concurrent sends on one context are refused; invalid specs throw', async () => {
  const s = await setup({ scenario: scenarioPath('ok') })
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env })
  const p = ctx.send('a\n')
  await assert.rejects(ctx.send('b\n'), /concurrent send/)
  await p
  assert.throws(() => new RoleContext({ ...vspec(s), cwd: 'relative' }), TypeError)
  assert.throws(() => new RoleContext({ ...vspec(s), role: 'nobody' }), TypeError)
  assert.throws(() => new RoleContext(vspec(s), { sessionId: 'nope' }), TypeError)
})

test('a spawn failure is InfraError(spawn); invocation numbers stay monotonic', async () => {
  const s = await setup({ scenario: scenarioPath('ok') })
  const ctx = new RoleContext(vspec(s), { parentEnv: s.fake.env, bin: join(s.home, 'no-such-claude') })
  await assert.rejects(ctx.send('x\n'), err => err.cls === 'spawn')
  await assert.rejects(ctx.send('x\n'), err => err.cls === 'spawn' || err.cls === 'session_missing' || err.cls === 'crash')
  const dirs = readdirSync(join(s.home, 'ctx', 'task-1-v1')).filter(n => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)
  assert.deepEqual(dirs, [1, 2])
})

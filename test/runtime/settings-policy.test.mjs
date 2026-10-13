// SPEC §10.6 settings and policy: shapes per role, hook presence rules, hidden-root denies, sandbox block only in
// sandbox mode, forwarded auth keys, content addressing.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { MUTATION_BASH_DENY } from '../../lib/guard/bash.mjs'
import { buildPolicy, scratchOf, writePolicy } from '../../lib/runtime/policy.mjs'
import { absRule, buildSettings, pinFileFor, writeSettings } from '../../lib/runtime/settings.mjs'
import { tmpHome } from '../_helpers/tmp.mjs'

const ROOT = '/opt/cc-rsi'
const NODE = '/usr/bin/node'
const H = '/home/u/.cc-rsi'
const W = `${H}/work/k/lin`

const verifierSpec = (extra = {}) => ({
  key: 'task-3-v1', role: 'verifier', cwd: '/repo', addDirs: [`${H}/vscratch/s1`], tools: ['Read', 'Grep', 'Glob', 'Bash'],
  allow: ['Read', 'Grep', 'Glob', 'Bash'], deny: ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill'],
  readRoots: [], writeRoots: [], readOnlyRoots: ['/repo'], hidden: [`${H}/projects`, `${H}/run`, `${H}/bin`, '/home/u/.claude/projects'],
  hiddenTokens: ['actor-private', 'curriculum-private', '/.cc-rsi/projects'], bashDeny: MUTATION_BASH_DENY, sandbox: null, systemText: 'sys',
  liveness: false, pinText: null, stagnationRevisit: null, logDir: `${H}/projects/k/sessions/s/ctx/task-3-v1`, home: H, pluginRoot: ROOT,
  extraEnv: { VERIFIER_SCRATCH: `${H}/vscratch/s1`, TMPDIR: `${H}/vscratch/s1/tmp` }, config: {}, ...extra,
})

test('absRule: the // absolute form', () => {
  assert.equal(absRule('Edit', '/home/u/x'), 'Edit(//home/u/x/**)')
  assert.equal(absRule('Read', '/home/u/x/'), 'Read(//home/u/x/**)')
  assert.equal(absRule('Read', '/'), 'Read(//**)')
  assert.throws(() => absRule('Edit', 'relative/x'), TypeError)
})

test('Verifier settings: permissions, hidden denies, required hooks only, no sandbox block', () => {
  const s = buildSettings(verifierSpec(), { pluginRoot: ROOT, nodePath: NODE })
  assert.equal(s.permissions.defaultMode, 'dontAsk')
  assert.deepEqual(s.permissions.allow, ['Read', 'Grep', 'Glob', 'Bash'])
  assert.deepEqual(s.permissions.deny, ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill',
    `Read(/${H}/projects/**)`, `Read(/${H}/run/**)`, `Read(/${H}/bin/**)`, 'Read(//home/u/.claude/projects/**)'])
  assert.deepEqual(s.permissions.additionalDirectories, [`${H}/vscratch/s1`])
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PreToolUse', 'UserPromptSubmit'])
  assert.deepEqual(s.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: NODE, args: [`${ROOT}/hooks/role-guard.mjs`, 'prompt'], timeout: 10, onFailure: 'block' }] }])
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: NODE, args: [`${ROOT}/hooks/role-guard.mjs`, 'tool'], timeout: 10, onFailure: 'block' }] }])
  assert.equal(s.sandbox, undefined)
  assert.equal(s.apiKeyHelper, undefined)
  assert.equal(s.env, undefined)
})

test('sandbox block only in sandbox mode; denyRead includes the hidden roots', () => {
  const s = buildSettings(verifierSpec({ sandbox: { allowWrite: [`${H}/vscratch/s1`], denyWrite: ['/repo'], denyRead: [], network: [] } }), { pluginRoot: ROOT, nodePath: NODE })
  assert.deepEqual(s.sandbox, {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
    filesystem: { allowWrite: [`${H}/vscratch/s1`], denyWrite: ['/repo'], denyRead: [`${H}/projects`, `${H}/run`, `${H}/bin`, '/home/u/.claude/projects'] },
    network: { allowedDomains: [] },
  })
})

test('Actor work and learn phases differ only in the memory rules; liveness and pin hooks', () => {
  const ep = `${W}/projects/w001`
  const mem = `${W}/actor-private/w001/memory`
  const base = { key: 'w001/actor', role: 'actor', cwd: ep, addDirs: [mem], tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'], readRoots: [], hidden: [`${W}/curriculum-private`],
    hiddenTokens: [], bashDeny: [], sandbox: null, systemText: 'engine', logDir: `${H}/projects/k/lineages/lin/ctx/w001_actor`, home: H, pluginRoot: ROOT,
    liveness: true, stagnationRevisit: null, pinText: null, config: { transport: { livenessNotes: true } } }
  const work = buildSettings({ ...base, allow: ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', ep)], deny: ['Agent', 'Task', 'Skill', 'NotebookEdit', 'WebFetch', 'WebSearch', absRule('Edit', mem)],
    writeRoots: [ep], readOnlyRoots: [mem] }, { pluginRoot: ROOT, nodePath: NODE })
  const learn = buildSettings({ ...base, allow: ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', ep), absRule('Edit', mem)], deny: ['Agent', 'Task', 'Skill', 'NotebookEdit', 'WebFetch', 'WebSearch'],
    writeRoots: [ep, mem], readOnlyRoots: [] }, { pluginRoot: ROOT, nodePath: NODE })
  assert.ok(work.permissions.deny.includes(`Edit(/${mem}/**)`))
  assert.ok(!learn.permissions.deny.includes(`Edit(/${mem}/**)`))
  assert.ok(learn.permissions.allow.includes(`Edit(/${mem}/**)`))
  assert.deepEqual(work.hooks.PostToolUse, [{ matcher: 'Bash|Read', hooks: [{ type: 'command', command: NODE, args: [`${ROOT}/hooks/role-guard.mjs`, 'post'], timeout: 10 }] }])
  assert.equal(work.hooks.SessionStart, undefined)
  const pinned = buildSettings({ ...base, allow: [], deny: [], pinText: 'TASK', liveness: false }, { pluginRoot: ROOT, nodePath: NODE })
  assert.deepEqual(pinned.hooks.SessionStart, [{ matcher: 'compact', hooks: [{ type: 'command', command: NODE, args: [`${ROOT}/hooks/role-guard.mjs`, 'pin'], timeout: 10 }] }])
  assert.equal(pinned.hooks.PostToolUse, undefined)
  assert.equal(pinFileFor({ ...base, pinText: 'TASK' }), `${base.logDir}/pin.md`)
  const quiet = buildSettings({ ...base, allow: [], deny: [], config: { transport: { livenessNotes: false } } }, { pluginRoot: ROOT, nodePath: NODE })
  assert.equal(quiet.hooks.PostToolUse, undefined, 'transport.livenessNotes:false removes the liveness hook')
})

test('Summarizer: no tools, no additional dirs, no sandbox', () => {
  const s = buildSettings({ key: 'sum', role: 'summarizer', cwd: `${W}/summarizer`, tools: [], allow: [], deny: [], hidden: [], systemText: 's', home: H, pluginRoot: ROOT,
    logDir: `${H}/x`, config: {} }, { pluginRoot: ROOT, nodePath: NODE })
  assert.deepEqual(s.permissions, { defaultMode: 'dontAsk', allow: [], deny: [], additionalDirectories: [] })
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PreToolUse', 'UserPromptSubmit'])
})

test('forwarded auth keys and provider env are merged; nothing else', () => {
  const s = buildSettings(verifierSpec(), { pluginRoot: ROOT, nodePath: NODE, forwarded: { apiKeyHelper: '/bin/key', forceLoginMethod: 'console', env: { ANTHROPIC_BASE_URL: 'https://x' }, permissions: { allow: ['*'] } } })
  assert.equal(s.apiKeyHelper, '/bin/key')
  assert.equal(s.forceLoginMethod, 'console')
  assert.deepEqual(s.env, { ANTHROPIC_BASE_URL: 'https://x' })
  assert.deepEqual(s.permissions.allow, ['Read', 'Grep', 'Glob', 'Bash'], 'forwarded settings never touch permissions')
})

test('policy: fields, defaults and the scratch dir', () => {
  const p = buildPolicy(verifierSpec({ config: { isolation: { foreignMessageGuard: true } } }))
  assert.equal(p.v, 1)
  assert.equal(p.role, 'verifier')
  assert.equal(p.ctxKey, 'task-3-v1')
  assert.deepEqual(p.tools, ['Read', 'Grep', 'Glob', 'Bash'])
  assert.equal(p.cwd, '/repo')
  assert.equal(p.home, H)
  assert.deepEqual(p.allowedPaths, ['/repo', `${H}/vscratch/s1`])
  assert.deepEqual(p.readRoots, ['/repo', `${H}/vscratch/s1`], 'readRoots default to the role directories')
  assert.deepEqual(p.writeRoots, [])
  assert.deepEqual(p.readOnlyRoots, ['/repo'])
  assert.equal(p.bashDeny.length, MUTATION_BASH_DENY.length)
  assert.equal(p.recursionGuard, true)
  assert.equal(p.foreignMessageGuard, true)
  assert.equal(p.liveness, false)
  assert.equal(p.repeatWarning, null)
  assert.equal(p.pinFile, null)
  assert.equal(scratchOf(verifierSpec()), `${H}/vscratch/s1`)
  const off = buildPolicy(verifierSpec({ config: { isolation: { foreignMessageGuard: false } } }))
  assert.equal(off.foreignMessageGuard, false)
  const live = buildPolicy(verifierSpec({ role: 'actor', liveness: true, stagnationRevisit: 'R', config: {} }))
  assert.equal(live.liveness, true)
  assert.match(live.repeatWarning, /^WARNING: you ran the IDENTICAL command/)
  assert.equal(live.stagnationRevisit, 'R')
  assert.throws(() => buildPolicy(verifierSpec({ bashDeny: [{ source: '(' }] })), SyntaxError)
  assert.throws(() => buildPolicy({ ...verifierSpec(), cwd: 'rel' }), TypeError)
})

test('writeSettings / writePolicy are content addressed and repair a tampered file', async () => {
  const { home } = await tmpHome()
  const s = buildSettings(verifierSpec({ home }), { pluginRoot: ROOT, nodePath: NODE })
  const a = await writeSettings(home, s)
  const b = await writeSettings(home, JSON.parse(JSON.stringify(s)))
  assert.equal(a, b)
  assert.ok(a.startsWith(join(home, 'run', 'settings')))
  assert.deepEqual(JSON.parse(readFileSync(a, 'utf8')), s)
  writeFileSync(a, '{"tampered":true}')
  assert.equal(await writeSettings(home, s), a)
  assert.deepEqual(JSON.parse(readFileSync(a, 'utf8')), s)
  const p1 = await writePolicy(home, buildPolicy(verifierSpec({ home })))
  const p2 = await writePolicy(home, buildPolicy(verifierSpec({ home })))
  assert.equal(p1, p2)
  assert.equal(JSON.parse(readFileSync(p1, 'utf8')).role, 'verifier')
  const other = await writePolicy(home, buildPolicy(verifierSpec({ home, hidden: [] })))
  assert.notEqual(other, p1)
})

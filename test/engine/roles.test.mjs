// Per-role RoleSpecs of lineage contexts (SPEC §12.5 spec rules, §10.6 per-role table, §4.3 hidden
// roots and tokens, §10.12 compaction) and the worklog helpers (SPEC §12.10).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { DEFAULTS } from '../../lib/core/config.mjs'
import { isUnderLexical } from '../../lib/core/paths.mjs'
import { specFor } from '../../lib/engine/roles.mjs'
import { verifierSystem } from '../../lib/prompts/roles.mjs'
import { scanBash } from '../../lib/guard/bash.mjs'
import { digestWorklog, foldInput, messagesFromLogs } from '../../lib/engine/worklog.mjs'
import { buildPolicy } from '../../lib/runtime/policy.mjs'
import { absRule } from '../../lib/runtime/settings.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const config = JSON.parse(JSON.stringify(DEFAULTS))
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))
/** The running plugin code (this checkout and the test's pluginRoot): read-only for every role (security-4). */
const CODE = [...new Set([REPO, realpathSync(REPO), '/plugin'])]
const GUARD = join(REPO, 'hooks', 'role-guard.mjs')

async function world() {
  const home = await tmpDir('cc-rsi-home-')
  const W = join(home, 'work', 'proj-abc', 'lin1')
  const otherLineage = join(home, 'work', 'proj-abc', 'lin2')
  const otherProject = join(home, 'work', 'other-key')
  for (const dir of [
    join(home, 'work', '.git'), otherLineage, otherProject,
    join(W, 'curriculum-private', 'memory'), join(W, 'projects', 'w001-a'), join(W, 'projects', 'w001-b'),
    join(W, 'actor-private', 'w001-a', 'memory'), join(W, 'actor-private', 'w001-b', 'memory'),
    join(W, 'verify', 'w001-a', 'candidate'), join(W, 'verify', 'w001-b', 'candidate'),
    join(W, 'verify-scratch', 'w001-a-v1'), join(W, 'verify-scratch', 'w001-b-v1'), join(W, 'summarizer'),
  ]) mkdirSync(dir, { recursive: true })
  const env = { HOME: '/home/someone', PATH: process.env.PATH }
  const common = { home, W, pluginRoot: '/plugin', config, logDir: join(home, 'projects', 'proj-abc', 'lineages', 'lin1', 'ctx', 'k'), env, key: 'k' }
  return { home, W, otherLineage, otherProject, env, common }
}

/** The Bash verdict of a role policy for `command` (the role guard's scanBash call). */
function bashOf(spec, command) {
  const p = buildPolicy(spec)
  return scanBash(command, { hidden: p.hidden, hiddenTokens: p.hiddenTokens, allowedPaths: p.allowedPaths, home: p.home, userHome: p.userHome, cwd: p.cwd, recursionGuard: true, bashDeny: p.bashDeny })
}

function assertOwnDirsVisible(spec) {
  for (const own of [spec.cwd, ...spec.addDirs]) {
    for (const hidden of spec.hidden) assert.ok(!isUnderLexical(own, hidden), `${own} is under hidden ${hidden}`)
  }
}

describe('lineage role specs: own temp files and tool results (r2-engine-5, r2-interactive-5)', () => {
  it('a role reads its own Claude Code temp files under its TMPDIR from Bash; the user\'s stay hidden', async () => {
    const w = await world()
    const env = { ...w.env, TMPDIR: '/tmp' }
    const uid = process.getuid?.() ?? 0
    const root = join(w.W, 'projects', 'w001-a')
    const actor = await specFor({ ...w.common, env, role: 'actor', kind: 'practice', phase: 'work', root, memoryDir: join(w.W, 'actor-private', 'w001-a', 'memory'), isolation: { mode: 'unconfined' } })
    const scratch = join(w.W, 'verify-scratch', 'w001-a-v1')
    const verifier = await specFor({ ...w.common, env, role: 'verifier', kind: 'practice', root, scratch, isolation: { mode: 'unconfined' } })
    for (const spec of [actor, verifier]) {
      const own = join(spec.extraEnv.TMPDIR, `claude-${uid}`, '-slug', 'session-1', 'scratchpad', 'probe.py')
      for (const command of [`tail -n 40 ${own}`, `python3 ${own}`, `grep FAIL ${own}`, `ls ${spec.extraEnv.TMPDIR}`]) assert.equal(bashOf(spec, command), null, `${spec.role}: ${command}`)
      assert.match(bashOf(spec, `cat /tmp/claude-${uid}/-other/session/tasks/x.output`) ?? '', /harness-private path/, spec.role)
      assert.match(bashOf(spec, `cat ${spec.extraEnv.TMPDIR}/../../../../../../tmp/claude-${uid}/x`) ?? '', /harness-private path/, `${spec.role}: climbing out of its own dir`)
    }
  })

  it('a role reads its own persisted tool results; another session\'s stay hidden', async () => {
    const { ownSessionDirs } = await import('../../lib/runtime/private.mjs')
    const w = await world()
    const env = { ...w.env, HOME: w.home, CLAUDE_CONFIG_DIR: join(w.home, 'cfg') }
    const root = join(w.W, 'projects', 'w001-a')
    const base = await specFor({ ...w.common, env, role: 'verifier', kind: 'practice', root, scratch: join(w.W, 'verify-scratch', 'w001-a-v1'), isolation: { mode: 'unconfined' } })
    const sid = '0f1e2d3c-0000-4000-8000-00000000abcd'
    const spec = { ...base, ownPaths: ownSessionDirs({ cwd: root, sessionId: sid, env }) }
    const mine = join(w.home, 'cfg', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), sid, 'tool-results', 'b1.txt')
    assert.ok(spec.ownPaths.some(d => mine.startsWith(`${d}/`)), JSON.stringify(spec.ownPaths))
    assert.equal(bashOf(spec, `tail -50 ${mine}`), null)
    const other = mine.replace(sid, '99999999-0000-4000-8000-000000000000')
    assert.match(bashOf(spec, `tail -50 ${other}`) ?? '', /harness-private path/)
    assert.match(bashOf(spec, `cat ${mine.replace('tool-results/b1.txt', '../x.jsonl')}`) ?? '', /harness-private path/)
    // The role guard's file-tool check (Read) reads the same policy.
    const p = buildPolicy(spec)
    assert.ok(p.allowedPaths.some(d => mine.startsWith(`${d}/`)) && p.readRoots.some(d => mine.startsWith(`${d}/`)))
    assert.ok(p.hidden.some(h => mine.startsWith(`${h}/`)), 'the projects root itself stays hidden')
  })
})

describe('lineage role specs: sibling roots that are moved aside (r2-engine-6)', () => {
  it('a sibling spawned while an Actor root is moved aside for an inspection still hides it', async () => {
    const { rmSync } = await import('node:fs')
    const w = await world()
    const a = join(w.W, 'projects', 'w001-a')
    // The inspection of w001-a moved its root aside; the replay has not recreated it yet.
    rmSync(a, { recursive: true, force: true })
    const root = join(w.W, 'projects', 'w001-b')
    const actor = await specFor({ ...w.common, role: 'actor', kind: 'practice', phase: 'work', root, memoryDir: join(w.W, 'actor-private', 'w001-b', 'memory'), isolation: { mode: 'unconfined' } })
    const verifier = await specFor({ ...w.common, role: 'verifier', kind: 'practice', root, scratch: join(w.W, 'verify-scratch', 'w001-b-v1'), isolation: { mode: 'unconfined' } })
    for (const spec of [actor, verifier]) {
      assert.ok(spec.hidden.includes(a), `${spec.role} hides the absent sibling root`)
      assert.ok(spec.hidden.includes(`${a}.tmp`))
      assert.ok(!spec.hidden.includes(root), `${spec.role} never hides its own root`)
      assert.match(bashOf(spec, `cat ${a}/out.txt`) ?? '', /harness-private path/, spec.role)
      assert.match(bashOf(spec, 'cat ../w001-a/out.txt') ?? '', /harness-private path/, spec.role)
    }
  })
})

describe('lineage role specs', () => {
  it('Actor work phase: memory read-only, siblings and harness dirs hidden, lossless practice', async () => {
    const w = await world()
    const root = join(w.W, 'projects', 'w001-a')
    const memoryDir = join(w.W, 'actor-private', 'w001-a', 'memory')
    const spec = await specFor({ ...w.common, role: 'actor', kind: 'practice', phase: 'work', root, memoryDir, model: 'm', isolation: { mode: 'unconfined', allowUnconfined: true } })
    // The Actor's private scratch beside its memory (prompts-3), also its own TMPDIR (security-9).
    const scratch = join(w.W, 'actor-private', 'w001-a', 'scratch')
    assert.deepEqual(spec.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'])
    assert.deepEqual(spec.allow, ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', root), absRule('Edit', scratch)])
    assert.ok(spec.deny.includes(absRule('Edit', memoryDir)))
    for (const tool of ['Agent', 'Task', 'Skill', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(spec.deny.includes(tool), tool)
    assert.deepEqual(spec.addDirs, [memoryDir, scratch])
    assert.deepEqual(spec.readRoots, [root, memoryDir, scratch])
    assert.deepEqual(spec.writeRoots, [root, scratch])
    assert.deepEqual(spec.readOnlyRoots, [memoryDir, ...CODE])
    assert.equal(spec.extraEnv.TMPDIR, join(scratch, '.tmp'))
    assert.ok(existsSync(join(scratch, '.tmp')) && (statSync(scratch).mode & 0o777) === 0o700, 'created private before the spawn')
    // The user's Claude Code session temp dirs and reasoning artifacts are hidden (security-9).
    const uid = process.getuid()
    assert.ok(spec.hidden.includes(join('/tmp', `claude-${uid}`)))
    for (const token of ['.claude/plans', '.claude/todos', '.claude/tasks', '.claude/file-history', '.claude/history.jsonl', '/tmp/claude-']) {
      assert.ok(spec.hiddenTokens.includes(token), token)
    }
    for (const hidden of [join(w.home, 'projects'), join(w.home, 'run'), join(w.home, 'bin'), join(w.home, 'config.json'), join(w.home, 'vscratch'),
      '/home/someone/.claude/projects', '/home/someone/.claude/.credentials.json', w.otherLineage, w.otherProject,
      join(w.W, 'curriculum-private'), join(w.W, 'verify'), join(w.W, 'verify-scratch'), join(w.W, 'projects', 'w001-b'), join(w.W, 'actor-private', 'w001-b')]) {
      assert.ok(spec.hidden.includes(hidden), `missing hidden ${hidden}`)
    }
    assert.ok(!spec.hidden.includes(join(w.home, 'work', '.git')))
    assertOwnDirsVisible(spec)
    for (const token of ['curriculum-private', 'verify-scratch', '../../verify', '/.cc-rsi/projects', '/.cc-rsi/run', '.claude/projects', '.claude/.credentials', '/.cc-rsi/vscratch']) {
      assert.ok(spec.hiddenTokens.includes(token), token)
    }
    assert.ok(!spec.hiddenTokens.includes('/verify/'))
    assert.equal(spec.lossless, true)
    assert.equal(spec.pinText, null)
    assert.equal(spec.liveness, true)
    assert.equal(spec.sandbox, null)
    assert.equal(spec.sandboxDegrade, 'allow')
    assert.equal(spec.maxTurns, 2000)
  })

  it('Actor learning phase: memory writable in the same session; target Actors are pinned with compaction on', async () => {
    const w = await world()
    const root = join(w.W, 'projects', 'w001-a')
    const memoryDir = join(w.W, 'actor-private', 'w001-a', 'memory')
    const learn = await specFor({ ...w.common, role: 'actor', kind: 'practice', phase: 'learn', root, memoryDir, isolation: { mode: 'sandbox', allowUnconfined: false } })
    assert.ok(learn.allow.includes(absRule('Edit', memoryDir)))
    assert.ok(!learn.deny.includes(absRule('Edit', memoryDir)))
    const scratch = join(w.W, 'actor-private', 'w001-a', 'scratch')
    assert.deepEqual(learn.writeRoots, [root, memoryDir, scratch])
    assert.deepEqual(learn.readOnlyRoots, CODE)
    assert.deepEqual(learn.sandbox.allowWrite, [root, memoryDir, scratch])
    assert.deepEqual(learn.sandbox.denyWrite, CODE, 'the plugin code is never writable, also from a sandboxed shell (security-4)')
    assert.equal(learn.sandboxDegrade, 'refuse')
    const target = await specFor({ ...w.common, role: 'actor', kind: 'target', phase: 'work', root, memoryDir, target: 'Do the thing.', isolation: { mode: 'sandbox' } })
    assert.equal(target.lossless, false)
    assert.match(target.pinText, /Do the thing\./)
    assert.match(target.pinText, /\n\n/)
    assert.deepEqual(target.sandbox.denyWrite, [memoryDir, ...CODE])
  })

  it('Verifier: practice replay vs live target, scratch env, mutation guard only without a sandbox', async () => {
    const w = await world()
    const candidate = join(w.W, 'verify', 'w001-a', 'candidate')
    const scratch = join(w.W, 'verify-scratch', 'w001-a-v1')
    const original = join(w.W, 'verify', 'w001-a', 'original')
    const practice = await specFor({ ...w.common, role: 'verifier', kind: 'practice', root: candidate, scratch, original, allowUnverified: true, isolation: { mode: 'unconfined' } })
    assert.deepEqual(practice.tools, ['Read', 'Grep', 'Glob', 'Bash'])
    assert.deepEqual(practice.allow, ['Read', 'Grep', 'Glob', 'Bash'])
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill']) assert.ok(practice.deny.includes(tool), tool)
    assert.deepEqual(practice.addDirs, [scratch, original])
    assert.deepEqual(practice.writeRoots, [])
    assert.deepEqual(practice.readOnlyRoots, [candidate, original, ...CODE])
    assert.equal(practice.extraEnv.VERIFIER_SCRATCH, scratch)
    assert.equal(practice.extraEnv.TMPDIR, join(scratch, '.tmp'))
    assert.ok(practice.bashDeny.length > 0)
    for (const hidden of [join(w.W, 'actor-private'), join(w.W, 'curriculum-private'), join(w.W, 'projects', 'w001-a'), join(w.W, 'projects', 'w001-b'),
      join(w.W, 'verify', 'w001-b'), join(w.W, 'verify-scratch', 'w001-b-v1'), join(w.home, 'vscratch')]) {
      assert.ok(practice.hidden.includes(hidden), `missing hidden ${hidden}`)
    }
    assert.ok(!practice.hidden.includes(join(w.W, 'verify', 'w001-a')))
    assertOwnDirsVisible(practice)
    // prompts-2: the practice capture is replayed at the Actor's own root, which the Verifier sees.
    const replayed = await specFor({ ...w.common, role: 'verifier', kind: 'practice', root: join(w.W, 'projects', 'w001-a'), scratch, original, allowUnverified: true, isolation: { mode: 'unconfined' } })
    assert.equal(replayed.cwd, join(w.W, 'projects', 'w001-a'))
    assert.ok(!replayed.hidden.includes(join(w.W, 'projects', 'w001-a')))
    assert.ok(!replayed.hidden.includes(join(w.W, 'verify', 'w001-a'))) // its own original fixtures
    for (const hidden of [join(w.W, 'projects', 'w001-b'), join(w.W, 'verify', 'w001-b'), join(w.W, 'actor-private'), join(w.W, 'verify-scratch', 'w001-b-v1')]) {
      assert.ok(replayed.hidden.includes(hidden), `missing hidden ${hidden}`)
    }
    assertOwnDirsVisible(replayed)
    const phase1 = await specFor({ ...w.common, role: 'verifier', kind: 'practice', root: join(w.W, 'projects', 'w001-a'), scratch, allowUnverified: false, isolation: { mode: 'unconfined' } })
    assert.ok(phase1.hidden.includes(join(w.W, 'verify', 'w001-a'))) // no original fixtures in Phase 1
    assert.ok(!phase1.hidden.includes(join(w.W, 'projects', 'w001-a')))
    assert.ok(practice.hiddenTokens.includes('actor-private'))
    assert.ok(!practice.hiddenTokens.includes('/.cc-rsi/vscratch'))
    assert.match(practice.systemText, /fresh copy of the captured candidate/)
    const live = join(w.W, 'projects', 'w001-a')
    const target = await specFor({ ...w.common, role: 'verifier', kind: 'target', root: live, scratch, allowUnverified: true, isolation: { mode: 'sandbox' } })
    assert.ok(!target.hidden.includes(live))
    assert.ok(target.hidden.includes(join(w.W, 'projects', 'w001-b')))
    assert.deepEqual(target.sandbox.allowWrite, [scratch])
    assert.deepEqual(target.sandbox.denyWrite, [live, ...CODE])
    // Live inspections restore the whole root: the full mechanics paragraph (prompts-1), the very
    // text target.mjs hashes into the Verifier context id.
    assert.equal(target.systemText, verifierSystem({ location: 'live', sandbox: true, allowUnverified: true, checkpoint: 'full' }))
    assert.match(target.systemText, /restores any change afterwards/)
    const unsandboxed = await specFor({ ...w.common, role: 'verifier', kind: 'target', root: live, scratch, allowUnverified: true, isolation: { mode: 'unconfined' } })
    assert.match(unsandboxed.systemText, /restores every changed/)
    assert.deepEqual(target.bashDeny, [])
    assertOwnDirsVisible(target)
  })

  it('Curriculum and summarizer', async () => {
    const w = await world()
    const cwd = join(w.W, 'curriculum-private')
    const cur = await specFor({ ...w.common, role: 'curriculum', cwd, memoryDir: join(cwd, 'memory'), isolation: { mode: 'unconfined' } })
    assert.deepEqual(cur.allow, ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', cwd)])
    assert.ok(cur.deny.includes(absRule('Edit', join(cwd, 'memory'))))
    assert.deepEqual(cur.readOnlyRoots, [join(cwd, 'memory'), ...CODE])
    assert.equal(cur.extraEnv.TMPDIR, join(cwd, '.tmp'), 'its own TMPDIR (security-9)')
    assert.ok(existsSync(join(cwd, '.tmp')))
    for (const hidden of [join(w.W, 'actor-private'), join(w.W, 'projects'), join(w.W, 'verify'), join(w.W, 'verify-scratch')]) assert.ok(cur.hidden.includes(hidden))
    assertOwnDirsVisible(cur)
    assert.match(cur.systemText, /CURRICULUM|Curriculum/)
    const sum = await specFor({ ...w.common, role: 'summarizer', cwd: join(w.W, 'summarizer'), isolation: { mode: 'sandbox' } })
    assert.deepEqual(sum.tools, [])
    assert.equal(sum.noSessionPersistence, true)
    assert.equal(sum.maxTurns, 1)
    assert.equal(sum.sandbox, null)
    assertOwnDirsVisible(sum)
  })
})

describe('lineage role guard policies', () => {
  const guardOpts = spec => ({
    hidden: spec.hidden, hiddenTokens: spec.hiddenTokens, allowedPaths: [spec.cwd, ...spec.addDirs], home: spec.home, userHome: spec.userHome, cwd: spec.cwd,
  })

  it('hides credentials, plans and history under CLAUDE_CONFIG_DIR, <home>/logs and an external store from every role (portability-5)', async () => {
    const w = await world()
    const cfg = join(await tmpDir('cc-rsi-cfg-'), 'claude-cfg')
    const store = join(await tmpDir('cc-rsi-store-'), 'store')
    const env = { HOME: '/home/someone', PATH: process.env.PATH, CLAUDE_CONFIG_DIR: cfg }
    const root = join(w.W, 'projects', 'w001-a')
    const memoryDir = join(w.W, 'actor-private', 'w001-a', 'memory')
    const scratch = join(w.W, 'verify-scratch', 'w001-a-v1')
    const specs = [
      await specFor({ ...w.common, env, storeDir: store, role: 'actor', kind: 'practice', phase: 'work', root, memoryDir, isolation: { mode: 'unconfined' } }),
      await specFor({ ...w.common, env, storeDir: store, role: 'actor', kind: 'target', phase: 'learn', root, memoryDir, target: 'x', isolation: { mode: 'unconfined' } }),
      await specFor({ ...w.common, env, storeDir: store, role: 'verifier', kind: 'practice', root, scratch, isolation: { mode: 'unconfined' } }),
      await specFor({ ...w.common, env, storeDir: store, role: 'curriculum', cwd: join(w.W, 'curriculum-private'), memoryDir: null, isolation: { mode: 'unconfined' } }),
      await specFor({ ...w.common, env, storeDir: store, role: 'summarizer', cwd: join(w.W, 'summarizer'), isolation: { mode: 'unconfined' } }),
    ]
    for (const spec of specs) {
      for (const hidden of [join(cfg, '.credentials.json'), join(cfg, 'projects'), join(cfg, 'history.jsonl'), join(cfg, 'file-history'),
        '/home/someone/.claude/.credentials.json', join(w.home, 'logs'), store]) {
        assert.ok(spec.hidden.includes(hidden), `${spec.role}: missing hidden ${hidden}`)
      }
      assertOwnDirsVisible(spec)
    }
    for (const spec of specs.filter(x => x.role !== 'summarizer')) {
      assert.match(scanBash(`cat ${join(cfg, '.credentials.json')}`, guardOpts(spec)) ?? '', /harness-private path/, spec.role)
      assert.match(scanBash(`ls ${join(w.home, 'logs')}`, guardOpts(spec)) ?? '', /harness-private path/, spec.role)
    }
    // A store inside <home>/projects is already covered by <home>/projects.
    const inside = await specFor({ ...w.common, env, storeDir: join(w.home, 'projects', 'proj-abc', 'store'), role: 'actor', kind: 'practice', phase: 'work', root, memoryDir, isolation: { mode: 'unconfined' } })
    assert.ok(!inside.hidden.includes(join(w.home, 'projects', 'proj-abc', 'store')))
  })

  it('the real role guard lets an Actor Read and Write its private scratch, and nothing outside its directories (prompts-3)', async () => {
    const w = await world()
    const root = join(w.W, 'projects', 'w001-a')
    const memoryDir = join(w.W, 'actor-private', 'w001-a', 'memory')
    const spec = await specFor({ ...w.common, role: 'actor', kind: 'target', phase: 'work', root, memoryDir, target: 'x', isolation: { mode: 'unconfined' } })
    const scratch = join(w.W, 'actor-private', 'w001-a', 'scratch')
    const policyFile = join(w.home, 'policy.json')
    writeFileSync(policyFile, JSON.stringify(buildPolicy(spec)))
    const env = { ...process.env, CC_RSI_POLICY: policyFile, CC_RSI_GUARD_LOG: join(w.home, 'guard.jsonl'), CC_RSI_ROLE: 'actor' }
    const decide = async (tool_name, tool_input) => {
      const r = await runNode(GUARD, ['tool'], { stdin: JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'toolu_x' }), env, cwd: root })
      return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null
    }
    assert.equal(await decide('Write', { file_path: join(scratch, 'render.png'), content: 'x' }), null)
    assert.equal(await decide('Read', { file_path: join(scratch, 'render.png') }), null)
    assert.equal(await decide('Write', { file_path: join(root, 'out.txt'), content: 'x' }), null)
    assert.match(await decide('Write', { file_path: join(memoryDir, 'x.md'), content: 'x' }) ?? '', /not writable by this role/)
    assert.match(await decide('Write', { file_path: '/tmp/elsewhere.txt', content: 'x' }) ?? '', /outside the directories available to this role/)
    assert.match(await decide('Write', { file_path: join(REPO, 'hooks', 'role-guard.mjs'), content: 'x' }) ?? '', /not (writable|available)|outside the directories/)
  })

  it('lets an Actor name its own <root>/verify/…, ./verify/… and URLs while <W>/verify stays hidden (prompts-11)', async () => {
    const w = await world()
    for (const kind of ['practice', 'target']) {
      const root = join(w.W, 'projects', 'w001-a')
      const spec = await specFor({ ...w.common, role: 'actor', kind, phase: 'work', root, memoryDir: join(w.W, 'actor-private', 'w001-a', 'memory'), target: 'x', isolation: { mode: 'unconfined' } })
      const opts = guardOpts(spec)
      for (const command of [`python3 ${join(root, 'verify', 'check.py')}`, 'bash ./verify/check.sh', 'ls src/verify/', 'bash verify/check.sh',
        'curl -s https://example.com/api/verify/token', 'cd tests && bash ../verify/check.sh']) {
        assert.equal(scanBash(command, opts), null, `${kind}: ${command}`)
      }
      for (const command of [`ls ${join(w.W, 'verify', 'w001-a', 'original')}`, 'ls ../../verify/w001-a', 'cat $PWD/../../verify/w001-b/original/x',
        'cd .. && cd .. && ls verify']) {
        assert.match(scanBash(command, opts) ?? '', /harness-private path/, `${kind}: ${command}`)
      }
      // Without a known cwd the token still catches the relative traversal.
      assert.match(scanBash('ls ../../verify/w001-a', { ...opts, cwd: undefined }) ?? '', /harness-private path/)
    }
  })
})

describe('worklog helpers', () => {
  it('folds long messages head + tail (RSIAgent _fold_input) and digests newest-first under a cap', () => {
    assert.equal(foldInput('short'), 'short')
    const long = `${'a'.repeat(2000)}${'b'.repeat(3000)}`
    const folded = foldInput(long)
    assert.ok(folded.startsWith('a'.repeat(1500)))
    assert.ok(folded.endsWith('b'.repeat(2500)))
    assert.match(folded, /…\[trace middle elided\]…/)
    assert.equal(digestWorklog(['HANDOFF:\none', 'VERIFIER REPORT (generation 1):\ntwo']), 'HANDOFF:\none\n\nVERIFIER REPORT (generation 1):\ntwo')
    const entries = Array.from({ length: 20 }, (_, i) => `entry ${i} ${'x'.repeat(100)}`)
    const capped = digestWorklog(entries, 500)
    assert.ok(capped.length <= 500)
    assert.match(capped, /^\[… earlier work-log entries dropped/)
    assert.match(capped, /entry 19/)
    assert.doesNotMatch(capped, /entry 0 /)
  })

  it('rebuilds [YOU]/[ENV] messages from invocation logs', async () => {
    const logDir = await tmpDir()
    mkdirSync(join(logDir, '1'))
    writeFileSync(join(logDir, '1', 'prompt.md'), 'TASK: do it')
    writeFileSync(join(logDir, '1', 'stream.jsonl'), [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', content: 'a.txt' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.\nSTATUS: SUBMIT' }] } },
    ].map(e => JSON.stringify(e)).join('\n'))
    mkdirSync(join(logDir, 'sessions'))
    const messages = await messagesFromLogs(logDir)
    assert.deepEqual(messages, [
      { who: 'ENV', text: 'TASK: do it' },
      { who: 'YOU', text: 'tool call Bash: {"command":"ls"}' },
      { who: 'ENV', text: 'tool result: a.txt' },
      { who: 'YOU', text: 'Done.\nSTATUS: SUBMIT' },
    ])
  })
})

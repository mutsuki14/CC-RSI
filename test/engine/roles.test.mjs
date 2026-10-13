// Per-role RoleSpecs of lineage contexts (SPEC §12.5 spec rules, §10.6 per-role table, §4.3 hidden
// roots and tokens, §10.12 compaction) and the worklog helpers (SPEC §12.10).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULTS } from '../../lib/core/config.mjs'
import { isUnderLexical } from '../../lib/core/paths.mjs'
import { specFor } from '../../lib/engine/roles.mjs'
import { digestWorklog, foldInput, messagesFromLogs } from '../../lib/engine/worklog.mjs'
import { absRule } from '../../lib/runtime/settings.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const config = JSON.parse(JSON.stringify(DEFAULTS))

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

function assertOwnDirsVisible(spec) {
  for (const own of [spec.cwd, ...spec.addDirs]) {
    for (const hidden of spec.hidden) assert.ok(!isUnderLexical(own, hidden), `${own} is under hidden ${hidden}`)
  }
}

describe('lineage role specs', () => {
  it('Actor work phase: memory read-only, siblings and harness dirs hidden, lossless practice', async () => {
    const w = await world()
    const root = join(w.W, 'projects', 'w001-a')
    const memoryDir = join(w.W, 'actor-private', 'w001-a', 'memory')
    const spec = await specFor({ ...w.common, role: 'actor', kind: 'practice', phase: 'work', root, memoryDir, model: 'm', isolation: { mode: 'unconfined', allowUnconfined: true } })
    assert.deepEqual(spec.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'])
    assert.deepEqual(spec.allow, ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', root)])
    assert.ok(spec.deny.includes(absRule('Edit', memoryDir)))
    for (const tool of ['Agent', 'Task', 'Skill', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(spec.deny.includes(tool), tool)
    assert.deepEqual(spec.addDirs, [memoryDir])
    assert.deepEqual(spec.writeRoots, [root])
    assert.deepEqual(spec.readOnlyRoots, [memoryDir])
    for (const hidden of [join(w.home, 'projects'), join(w.home, 'run'), join(w.home, 'bin'), join(w.home, 'config.json'), join(w.home, 'vscratch'),
      '/home/someone/.claude/projects', '/home/someone/.claude/.credentials.json', w.otherLineage, w.otherProject,
      join(w.W, 'curriculum-private'), join(w.W, 'verify'), join(w.W, 'verify-scratch'), join(w.W, 'projects', 'w001-b'), join(w.W, 'actor-private', 'w001-b')]) {
      assert.ok(spec.hidden.includes(hidden), `missing hidden ${hidden}`)
    }
    assert.ok(!spec.hidden.includes(join(w.home, 'work', '.git')))
    assertOwnDirsVisible(spec)
    for (const token of ['curriculum-private', 'verify-scratch', '/verify/', '/.cc-rsi/projects', '/.cc-rsi/run', '.claude/projects', '.claude/.credentials', '/.cc-rsi/vscratch']) {
      assert.ok(spec.hiddenTokens.includes(token), token)
    }
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
    assert.deepEqual(learn.writeRoots, [root, memoryDir])
    assert.deepEqual(learn.readOnlyRoots, [])
    assert.deepEqual(learn.sandbox.allowWrite, [root, memoryDir])
    assert.deepEqual(learn.sandbox.denyWrite, [])
    assert.equal(learn.sandboxDegrade, 'refuse')
    const target = await specFor({ ...w.common, role: 'actor', kind: 'target', phase: 'work', root, memoryDir, target: 'Do the thing.', isolation: { mode: 'sandbox' } })
    assert.equal(target.lossless, false)
    assert.match(target.pinText, /Do the thing\./)
    assert.match(target.pinText, /\n\n/)
    assert.deepEqual(target.sandbox.denyWrite, [memoryDir])
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
    assert.deepEqual(practice.readOnlyRoots, [candidate, original])
    assert.equal(practice.extraEnv.VERIFIER_SCRATCH, scratch)
    assert.equal(practice.extraEnv.TMPDIR, join(scratch, 'tmp'))
    assert.ok(practice.bashDeny.length > 0)
    for (const hidden of [join(w.W, 'actor-private'), join(w.W, 'curriculum-private'), join(w.W, 'projects', 'w001-a'), join(w.W, 'projects', 'w001-b'),
      join(w.W, 'verify', 'w001-b'), join(w.W, 'verify-scratch', 'w001-b-v1'), join(w.home, 'vscratch')]) {
      assert.ok(practice.hidden.includes(hidden), `missing hidden ${hidden}`)
    }
    assert.ok(!practice.hidden.includes(join(w.W, 'verify', 'w001-a')))
    assertOwnDirsVisible(practice)
    assert.ok(practice.hiddenTokens.includes('actor-private'))
    assert.ok(!practice.hiddenTokens.includes('/.cc-rsi/vscratch'))
    assert.match(practice.systemText, /fresh copy of the captured candidate/)
    const live = join(w.W, 'projects', 'w001-a')
    const target = await specFor({ ...w.common, role: 'verifier', kind: 'target', root: live, scratch, allowUnverified: true, isolation: { mode: 'sandbox' } })
    assert.ok(!target.hidden.includes(live))
    assert.ok(target.hidden.includes(join(w.W, 'projects', 'w001-b')))
    assert.deepEqual(target.sandbox.allowWrite, [scratch])
    assert.deepEqual(target.sandbox.denyWrite, [live])
    assert.deepEqual(target.bashDeny, [])
    assertOwnDirsVisible(target)
  })

  it('Curriculum and summarizer', async () => {
    const w = await world()
    const cwd = join(w.W, 'curriculum-private')
    const cur = await specFor({ ...w.common, role: 'curriculum', cwd, memoryDir: join(cwd, 'memory'), isolation: { mode: 'unconfined' } })
    assert.deepEqual(cur.allow, ['Read', 'Grep', 'Glob', 'Bash', absRule('Edit', cwd)])
    assert.ok(cur.deny.includes(absRule('Edit', join(cwd, 'memory'))))
    assert.deepEqual(cur.readOnlyRoots, [join(cwd, 'memory')])
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

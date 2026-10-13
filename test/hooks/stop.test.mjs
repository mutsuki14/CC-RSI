// SPEC §15.3 WP5 hooks: the Stop policy matrix (§11.9) — each row, the stop_hook_active loop guard,
// the gate cap per prompt, background_tasks, the off policy and subagent stops.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { applyVerdict, withTask } from '../../lib/interactive/task.mjs'
import { workspaceDigest } from '../../lib/interactive/session.mjs'
import { STOP_REASONS } from '../../lib/hooks/stop.mjs'
import { fixture, hook, layouts, setupProject, taskState } from '../interactive/harness.mjs'

async function ready(env = {}) {
  const p = await setupProject()
  p.env = { ...p.env, ...env }
  await hook('session-start', fixture('session-start', p), p.env)
  await hook('prompt', fixture('user-prompt-submit', p), p.env)
  return p
}

const stopHook = (p, extra = {}) => hook('stop', fixture('stop', p, { extra }), p.env)
const blocked = r => (r.json && r.json.decision === 'block' ? r.json.reason : null)

describe('Stop hook (nudge, the default)', () => {
  it('row 3: changes without a covering verdict nudge once per digest; stop_hook_active is the loop guard', async () => {
    const p = await ready()
    assert.equal((await stopHook(p)).json, null, 'nothing changed yet')
    p.write('README.md', '# edited\n')
    assert.equal(blocked(await stopHook(p, { stop_hook_active: true })), null, 'never inside a stop loop')
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.changes)
    assert.equal(blocked(await stopHook(p)), null, 'once per digest')
    p.write('README.md', '# edited again\n')
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.changes)
    // A current verdict covers the state: no row 3, but row 4 asks to learn.
    const digest = await workspaceDigest(p.repo, { home: p.home })
    await withTask(layouts(p).sl, s => {
      s.task.candidateRoot = p.repo
      applyVerdict(s, { jobId: 'j-1', taskSeq: 1, generation: 1, verdict: 'PASS', reportSha: 'a'.repeat(64), statusDigest: digest })
    })
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.learn)
    assert.equal(blocked(await stopHook(p)), null, 'once per verdict')
    // A stale PASS is treated as "no verdict covers the current state".
    p.write('README.md', '# third edit\n')
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.changes)
  })

  it('rows 1 and 2: a running job and an open learning phase nudge once each', async () => {
    const p = await ready()
    const { sl } = layouts(p)
    await withTask(sl, s => { s.job = { id: 'j-20260101000000-abcdef', pid: process.pid, gen: 1, taskSeq: 1 } })
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.job)
    assert.equal(blocked(await stopHook(p)), null)
    await withTask(sl, s => {
      s.job = null
      s.learning = { episode: 'task-x-1-g1', taskSeq: 1, gen: 1, verdict: 'PASS', stage: 'distill', code: 'abcdef', draftDir: '/tmp/x' }
    })
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.learning)
    assert.equal(blocked(await stopHook(p)), null)
    assert.deepEqual(taskState(p).stop.nudged, ['wait:j-20260101000000-abcdef', 'learning:task-x-1-g1'])
  })

  it('row 4 needs learning mode: a frozen store never asks to learn', async () => {
    const p = await ready()
    const digest = await workspaceDigest(p.repo, { home: p.home })
    await withTask(layouts(p).sl, s => {
      s.task.candidateRoot = p.repo
      applyVerdict(s, { jobId: 'j-1', taskSeq: 1, generation: 1, verdict: 'FAIL', reportSha: 'a'.repeat(64), statusDigest: digest })
    })
    const { pl } = layouts(p)
    mkdirSync(pl.store, { recursive: true })
    writeFileSync(join(pl.store, 'frozen.json'), JSON.stringify({ v: 1, treeHash: 'x', frozenAt: 'now', by: 'test' }))
    assert.equal((await stopHook(p)).json, null)
  })

  it('background tasks: feedback only, never a block; subagents and the off policy are left alone', async () => {
    const p = await ready()
    p.write('README.md', '# changed\n')
    const bg = await stopHook(p, { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] })
    assert.deepEqual(bg.json, { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: STOP_REASONS.changes } })
    assert.equal((await stopHook(p, { agent_id: 'a63db51518b9169b6' })).json, null)
    const off = { ...p, env: { ...p.env, CLAUDE_PLUGIN_OPTION_STOP_POLICY: 'off' } }
    assert.equal((await stopHook(off)).json, null)
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.changes, 'the background notice did not consume the nudge')
  })
})

describe('Stop hook (gate)', () => {
  it('blocks up to stopGateMax per prompt even inside a stop loop, then allows and records the unverified stop', async () => {
    const p = await ready({ CLAUDE_PLUGIN_OPTION_STOP_POLICY: 'gate' })
    p.write('README.md', '# changed\n')
    for (let i = 0; i < 3; i++) assert.equal(blocked(await stopHook(p, { stop_hook_active: i > 0 })), STOP_REASONS.changes, `block ${i + 1}`)
    assert.equal((await stopHook(p, { stop_hook_active: true })).json, null)
    assert.equal(taskState(p).stop.unverifiedStops, 1)
    assert.equal(blocked(await stopHook(p, { prompt_id: 'next-prompt' })), STOP_REASONS.changes, 'a new prompt resets the gate')
  })

  it('row 4 blocks once under gate', async () => {
    const p = await ready({ CLAUDE_PLUGIN_OPTION_STOP_POLICY: 'gate' })
    const digest = await workspaceDigest(p.repo, { home: p.home })
    await withTask(layouts(p).sl, s => {
      s.task.candidateRoot = p.repo
      applyVerdict(s, { jobId: 'j-1', taskSeq: 1, generation: 1, verdict: 'PASS', reportSha: 'a'.repeat(64), statusDigest: digest })
    })
    assert.equal(blocked(await stopHook(p)), STOP_REASONS.learn)
    assert.equal((await stopHook(p, { stop_hook_active: true })).json, null)
  })
})

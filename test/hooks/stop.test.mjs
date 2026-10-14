// SPEC §15.3 WP5 hooks: the Stop policy matrix (§11.9) — each row, the stop_hook_active loop guard,
// the gate cap per prompt, background_tasks, the off policy and subagent stops. A nudge is Stop
// additionalContext (no hook-error notice, cc-integration-7); only the gate blocks. Background hints
// are emitted at most once per row (cc-integration-1). The Stop hook also fills the session model
// from the transcript (cc-integration-3).

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
/** The nudge text of a Stop answer: additionalContext only, never a block (null when silent). */
const nudged = r => {
  if (r.json === null) return null
  assert.equal(r.json.decision, undefined, 'a nudge never blocks')
  assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput'])
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'Stop')
  return r.json.hookSpecificOutput.additionalContext
}

describe('Stop hook (nudge, the default)', () => {
  it('row 3: changes without a covering verdict nudge once per digest; stop_hook_active is the loop guard', async () => {
    const p = await ready()
    assert.equal((await stopHook(p)).json, null, 'nothing changed yet')
    p.write('README.md', '# edited\n')
    assert.equal(nudged(await stopHook(p, { stop_hook_active: true })), null, 'never inside a stop loop')
    assert.equal(nudged(await stopHook(p)), STOP_REASONS.changes)
    assert.equal(nudged(await stopHook(p)), null, 'once per digest')
    p.write('README.md', '# edited again\n')
    assert.equal(nudged(await stopHook(p)), STOP_REASONS.changes)
    // A current verdict covers the state: no row 3, but row 4 asks to learn.
    const digest = await workspaceDigest(p.repo, { home: p.home })
    await withTask(layouts(p).sl, s => {
      s.task.candidateRoot = p.repo
      applyVerdict(s, { jobId: 'j-1', taskSeq: 1, generation: 1, verdict: 'PASS', reportSha: 'a'.repeat(64), statusDigest: digest })
    })
    assert.equal(nudged(await stopHook(p)), STOP_REASONS.learn)
    assert.equal(nudged(await stopHook(p)), null, 'once per verdict')
    // A stale PASS is treated as "no verdict covers the current state".
    p.write('README.md', '# third edit\n')
    assert.equal(nudged(await stopHook(p)), STOP_REASONS.changes)
  })

  it('rows 1 and 2: a running job and an open learning phase nudge once each', async () => {
    const p = await ready()
    const { sl } = layouts(p)
    await withTask(sl, s => { s.job = { id: 'j-20260101000000-abcdef', pid: process.pid, gen: 1, taskSeq: 1 } })
    assert.equal(nudged(await stopHook(p)), STOP_REASONS.job)
    assert.equal(nudged(await stopHook(p)), null)
    await withTask(sl, s => {
      s.job = null
      s.learning = { episode: 'task-x-1-g1', taskSeq: 1, gen: 1, verdict: 'PASS', stage: 'distill', code: 'abcdef', draftDir: '/tmp/x' }
    })
    assert.equal(nudged(await stopHook(p)), STOP_REASONS.learning)
    // The way out when the stage message (and its code) is gone (cc-integration-5).
    assert.match(STOP_REASONS.learning, /call learn to re-show the current stage message and its confirmation code/)
    assert.match(STOP_REASONS.learning, /abandon:true \(no code needed\)/)
    assert.equal(nudged(await stopHook(p)), null)
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

  it('background tasks: one hint per row at most, never a block; subagents and the off policy are left alone', async () => {
    const p = await ready()
    p.write('README.md', '# changed\n')
    const background = { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] }
    const bg = await stopHook(p, background)
    assert.deepEqual(bg.json, { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: STOP_REASONS.changes } })
    // additionalContext continues the conversation: the re-stop it causes is left alone (loop guard) …
    assert.equal((await stopHook(p, { ...background, stop_hook_active: true })).json, null)
    // … and later background stops never repeat the hint (the review's run re-prompted the model 15 times).
    let hints = 0
    for (let i = 0; i < 10; i++) if ((await stopHook(p, { ...background, stop_hook_active: i % 2 === 1 })).json !== null) hints++
    assert.equal(hints, 0)
    assert.ok(taskState(p).stop.nudged.some(k => k.startsWith('bg:changes:')))
    assert.equal((await stopHook(p, { agent_id: 'a63db51518b9169b6' })).json, null)
    const off = { ...p, env: { ...p.env, CLAUDE_PLUGIN_OPTION_STOP_POLICY: 'off' } }
    assert.equal((await stopHook(off)).json, null)
    // Once the background work is done, the normal nudge applies once.
    assert.equal(nudged(await stopHook(p)), STOP_REASONS.changes, 'the background hint did not consume the nudge')
    assert.equal(nudged(await stopHook(p)), null)
  })

  it('a nudge is Stop feedback (additionalContext), never decision:block', async () => {
    const p = await ready()
    p.write('README.md', '# changed\n')
    const r = await stopHook(p)
    assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: STOP_REASONS.changes } })
    assert.equal(blocked(r), null)
  })

  it('records the session model from the transcript when no hook reported one', async () => {
    const p = await ready()
    const { sl } = layouts(p)
    assert.equal(JSON.parse(readFileSync(sl.sessionJson, 'utf8')).model, null)
    const transcript = join(p.home, 'actor-transcript.jsonl')
    writeFileSync(transcript, [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { model: 'claude-haiku-5-5', role: 'assistant', content: [] } },
      { type: 'assistant', isSidechain: true, message: { model: 'claude-opus-5', content: [] } },
      { type: 'assistant', message: { model: '<synthetic>', content: [] } },
      { type: 'last-prompt' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n')
    await stopHook(p, { transcript_path: transcript })
    const session = JSON.parse(readFileSync(sl.sessionJson, 'utf8'))
    assert.equal(session.model, 'claude-haiku-5-5')
    assert.equal(session.modelSource, 'transcript')
    // A model a hook reported (PostModelSwitch) is never overridden by the transcript.
    await hook('model', fixture('post-model-switch', p), p.env)
    await stopHook(p, { transcript_path: transcript })
    assert.equal(JSON.parse(readFileSync(sl.sessionJson, 'utf8')).modelSource, 'model-switch')
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

  it('background tasks: one hint, no block, and the gate count is untouched', async () => {
    const p = await ready({ CLAUDE_PLUGIN_OPTION_STOP_POLICY: 'gate' })
    p.write('README.md', '# changed\n')
    const background = { background_tasks: [{ id: 'b1', type: 'bash', status: 'running' }] }
    assert.equal(nudged(await stopHook(p, background)), STOP_REASONS.changes)
    assert.equal((await stopHook(p, { ...background, stop_hook_active: true })).json, null)
    assert.equal((await stopHook(p, background)).json, null)
    // The gate still has its full budget for the foreground stops.
    for (let i = 0; i < 3; i++) assert.equal(blocked(await stopHook(p, { stop_hook_active: i > 0 })), STOP_REASONS.changes, `block ${i + 1}`)
    assert.equal((await stopHook(p, { stop_hook_active: true })).json, null)
  })
})

// Crash matrix (SPEC §12.1 determinism rules, J2-5, §15.3 WP6 crash-matrix row).
//
// For a reference broad run and a reference deep run, and for every op N of the reference (the
// record at which op N's fn has completed but its `done` record is not yet written; with
// CC_RSI_CRASH_MATRIX=full also every `start` record):
//   (a) the engine throws at op N,
//   (b) the engine (with its whole process group: role children, hooks) is SIGKILLed at op N,
//   (c) SIGKILL at op N and the workspace is mutated before resume (every file in every project
//       root touched, the Curriculum authoring trees deleted),
// then `explore resume` (admitResume → applyResume → engine) runs until the lineage is terminal.
// result.json (minus finished_at, cost_usd and infra_pauses), the canonical memory tree_sha256 and the
// store's episode list must equal the uninterrupted run, and no episode is ever committed twice.
// Plus: the engine group is SIGKILLed in the middle of every role message (the child mid-turn), which
// exercises the recovery note in the same session (R1) or, when the session never started, the
// restart with a new uuid (R3, never R4).
//
// Every engine run is a separate daemon process (as in production), so lanes run in parallel.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { pidAlive, spawnDetached } from '../../lib/core/proc.mjs'
import { admitResume, applyResume } from '../../lib/engine/records.mjs'
import { copyTree, removeTree } from '../../lib/workspace/copy.mjs'
import { create, engineEnv, readJson, REPO_ROOT, storeJournal } from './_engine.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const DAEMON = join(REPO_ROOT, 'lib', 'engine', 'daemon.mjs')
// CC_RSI_CRASH_MATRIX=full also faults at every `start` record and adds a deep reference with a
// Phase-2 practice project; CC_RSI_CRASH_LANES bounds the parallel lanes (default min(4, cpus)).
const FULL = process.env.CC_RSI_CRASH_MATRIX === 'full'
const LANES = Math.max(1, Math.min(Number.parseInt(process.env.CC_RSI_CRASH_LANES ?? '', 10) || 4, cpus().length))
const EXCLUDED = ['finished_at', 'cost_usd', 'infra_pauses']

const REFERENCES = {
  broad: {
    world: { waves: [[{ id: 'alpha', files: { 'input.txt': 'alpha\n' } }]], afterWaves: 'SATURATED' },
    opts: { phase: 'broad', direction: 'tiny text tools' },
  },
  deep: {
    world: { verdicts: { '*': ['FAIL'] }, deepPlan: { 1: ['STALLED'] } },
    opts: { phase: 'deep', target: 'In <PROJECT_ROOT> convert data.csv to JSON.' },
  },
  ...(FULL ? {
    'deep-practice': {
      world: { verdicts: { '*': ['FAIL'] }, deepPlan: { 1: ['PROJECT', 'STALLED'] } },
      opts: { phase: 'deep', target: 'In <PROJECT_ROOT> convert data.csv to JSON.' },
    },
  } : {}),
}

async function waitFor(predicate, { timeoutMs = 90000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await sleep(stepMs)
  }
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

/** One engine daemon run to its exit. `fault` = 'N:throw' | 'N:kill'. Returns the pid. */
async function daemon(lane, { fault, onPid } = {}) {
  const env = { ...lane.e.env }
  if (fault) env.CC_RSI_ENGINE_FAULT = fault
  const pid = spawnDetached(process.execPath, [DAEMON, lane.dir], { cwd: lane.dir, env, logFile: join(lane.dir, 'engine.log') })
  try {
    if (onPid) await onPid(pid)
    await waitFor(() => !pidAlive(pid))
  } finally {
    if (pidAlive(pid)) killGroup(pid)
  }
  return pid
}

/** `explore resume` until the lineage is terminal (result.json exists). */
async function resumeUntilDone(lane) {
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(lane.dir, 'result.json'))) return i
    const admission = await admitResume(lane.dir, { env: lane.e.env, pluginRoot: REPO_ROOT })
    if (!admission.ok) throw new Error(`resume refused: ${admission.reasons.join('; ')}`)
    await applyResume(lane.dir, admission)
    await daemon(lane)
  }
  throw new Error('the lineage did not complete after 8 resumes')
}

function filesUnder(dir) {
  const out = []
  const visit = d => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  visit(dir)
  return out
}

/** Touches every project-root file (content unchanged) and deletes the Curriculum authoring trees. */
async function mutateWorkspace(lane) {
  const layout = lane.e.layout(lane.id)
  const later = new Date(Date.now() + 5000)
  for (const file of filesUnder(layout.projects)) {
    try { utimesSync(file, later, later) } catch { /* vanished */ }
  }
  await removeTree(layout.authoring)
  await removeTree(layout.practiceAuthoring)
}

function normalize(result) {
  const out = { ...result }
  for (const key of EXCLUDED) delete out[key]
  return out
}

async function outcome(lane) {
  const result = readJson(join(lane.dir, 'result.json'))
  const { journal, tree } = await storeJournal(lane.e)
  return { result: normalize(result), tree, episodes: journal.map(c => c.episode) }
}

async function makeLane(name, index) {
  const ref = REFERENCES[name]
  const e = await engineEnv({ world: ref.world })
  const id = `cm-${name}`
  const { dir } = await create(e, { ...ref.opts, id })
  const seed = join(await tmpDir('cc-rsi-seed-'), 'home')
  await copyTree(e.home, seed)
  const lane = { e, id, dir, seed, index }
  lane.restore = async (world = ref.world) => {
    await removeTree(e.home)
    await copyTree(seed, e.home)
    e.fake.reset()
    await removeTree(join(e.fake.fakeHome, 'observations.jsonl'))
    for (const name of readdirSync(e.fake.fakeHome)) if (name.startsWith('once-')) await removeTree(join(e.fake.fakeHome, name))
    e.setWorld(world)
  }
  await daemon(lane)
  lane.reference = await outcome(lane)
  lane.records = readFileSync(join(dir, 'ops.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  return lane
}

async function lanesFor(name) {
  return Promise.all(Array.from({ length: LANES }, (_, i) => makeLane(name, i)))
}

/** Runs `job(lane, item)` over `items` with one lane per worker; returns the failures. */
async function overLanes(lanes, items, job) {
  const failures = []
  let next = 0
  await Promise.all(lanes.map(async lane => {
    while (next < items.length) {
      const item = items[next++]
      try {
        await job(lane, item)
      } catch (error) {
        failures.push(`${JSON.stringify(item)}: ${error?.message ?? error}`)
      }
    }
  }))
  return failures
}

function assertSame(lane, got, label) {
  assert.deepEqual(got.result, lane.reference.result, `${label}: result.json differs`)
  assert.equal(got.tree, lane.reference.tree, `${label}: memory tree differs`)
  assert.deepEqual(got.episodes, lane.reference.episodes, `${label}: episode list differs`)
  assert.equal(new Set(got.episodes).size, got.episodes.length, `${label}: an episode was committed twice`)
}

for (const name of Object.keys(REFERENCES)) {
  describe(`crash matrix: ${name} reference`, () => {
    let lanes
    let points

    it('runs the uninterrupted reference identically in every lane', async () => {
      lanes = await lanesFor(name)
      const ref = lanes[0].reference
      assert.ok(['saturated', 'curriculum_stalled_final_target_test'].includes(ref.result.termination))
      assert.ok(ref.episodes.length >= 1)
      for (const lane of lanes.slice(1)) {
        assert.equal(lane.reference.tree, ref.tree)
        assert.deepEqual(lane.reference.episodes.map(x => x.replace(/^cm-/, '')), ref.episodes.map(x => x.replace(/^cm-/, '')))
        assert.equal(lane.records.length, lanes[0].records.length)
      }
      points = lanes[0].records.filter(r => FULL || r.status === 'done').map(r => r.seq)
      assert.ok(points.length > 10)
    })

    for (const variant of ['throw', 'kill', 'kill+mutate']) {
      it(`(${variant}) at every op, then resume, equals the uninterrupted run`, { timeout: 30 * 60 * 1000 }, async () => {
        assert.ok(lanes, 'reference lanes missing')
        const failures = await overLanes(lanes, points, async (lane, N) => {
          await lane.restore()
          await daemon(lane, { fault: `${N}:${variant === 'throw' ? 'throw' : 'kill'}` })
          if (variant === 'throw') {
            const state = readJson(join(lane.dir, 'state.json'))
            if (!existsSync(join(lane.dir, 'result.json'))) assert.equal(state.status, 'paused_infra', `op ${N}: ${JSON.stringify(state.infra)}`)
          } else if (variant === 'kill+mutate') {
            await mutateWorkspace(lane)
          }
          await resumeUntilDone(lane)
          assertSame(lane, await outcome(lane), `${variant} at record ${N}`)
        })
        assert.deepEqual(failures, [], `${failures.length} of ${points.length} crash points diverged:\n${failures.join('\n')}`)
      })
    }

    it('SIGKILL in the middle of every role message (child mid-turn), then resume, equals the uninterrupted run', { timeout: 30 * 60 * 1000 }, async () => {
      assert.ok(lanes, 'reference lanes missing')
      const world = { ...REFERENCES[name].world, delayMs: 400 }
      const sends = lanes[0].records.filter(r => r.kind === 'send' && r.status === 'done').length
      const ks = Array.from({ length: sends }, (_, i) => i + 1)
      const failures = await overLanes(lanes, ks, async (lane, k) => {
        await lane.restore(world)
        await daemon(lane, {
          onPid: async pid => {
            // Wait until the k-th fake claude invocation has started, then kill the whole group.
            await waitFor(() => !pidAlive(pid) || invocationCount(lane) >= k)
            await sleep(150)
            killGroup(pid)
          },
        })
        lane.e.setWorld(REFERENCES[name].world)
        await resumeUntilDone(lane)
        assertSame(lane, await outcome(lane), `mid-message kill at invocation ${k}`)
      })
      assert.deepEqual(failures, [], `${failures.length} of ${ks.length} mid-message kills diverged:\n${failures.join('\n')}`)
    })
  })
}

/** Number of role invocations started so far (invocation dirs with a meta.json). */
function invocationCount(lane) {
  let n = 0
  const ctx = join(lane.dir, 'ctx')
  let contexts = []
  try { contexts = readdirSync(ctx) } catch { return 0 }
  for (const c of contexts) {
    let entries = []
    try { entries = readdirSync(join(ctx, c)) } catch { continue }
    for (const entry of entries) if (/^\d+$/.test(entry) && existsSync(join(ctx, c, entry, 'meta.json'))) n++
  }
  return n
}

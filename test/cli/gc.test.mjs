// `cc-rsi gc` (SPEC §13.6): removes old attestations, the derived state of long-ended sessions,
// Verifier scratch of finished tasks, work trees (and with --streams the streams) of terminal
// lineages — and never a record, nor anything a live job or a restore-failed lock may need.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gcFs } from '../../lib/cli/gc.mjs'
import { main } from '../../lib/cli/main.mjs'
import { globalLayout, projectKey, projectLayout } from '../../lib/core/paths.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const DAY = 24 * 3600 * 1000

function touch(path, content = 'x', ageMs = 0) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs)
    utimesSync(path, t, t)
  }
}

function age(path, ageMs) {
  const t = new Date(Date.now() - ageMs)
  utimesSync(path, t, t)
}

async function setup() {
  const { home, env } = await tmpHome()
  for (const name of Object.keys(env)) if (name.startsWith('CC_RSI_') || name.startsWith('CLAUDE_PLUGIN_')) delete env[name]
  env.CC_RSI_HOME = home
  env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
  const g = globalLayout(home)
  const pl = projectLayout(home, 'proj-0123456789ab')
  const cwd = await tmpDir()
  const run = async (argv, { at = cwd } = {}) => {
    const out = []
    const code = await main(argv, { stdout: { write: s => out.push(s), isTTY: false }, stderr: { write: s => out.push(s) }, env, cwd: at, isTTY: false })
    return { code, stdout: out.join('') }
  }
  return { home, env, g, pl, run }
}

/** A session that never recorded SessionEnd (killed or crashed), last seen `daysAgo` days ago. */
function silentSession(s, sid, daysAgo, pl = s.pl) {
  const dir = join(pl.sessions, sid)
  const ageMs = daysAgo * DAY
  touch(join(dir, 'session.json'), JSON.stringify({ v: 1, sessionId: sid, endedAt: null, lastSeen: new Date(Date.now() - ageMs).toISOString() }), ageMs)
  touch(join(dir, 'task.json'), JSON.stringify({ v: 1, task: null, job: null }), ageMs)
  touch(join(dir, 'requests.jsonl'), '{"seq":1}\n', ageMs)
  touch(join(dir, 'checkpoints', 'j-1', 'entries.json'), '{}')
  touch(join(dir, 'ctx', 'task-1-v1', '1', 'stream.jsonl'), '{}')
  touch(join(pl.views, sid, 'memory', 'a.md'), 'm')
  return dir
}

/** An ended session with derived state; returns its paths. */
function endedSession(s, sid, endedDaysAgo, { taskVerifier = null, closed = true } = {}) {
  const dir = join(s.pl.sessions, sid)
  touch(join(dir, 'session.json'), JSON.stringify({ v: 1, sessionId: sid, endedAt: new Date(Date.now() - endedDaysAgo * DAY).toISOString() }))
  touch(join(dir, 'task.json'), JSON.stringify({ v: 1, task: taskVerifier ? { seq: 1, closed, verifier: { sessionId: taskVerifier, lastUsed: new Date(Date.now() - 30 * DAY).toISOString(), retired: false } } : null, job: null }))
  touch(join(dir, 'verdicts.jsonl'), '{"verdict":"PASS"}\n')
  touch(join(dir, 'requests.jsonl'), '{"seq":1}\n')
  touch(join(dir, 'checkpoints', 'j-1', 'entries.json'), '{}')
  touch(join(dir, 'displaced', 'j-1', 'a.txt'), 'old')
  touch(join(dir, 'ctx', 'task-1-v1', '1', 'stream.jsonl'), '{}')
  touch(join(dir, 'ctx', 'task-1-v1', 'sessions', 'v.json'), '{}')
  touch(join(s.pl.views, sid, 'memory', 'a.md'), 'm')
  return dir
}

describe('cc-rsi gc', () => {
  it('removes derived state and keeps every record', async () => {
    const s = await setup()
    // Attestations.
    touch(join(s.g.att, 'toolu_old.json'), '{}', 2 * 3600 * 1000)
    touch(join(s.g.att, 'toolu_new.json'), '{}')
    // Sessions: one ended 20 days ago (cleaned), one 2 days ago (kept), one old but locked (kept).
    const oldDir = endedSession(s, 'sess-old', 20, { taskVerifier: 'vsess-closed' })
    const recentDir = endedSession(s, 'sess-recent', 2, { taskVerifier: 'vsess-open', closed: false })
    const lockedDir = endedSession(s, 'sess-locked', 20)
    touch(join(s.g.locks, 'aaaaaaaaaaaaaaaaaaaaaaaa.json'), JSON.stringify({ pid: 2147483646, host: hostname(), token: 't', at: 'x', owner: { root: '/r', jobId: 'j-9', sessionId: 'sess-locked', restoreFailed: true } }), 3600 * 1000)
    // A dead job's checkpoint-open lock (memory-crash-2): its recovery still needs the session.
    const pendingDir = endedSession(s, 'sess-pending', 20)
    touch(join(s.g.locks, 'bbbbbbbbbbbbbbbbbbbbbbbb.json'), JSON.stringify({ pid: 2147483646, host: hostname(), token: 't', at: 'x', owner: { root: '/r2', jobId: 'j-8', sessionId: 'sess-pending', restoreFailed: false, checkpointOpen: true } }), 3600 * 1000)
    // Verifier scratch: of a closed task (old), of an open task, unreferenced old, unreferenced recent.
    for (const v of ['vsess-closed', 'vsess-open', 'vsess-orphan', 'vsess-fresh']) mkdirSync(join(s.g.vscratch, v, 'tmp'), { recursive: true })
    for (const v of ['vsess-closed', 'vsess-open', 'vsess-orphan']) age(join(s.g.vscratch, v), 30 * DAY)
    // Lineages: a completed one (work tree removed; stream removed with --streams) and a paused one.
    const done = join(s.pl.lineages, 'deep-done')
    touch(join(done, 'state.json'), JSON.stringify({ status: 'completed' }))
    touch(join(done, 'result.json'), JSON.stringify({ termination: 'verifier_pass' }))
    touch(join(done, 'ctx', 't001_actor_0', '1', 'stream.jsonl'), '{}')
    touch(join(done, 'ctx', 't001_actor_0', '1', 'meta.json'), '{}')
    touch(join(s.pl.work, 'deep-done', 'projects', 't001', 'f.txt'), 'w')
    const paused = join(s.pl.lineages, 'broad-paused')
    touch(join(paused, 'state.json'), JSON.stringify({ status: 'paused_infra' }))
    touch(join(s.pl.work, 'broad-paused', 'projects', 'w001-a', 'f.txt'), 'w')

    const dry = await s.run(['gc', '--dry-run', '--streams'])
    assert.equal(dry.code, 0)
    assert.match(dry.stdout, /would remove .*toolu_old\.json/)
    assert.ok(existsSync(join(s.g.att, 'toolu_old.json')), 'dry run removes nothing')
    assert.ok(existsSync(join(oldDir, 'checkpoints')))

    const r = await s.run(['gc', '--streams'])
    assert.equal(r.code, 0, r.stdout)
    assert.equal(existsSync(join(s.g.att, 'toolu_old.json')), false)
    assert.ok(existsSync(join(s.g.att, 'toolu_new.json')))
    for (const gone of [join(oldDir, 'checkpoints'), join(oldDir, 'displaced'), join(oldDir, 'ctx', 'task-1-v1', '1'), join(s.pl.views, 'sess-old')]) {
      assert.equal(existsSync(gone), false, gone)
    }
    for (const kept of ['session.json', 'task.json', 'verdicts.jsonl', 'requests.jsonl', join('ctx', 'task-1-v1', 'sessions', 'v.json')]) {
      assert.ok(existsSync(join(oldDir, kept)), kept)
    }
    assert.ok(existsSync(join(recentDir, 'checkpoints')), 'a recently ended session is kept')
    assert.ok(existsSync(join(lockedDir, 'displaced', 'j-1')), 'displaced copies of a restore-failed lock are kept')
    assert.match(r.stdout, /kept .*sess-locked/)
    assert.ok(existsSync(join(pendingDir, 'checkpoints')), 'the checkpoint a pending recovery restores is kept')
    assert.equal(existsSync(join(s.g.vscratch, 'vsess-closed')), false)
    assert.equal(existsSync(join(s.g.vscratch, 'vsess-orphan')), false)
    assert.ok(existsSync(join(s.g.vscratch, 'vsess-open')), 'scratch of an open task is kept')
    assert.ok(existsSync(join(s.g.vscratch, 'vsess-fresh')), 'recent scratch is kept')
    assert.equal(existsSync(join(s.pl.work, 'deep-done')), false)
    assert.ok(existsSync(join(s.pl.work, 'broad-paused')), 'a paused lineage keeps its work tree')
    assert.equal(existsSync(join(done, 'ctx', 't001_actor_0', '1', 'stream.jsonl')), false)
    assert.ok(existsSync(join(done, 'ctx', 't001_actor_0', '1', 'meta.json')))
    assert.ok(existsSync(join(done, 'result.json')))
    assert.match(r.stdout, /records \(task\.json, verdicts, journals, results, reports, evaluations\) are never deleted/)
  })

  it('honours --older-than and refuses bad values', async () => {
    const s = await setup()
    const dir = endedSession(s, 'sess-5', 5)
    await s.run(['gc'])
    assert.ok(existsSync(join(dir, 'checkpoints')))
    await s.run(['gc', '--older-than', '3'])
    assert.equal(existsSync(join(dir, 'checkpoints')), false)
    assert.equal((await s.run(['gc', '--older-than', 'soon'])).code, 2)
  })

  it('reclaims sessions that never recorded SessionEnd once they are inactive (portability-8)', async () => {
    const s = await setup()
    const crashed = silentSession(s, 'sess-crashed', 20)
    const active = silentSession(s, 'sess-active', 1)
    const r = await s.run(['gc'])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /memory view of a session inactive for 20 days, no SessionEnd recorded/)
    for (const gone of [join(crashed, 'checkpoints'), join(crashed, 'ctx', 'task-1-v1', '1'), join(s.pl.views, 'sess-crashed')]) assert.equal(existsSync(gone), false, gone)
    for (const kept of ['session.json', 'task.json', 'requests.jsonl']) assert.ok(existsSync(join(crashed, kept)), kept)
    for (const kept of [join(active, 'checkpoints'), join(s.pl.views, 'sess-active')]) assert.ok(existsSync(kept), kept)
    // A recent prompt (requests.jsonl) keeps a session whose lastSeen is old.
    const prompted = silentSession(s, 'sess-prompted', 20)
    touch(join(prompted, 'requests.jsonl'), '{"seq":2}\n')
    await s.run(['gc'])
    assert.ok(existsSync(join(prompted, 'checkpoints')))
  })

  it('reports a path it cannot remove, continues with the rest and exits 1 (portability-9)', async () => {
    const s = await setup()
    for (const id of ['done-a', 'done-b']) {
      touch(join(s.pl.lineages, id, 'state.json'), JSON.stringify({ status: 'completed' }))
      touch(join(s.pl.lineages, id, 'result.json'), '{}')
      touch(join(s.pl.work, id, 'projects', 'p1', 'f.txt'), 'w')
    }
    mkdirSync(join(s.g.vscratch, 'vsess-orphan'), { recursive: true })
    age(join(s.g.vscratch, 'vsess-orphan'), 30 * DAY)
    const original = gcFs.removeTree
    gcFs.removeTree = async path => {
      if (path === join(s.pl.work, 'done-a')) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${path}/projects/p1/f.txt'`), { code: 'EPERM' })
      return original(path)
    }
    try {
      const r = await s.run(['gc'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stdout, /could not remove .*done-a \(EPERM: /)
      assert.match(r.stdout, /1 path\(s\) could not be removed/)
    } finally {
      gcFs.removeTree = original
    }
    assert.ok(existsSync(join(s.pl.work, 'done-a')))
    assert.equal(existsSync(join(s.pl.work, 'done-b')), false, 'the next lineage is still collected')
    assert.equal(existsSync(join(s.g.vscratch, 'vsess-orphan')), false, 'Verifier scratch is still collected')
  })

  it('--project and --session restrict gc to that project and session (portability-12)', async () => {
    const s = await setup()
    const repoA = await gitRepo({ 'a.txt': 'a\n' })
    const plA = projectLayout(s.home, projectKey(await gitProjectRoot(repoA)))
    const a1 = endedSession({ ...s, pl: plA }, 'sess-a1', 20)
    const a2 = endedSession({ ...s, pl: plA }, 'sess-a2', 20)
    const b = endedSession(s, 'sess-b', 20)
    touch(join(s.g.att, 'toolu_old.json'), '{}', 2 * 3600 * 1000)
    const one = await s.run(['gc', '--project', repoA, '--session', 'sess-a1'])
    assert.equal(one.code, 0, one.stdout)
    assert.equal(existsSync(join(a1, 'checkpoints')), false)
    assert.ok(existsSync(join(a2, 'checkpoints')), 'another session of the project is kept')
    assert.ok(existsSync(join(b, 'checkpoints')), 'another project is kept')
    assert.ok(existsSync(join(s.g.att, 'toolu_old.json')), 'a scoped run skips the global sweeps')
    const project = await s.run(['gc', '--project', repoA])
    assert.equal(project.code, 0, project.stdout)
    assert.equal(existsSync(join(a2, 'checkpoints')), false)
    assert.ok(existsSync(join(b, 'checkpoints')))
    assert.match(project.stdout, /in project /)
    // An unrelated directory is a project with nothing to collect.
    const unrelated = await s.run(['gc', '--project', await tmpDir()])
    assert.equal(unrelated.code, 0)
    assert.ok(existsSync(join(b, 'checkpoints')))
  })
})

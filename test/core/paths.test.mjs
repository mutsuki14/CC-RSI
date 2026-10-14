// Layouts (SPEC §4, §5.1).

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { sha256Hex } from '../../lib/core/digest.mjs'
import { CcRsiError } from '../../lib/core/errors.mjs'
import {
  ccRsiHome, globalLayout, isUnderLexical, lineageLayout, projectKey, projectLayout, safeName, sessionLayout,
} from '../../lib/core/paths.mjs'

describe('paths', () => {
  it('ccRsiHome honours CC_RSI_HOME (resolved) and defaults to ~/.cc-rsi', () => {
    assert.equal(ccRsiHome({ CC_RSI_HOME: '/tmp/x/../h' }), '/tmp/h')
    assert.equal(ccRsiHome({ CC_RSI_HOME: '' }), join(homedir(), '.cc-rsi'))
    assert.equal(ccRsiHome({}), join(homedir(), '.cc-rsi'))
  })

  it('globalLayout', () => {
    const g = globalLayout('/h')
    assert.deepEqual(
      [g.home, g.gitignore, g.config, g.probe, g.bin, g.binShim, g.logs, g.hooksLog, g.mcpLog, g.cliLog, g.jobsLog],
      ['/h', '/h/.gitignore', '/h/config.json', '/h/probe.json', '/h/bin', '/h/bin/cc-rsi', '/h/logs', '/h/logs/hooks.log', '/h/logs/mcp.log', '/h/logs/cli.log', '/h/logs/jobs.log'],
    )
    assert.deepEqual(
      [g.run, g.att, g.locks, g.settings, g.prompts, g.policies, g.vscratch, g.work, g.projects, g.runSessions],
      ['/h/run', '/h/run/att', '/h/run/locks', '/h/run/settings', '/h/run/prompts', '/h/run/policies', '/h/vscratch', '/h/work', '/h/projects', '/h/run/sessions'],
    )
  })

  it('projectKey = safeBase(basename) + "-" + sha256(root)[0:12]', () => {
    assert.equal(projectKey('/home/u/my project!'), `my_project_-${sha256Hex('/home/u/my project!').slice(0, 12)}`)
    const long = `/x/${'a'.repeat(60)}`
    assert.equal(projectKey(long), `${'a'.repeat(40)}-${sha256Hex(long).slice(0, 12)}`)
    assert.equal(projectKey('/srv/科学'), `__-${sha256Hex('/srv/科学').slice(0, 12)}`)
  })

  it('projectLayout and the storeDir override', () => {
    const p = projectLayout('/h', 'k-1')
    assert.deepEqual(p, {
      dir: '/h/projects/k-1', projectJson: '/h/projects/k-1/project.json', store: '/h/projects/k-1/store',
      sessions: '/h/projects/k-1/sessions', views: '/h/projects/k-1/views', drafts: '/h/projects/k-1/drafts',
      lineages: '/h/projects/k-1/lineages', sealed: '/h/projects/k-1/sealed', work: '/h/work/k-1',
    })
    assert.equal(projectLayout('/h', 'k-1', { storeDir: '/global/mem' }).store, '/global/mem')
    assert.equal(projectLayout('/h', 'k-1', { storeDir: '' }).store, '/h/projects/k-1/store')
    // A relative store dir is never resolved against the process cwd (r2-overblock-1).
    assert.equal(projectLayout('/h', 'k-1', { storeDir: 'rsi-memory' }).store, '/h/projects/k-1/store')
    assert.equal(projectLayout('/h', 'k-1', { storeDir: '~/rsi-memory' }).store, '/h/projects/k-1/store')
  })

  it('sessionLayout', () => {
    const s = sessionLayout(projectLayout('/h', 'k'), 'sid-1')
    assert.equal(s.dir, '/h/projects/k/sessions/sid-1')
    assert.equal(s.sessionJson, '/h/projects/k/sessions/sid-1/session.json')
    assert.equal(s.requests, '/h/projects/k/sessions/sid-1/requests.jsonl')
    assert.equal(s.task, '/h/projects/k/sessions/sid-1/task.json')
    assert.equal(s.lock, '/h/projects/k/sessions/sid-1/.lock')
    assert.equal(s.verdicts, '/h/projects/k/sessions/sid-1/verdicts.jsonl')
    for (const key of ['jobs', 'checkpoints', 'manifests', 'displaced', 'baselines', 'ctx']) assert.equal(s[key], `/h/projects/k/sessions/sid-1/${key}`)
    assert.equal(s.viewDir, '/h/projects/k/views/sid-1/memory')
    assert.equal(s.viewJson, '/h/projects/k/views/sid-1/view.json')
    assert.equal(sessionLayout(projectLayout('/h', 'k'), '../evil').dir, '/h/projects/k/sessions/.._evil')
  })

  it('lineageLayout', () => {
    const l = lineageLayout(projectLayout('/h', 'k'), 'deep-1')
    const D = '/h/projects/k/lineages/deep-1'
    const W = '/h/work/k/deep-1'
    assert.deepEqual(
      [l.dir, l.lineageJson, l.stateJson, l.ops, l.blobs, l.events, l.result, l.engineLock, l.engineLog, l.ctx, l.priv, l.promptsSnapshot],
      [D, `${D}/lineage.json`, `${D}/state.json`, `${D}/ops.jsonl`, `${D}/blobs`, `${D}/events.jsonl`, `${D}/result.json`, `${D}/engine.lock`, `${D}/engine.log`, `${D}/ctx`, `${D}/priv`, `${D}/prompts`],
    )
    assert.equal(l.W, W)
    assert.equal(l.curriculum, `${W}/curriculum-private`)
    assert.equal(l.curriculumMemory, `${W}/curriculum-private/memory`)
    assert.equal(l.authoring, `${W}/curriculum-private/authoring`)
    assert.equal(l.practiceAuthoring, `${W}/curriculum-private/practice/authoring`)
    assert.equal(l.notes, `${W}/curriculum-private/notes.md`)
    assert.equal(l.actorMemory('w001-a'), `${W}/actor-private/w001-a/memory`)
    assert.equal(l.projectRoot('t001'), `${W}/projects/t001`)
    assert.equal(l.verifyCandidate('p002'), `${W}/verify/p002/candidate`)
    assert.equal(l.verifyOriginal('p002'), `${W}/verify/p002/original`)
    assert.equal(l.verifyScratch('t001-1'), `${W}/verify-scratch/t001-1`)
    assert.equal(l.summarizer, `${W}/summarizer`)
    assert.throws(() => l.projectRoot('../x'), CcRsiError)
    assert.throws(() => l.actorMemory('..'), CcRsiError)
    assert.throws(() => lineageLayout(projectLayout('/h', 'k'), 'a/b'), CcRsiError)
  })

  it('safeName', () => {
    assert.equal(safeName('task-ab12-3-g1'), 'task-ab12-3-g1')
    assert.equal(safeName('a b/c:d'), 'a_b_c_d')
    const long = 'x'.repeat(130)
    assert.equal(safeName(long), `${'x'.repeat(111)}-${sha256Hex(long).slice(0, 8)}`)
    assert.equal(safeName(long).length, 120)
    assert.equal(safeName('y'.repeat(120)), 'y'.repeat(120))
    assert.equal(safeName(''), '_')
    assert.equal(safeName('.'), '_.')
    assert.equal(safeName('..'), '_..')
  })

  it('isUnderLexical', () => {
    assert.equal(isUnderLexical('/a/b', '/a'), true)
    assert.equal(isUnderLexical('/a', '/a'), true)
    assert.equal(isUnderLexical('/a/../b', '/a'), false)
    assert.equal(isUnderLexical('/ab', '/a'), false)
    assert.equal(isUnderLexical('/anything', '/'), true)
  })
})

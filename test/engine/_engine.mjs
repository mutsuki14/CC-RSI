// Shared setup for engine tests: a temp CC_RSI_HOME, the fake claude driven by the "world"
// scenario, a temp project, a hermetic environment (CLAUDE_CONFIG_DIR in a temp dir, so nothing reads
// the real ~/.claude), and readers for lineage records. Not a test file (no .test.mjs suffix).

import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonl } from '../../lib/core/jsonl.mjs'
import { lineageLayout, projectKey, projectLayout } from '../../lib/core/paths.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { createLineage } from '../../lib/engine/records.mjs'
import { runEngine } from '../../lib/engine/daemon.mjs'
import { fakeClaude } from '../_helpers/fake.mjs'
import { tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')
export const WORLD = join(HERE, 'scenarios', 'world.mjs')

function merge(base, extra) {
  const out = { ...base }
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v
  }
  return out
}

/**
 * A complete engine test environment. `config` is merged into `<home>/config.json` (the global
 * config) on top of the fake claude binary and test-friendly defaults; `world` is the scenario
 * data. Returns { home, env, fake, projectRoot, setWorld(world), observations(), lineageDir(id) }.
 */
export async function engineEnv({ world = {}, config = {}, files = { 'README.md': 'project\n' } } = {}) {
  const { home } = await tmpHome()
  const fake = await fakeClaude({ scenario: WORLD, home })
  const claudeConfig = await tmpDir('cc-rsi-claude-config-')
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig }
  for (const name of Object.keys(env)) if (name.startsWith('CC_RSI_') || name === 'ANTHROPIC_MODEL') delete env[name]
  delete env.CLAUDECODE
  const projectRoot = await tmpDir('cc-rsi-project-')
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(projectRoot, rel)), { recursive: true })
    await writeFile(join(projectRoot, rel), content)
  }
  const globalConfig = merge({
    children: { claudeBin: fake.bin },
    isolation: { allowUnconfined: true },
    models: { actor: 'actor-model', verifier: 'verifier-model', curriculum: 'curriculum-model' },
    transport: { pauseSecs: 0, pauseMaxSecs: 0 },
  }, config)
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(globalConfig, null, 2)}\n`)
  const setWorld = w => writeFileSync(join(fake.fakeHome, 'world.json'), `${JSON.stringify(w, null, 2)}\n`)
  setWorld(world)
  const pl = projectLayout(home, projectKey(projectRoot))
  return {
    home,
    env,
    fake,
    projectRoot,
    pl,
    setWorld,
    observations: () => readJsonlSync(join(fake.fakeHome, 'observations.jsonl')),
    lineageDir: id => lineageLayout(pl, id).dir,
    layout: id => lineageLayout(pl, id),
  }
}

function readJsonlSync(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** createLineage without spawning (the test runs the engine in-process). */
export async function create(e, opts) {
  return createLineage({
    home: e.home,
    projectRoot: e.projectRoot,
    allowUnconfined: true,
    skipAuthProbe: true,
    spawn: false,
    pluginRoot: REPO_ROOT,
    env: e.env,
    ...opts,
  })
}

/** runEngine in-process with the hermetic env. */
export async function run(e, dir, opts = {}) {
  return runEngine(dir, { env: e.env, pluginRoot: REPO_ROOT, ...opts })
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export async function events(dir) {
  return readJsonl(join(dir, 'events.jsonl'))
}

export async function protocolEvents(dir) {
  return (await events(dir)).filter(e => !e.runtime)
}

/** The memory store journal of the environment's project. */
export async function storeJournal(e) {
  const store = await MemoryStore.open(e.pl.store, { sessionsDir: e.pl.sessions, lineagesDir: e.pl.lineages })
  try {
    return { journal: await store.journal(), tree: await store.treeHash(), store }
  } finally {
    await store.close()
  }
}

/** Fake-claude invocations of one role (from the fake's log). */
export function invocations(e, role) {
  return e.fake.log().filter(entry => entry.ccRsi?.CC_RSI_ROLE === role)
}

/** The value following `flag` in an argv. */
export function flagValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

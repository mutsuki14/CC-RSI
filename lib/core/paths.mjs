// Home, project, session and lineage layouts (SPEC §4, §5.1). Pure functions: nothing here
// touches the filesystem.

import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { sha256Hex } from './digest.mjs'
import { CcRsiError } from './errors.mjs'

/** `resolve($CC_RSI_HOME)` when set and non-empty, else `~/.cc-rsi`. */
export function ccRsiHome(env = process.env) {
  const configured = env?.CC_RSI_HOME
  return typeof configured === 'string' && configured !== '' ? resolve(configured) : join(homedir(), '.cc-rsi')
}

/** Global layout under `<home>` (SPEC §4.1). `runSessions` is the per-session project cache dir (§11.1). */
export function globalLayout(home) {
  const logs = join(home, 'logs')
  const run = join(home, 'run')
  const bin = join(home, 'bin')
  return {
    home,
    gitignore: join(home, '.gitignore'),
    config: join(home, 'config.json'),
    probe: join(home, 'probe.json'),
    bin,
    binShim: join(bin, 'cc-rsi'),
    logs,
    hooksLog: join(logs, 'hooks.log'),
    mcpLog: join(logs, 'mcp.log'),
    cliLog: join(logs, 'cli.log'),
    jobsLog: join(logs, 'jobs.log'),
    run,
    att: join(run, 'att'),
    locks: join(run, 'locks'),
    settings: join(run, 'settings'),
    prompts: join(run, 'prompts'),
    policies: join(run, 'policies'),
    runSessions: join(run, 'sessions'),
    vscratch: join(home, 'vscratch'),
    work: join(home, 'work'),
    projects: join(home, 'projects'),
  }
}

const UNSAFE = /[^A-Za-z0-9._-]/g

/**
 * `safeBase(basename(root)) + '-' + sha256(root).slice(0, 12)`, where safeBase replaces
 * `[^A-Za-z0-9._-]` with '_' and truncates to 40 chars (SPEC §4.1).
 */
export function projectKey(root) {
  const base = basename(root).replace(UNSAFE, '_').slice(0, 40)
  return `${base}-${sha256Hex(root).slice(0, 12)}`
}

/**
 * A single safe path segment: `[^A-Za-z0-9._-]` → '_'; longer than 120 chars → first 111
 * + '-' + sha256(s).slice(0, 8). The degenerate segments '', '.' and '..' map to '_', '_.'
 * and '_..' so a safe name can never address the current or parent directory.
 */
export function safeName(s) {
  const text = String(s)
  let out = text.replace(UNSAFE, '_')
  if (out.length > 120) out = `${out.slice(0, 111)}-${sha256Hex(text).slice(0, 8)}`
  if (out === '') return '_'
  if (out === '.' || out === '..') return `_${out}`
  return out
}

/** Whether `child` is `parent` or lies under it, after `path.resolve` of both (no symlink resolution). */
export function isUnderLexical(child, parent) {
  const c = resolve(child)
  const p = resolve(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Per-project layout `<P>` = `<home>/projects/<key>` (SPEC §4.2). */
export function projectLayout(home, key, { storeDir } = {}) {
  const dir = join(home, 'projects', key)
  return {
    dir,
    projectJson: join(dir, 'project.json'),
    store: storeDir ? resolve(storeDir) : join(dir, 'store'),
    sessions: join(dir, 'sessions'),
    views: join(dir, 'views'),
    drafts: join(dir, 'drafts'),
    lineages: join(dir, 'lineages'),
    sealed: join(dir, 'sealed'),
    work: join(home, 'work', key),
  }
}

/** Per-session layout under `<P>/sessions/<sid>` (SPEC §4.2). `sid` passes through `safeName` (identity for uuids). */
export function sessionLayout(pl, sid) {
  const name = safeName(sid)
  const dir = join(pl.sessions, name)
  return {
    dir,
    sessionJson: join(dir, 'session.json'),
    requests: join(dir, 'requests.jsonl'),
    task: join(dir, 'task.json'),
    lock: join(dir, '.lock'),
    jobs: join(dir, 'jobs'),
    checkpoints: join(dir, 'checkpoints'),
    manifests: join(dir, 'manifests'),
    displaced: join(dir, 'displaced'),
    baselines: join(dir, 'baselines'),
    verdicts: join(dir, 'verdicts.jsonl'),
    ctx: join(dir, 'ctx'),
    viewDir: join(pl.views, name, 'memory'),
    viewJson: join(pl.views, name, 'view.json'),
  }
}

/** Refuses a harness-generated segment that could escape its parent directory. */
function segment(value, what) {
  const text = String(value)
  if (text === '' || text === '.' || text === '..' || text.includes('/') || text.includes('\\') || text.includes('\0')) {
    throw new CcRsiError('unsafe_name', `unsafe ${what}: ${JSON.stringify(text)}`, { value: text })
  }
  return text
}

/**
 * Lineage records `<P>/lineages/<id>` (SPEC §12.3) and its role-visible work tree
 * `<W>` = `<home>/work/<key>/<id>` (SPEC §4.3).
 */
export function lineageLayout(pl, id) {
  const name = segment(id, 'lineage id')
  const dir = join(pl.lineages, name)
  const W = join(pl.work, name)
  const curriculum = join(W, 'curriculum-private')
  return {
    dir,
    lineageJson: join(dir, 'lineage.json'),
    stateJson: join(dir, 'state.json'),
    ops: join(dir, 'ops.jsonl'),
    blobs: join(dir, 'blobs'),
    events: join(dir, 'events.jsonl'),
    result: join(dir, 'result.json'),
    engineLock: join(dir, 'engine.lock'),
    engineLog: join(dir, 'engine.log'),
    ctx: join(dir, 'ctx'),
    priv: join(dir, 'priv'),
    promptsSnapshot: join(dir, 'prompts'),
    sealedJson: join(dir, 'sealed.json'),
    W,
    curriculum,
    curriculumMemory: join(curriculum, 'memory'),
    authoring: join(curriculum, 'authoring'),
    practiceAuthoring: join(curriculum, 'practice', 'authoring'),
    notes: join(curriculum, 'notes.md'),
    actorPrivate: join(W, 'actor-private'),
    projects: join(W, 'projects'),
    verify: join(W, 'verify'),
    verifyScratchRoot: join(W, 'verify-scratch'),
    actorMemory: ep => join(W, 'actor-private', segment(ep, 'episode'), 'memory'),
    projectRoot: ep => join(W, 'projects', segment(ep, 'episode')),
    verifyCandidate: ep => join(W, 'verify', segment(ep, 'episode'), 'candidate'),
    verifyOriginal: ep => join(W, 'verify', segment(ep, 'episode'), 'original'),
    verifyScratch: n => join(W, 'verify-scratch', segment(n, 'scratch name')),
    summarizer: join(W, 'summarizer'),
  }
}

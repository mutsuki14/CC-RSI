// Harness-side git that never runs repository-planted programs (SPEC §9.2).
// Port of dsh-rsi `host/git.ts` (SAFE flags :15-20, env :23, driverOverrides :38-77,
// workspaceState :105-121) plus statusDigest, projectRoot via --git-common-dir, lsFiles and
// initInertRepo (dsh `host/stores.ts:108-118`).
//
// The Actor (or a Verifier in rollback mode) can write `.git/config`, `.git/hooks` and
// `.gitattributes`, so every invocation disables fsmonitor and hooks, drops the untracked cache and
// external diff, and neutralizes every filter and diff driver the repository defines. System and
// global configuration belong to the user and the administrator (a role cannot write them), so
// their settings — line endings, LFS, safe.directory — still apply.
//
// Hooks import this module: it must stay cheap to load (node:* and lib/core only).

import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { sha256Hex } from '../core/digest.mjs'
import { CcRsiError } from '../core/errors.mjs'

const SAFE = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.untrackedCache=false',
  '-c', 'diff.external=',
  // cc-rsi additions: in a partial clone, status/diff may lazily fetch missing objects, which runs a
  // repository-configured transport (core.sshCommand, ext::, remote helpers). No transport is allowed,
  // and signature display (gpg.program) is off.
  '-c', 'protocol.allow=never',
  ...['file', 'git', 'ssh', 'http', 'https', 'ext'].flatMap(name => ['-c', `protocol.${name}.allow=never`]),
  '-c', 'log.showSignature=false',
]

/** Configuration scopes a role can never write (dsh git.ts:26). */
const TRUSTED_SCOPES = new Set(['global', 'system'])

/** Driver keys that name a program, or that make a missing program fatal (dsh git.ts:38). */
const DRIVER_KEY = /^(filter|diff)\.(.+)\.(clean|smudge|process|required|command|textconv|cachetextconv)$/i

/** Variables that would point git at another repository, work tree or index. */
const REDIRECT_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
]

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BUFFER = 32 * 2 ** 20

/** Built per call, so a changed environment (e.g. GIT_CONFIG_SYSTEM) takes effect (dsh git.ts:22-23). */
function gitEnv() {
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_PROTOCOL_FROM_USER: '0',
  }
  for (const name of REDIRECT_ENV) delete env[name]
  return env
}

/**
 * One git process: `{ ok, code, stdout, stderr }`. Never rejects. A spawn failure (git missing, cwd
 * missing), a timeout or an oversized output is `ok:false`.
 */
function runGit(cwd, args, { timeoutMs, maxBuffer }) {
  return new Promise(resolvePromise => {
    if (!(timeoutMs > 0)) {
      resolvePromise({ ok: false, code: null, stdout: '', stderr: 'timed out' })
      return
    }
    let child
    try {
      child = execFile('git', args, {
        cwd, env: gitEnv(), timeout: Math.ceil(timeoutMs), killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8', windowsHide: true,
      }, (error, stdout, stderr) => {
        if (!error) resolvePromise({ ok: true, code: 0, stdout, stderr })
        else resolvePromise({ ok: false, code: typeof error.code === 'number' ? error.code : null, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    } catch (error) {
      resolvePromise({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    child.stdin?.on('error', () => undefined)
    child.stdin?.end()
  })
}

const remaining = deadline => deadline - Date.now()

/**
 * The `-c` overrides that disable every filter and diff driver defined outside the user's global and
 * system configuration, or `undefined` when the configuration cannot be read (then git must not run
 * at all: fail closed). Port of dsh git.ts:45-77.
 */
async function overridesBefore(cwd, deadline, maxBuffer) {
  const call = args => runGit(cwd, [...SAFE, ...args], { timeoutMs: remaining(deadline), maxBuffer })
  // `--show-scope` (git >= 2.26) separates repository-planted drivers from the user's and administrator's.
  const scopedRun = await call(['config', '--show-scope', '--name-only', '--get-regexp', '^(filter|diff)\\.'])
  let listing
  let scoped = true
  if (scopedRun.ok) listing = scopedRun.stdout
  else if (scopedRun.code === 1 && scopedRun.stderr.trim() === '') return [] // readable configuration, no driver keys
  else {
    // Older git, or an unreadable configuration: distinguish the two (dsh git.ts:49-58).
    const probe = await call(['config', '--name-only', '--get-regexp', '^(filter|diff)\\.'])
    if (probe.ok) {
      listing = probe.stdout
      scoped = false
    } else if (probe.code === 1 && probe.stderr.trim() === '') {
      return []
    } else {
      const readable = await call(['rev-parse', '--git-dir'])
      return readable.ok ? [] : undefined
    }
  }
  const overrides = []
  const seen = new Set()
  for (const line of listing.split('\n')) {
    if (line.trim() === '') continue
    const tab = line.indexOf('\t')
    const scope = scoped ? (tab < 0 ? '' : line.slice(0, tab)) : 'unknown'
    const key = scoped ? (tab < 0 ? undefined : line.slice(tab + 1)) : line
    if (key === undefined || TRUSTED_SCOPES.has(scope)) continue
    const match = DRIVER_KEY.exec(key.trim())
    if (!match) continue
    const kind = match[1].toLowerCase()
    const id = `${kind}.${match[2]}`
    // `-c` splits at the first '=': a driver name containing one cannot be overridden reliably.
    if (match[2].includes('=')) return undefined
    if (seen.has(id)) continue
    seen.add(id)
    if (kind === 'filter') overrides.push('-c', `${id}.clean=`, '-c', `${id}.smudge=`, '-c', `${id}.process=`, '-c', `${id}.required=false`)
    else overrides.push('-c', `${id}.command=`, '-c', `${id}.textconv=`)
  }
  return overrides
}

/** Exported form of the driver neutralization (dsh git.ts:45): `string[]`, or undefined = do not run git. */
export async function driverOverrides(cwd, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  return overridesBefore(cwd, Date.now() + timeoutMs, maxBuffer)
}

/**
 * A runner whose commands share one driver-override computation (a few milliseconds apart) and one
 * deadline. `run(args)` resolves `{ stdout }` or undefined. Package-internal.
 */
export async function gitSession(cwd, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  const deadline = Date.now() + timeoutMs
  const overrides = await overridesBefore(cwd, deadline, maxBuffer)
  if (overrides === undefined) return undefined
  return async (args, { maxBuffer: perCall = maxBuffer } = {}) => {
    const result = await runGit(cwd, [...SAFE, ...overrides, ...args], { timeoutMs: remaining(deadline), maxBuffer: perCall })
    return result.ok ? { stdout: result.stdout } : undefined
  }
}

/**
 * `git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.external=
 * -c protocol.*.allow=never -c log.showSignature=false <driver overrides> <args>` in `cwd`, with
 * GIT_TERMINAL_PROMPT=0, GIT_EXTERNAL_DIFF=, GIT_OPTIONAL_LOCKS=0, GIT_NO_LAZY_FETCH=1 and without
 * GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (and the other repository redirections). `{ stdout }`, or undefined on any failure or once `timeoutMs` (covering the override
 * probe too) has elapsed.
 *
 * Diff-family commands (diff, log -p, show) must pass `--no-ext-diff --no-textconv`: the neutralised
 * external diff and textconv settings are empty, so without those flags git tries to run the empty
 * program and fails (undefined) — it never runs a planted one.
 */
export async function safeGit(cwd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  const run = await gitSession(cwd, { timeoutMs, maxBuffer })
  return run === undefined ? undefined : run(args)
}

/** `git rev-parse --show-toplevel`, or null outside a work tree. */
export async function gitTopLevel(dir) {
  const out = await safeGit(dir, ['rev-parse', '--show-toplevel'])
  const top = out?.stdout.replace(/\n$/, '')
  return top ? top : null
}

async function realOrResolved(path) {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The project root shared by every worktree of a repository (SPEC §4.1): the parent of the realpath
 * of `git rev-parse --git-common-dir` when that directory is a `.git` directory; otherwise (a
 * submodule or separate git dir, whose common dir does not sit inside its work tree) the work-tree
 * top level; outside git, `realpath(dir)`.
 */
export async function projectRoot(dir) {
  const run = await gitSession(dir)
  if (run !== undefined) {
    const common = (await run(['rev-parse', '--git-common-dir']))?.stdout.replace(/\n$/, '')
    if (common) {
      const commonReal = await realOrResolved(resolve(dir, common))
      if (basename(commonReal) === '.git') return dirname(commonReal)
      const top = (await run(['rev-parse', '--show-toplevel']))?.stdout.replace(/\n$/, '')
      if (top) return realOrResolved(top)
    }
  }
  return realOrResolved(dir)
}

const pathspec = exclude => ['--', '.', ...exclude.map(path => `:(exclude,literal)${path}`)]

function normalizeRelList(exclude) {
  return (exclude ?? [])
    .filter(p => typeof p === 'string' && p.trim() !== '' && !isAbsolute(p))
    .map(p => p.replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    .filter(p => p !== '' && p !== '.')
}

const LS_MAX_BUFFER = 128 * 2 ** 20

/**
 * Directories whose UNTRACKED contents are derived (installed dependencies, virtual environments,
 * bytecode caches), not candidate content: the checkpoint walk outside git never enters them, and
 * with `skipUntrackedIn` neither the git listing nor statusDigest counts untracked files below them,
 * so a Verifier's ordinary `import` or test run that rewrites a cache never voids its verdict
 * (r3-interactive-1). Tracked files below them stay candidate content.
 */
export const DERIVED_DIR_NAMES = Object.freeze(['node_modules', '.venv', '__pycache__'])

/** Whether a relative path lies below a directory named in `names` (any directory segment). */
function underDerived(rel, names) {
  if (names.length === 0) return false
  const segments = rel.split('/')
  segments.pop() // the last segment names the entry itself ('' for a `dir/` entry)
  return segments.some(segment => names.includes(segment))
}

/**
 * Candidate files by git, relative to `root`: `files` = `ls-files -z --cached --others
 * --exclude-standard` (tracked plus untracked-but-not-ignored, sorted, de-duplicated; a nested
 * repository appears as `dir/`), `ignoredDirs` = `ls-files -z --others --ignored --exclude-standard
 * --directory` (ignored files, and ignored directories with a trailing '/'; `./` when the root itself
 * is ignored). Paths equal to or under an `exclude` entry are dropped from `files`, and so are
 * untracked paths below a directory named in `skipUntrackedIn` (e.g. DERIVED_DIR_NAMES). Undefined
 * when git is unusable here.
 */
export async function lsFiles(root, { exclude = [], skipUntrackedIn = [] } = {}) {
  const run = await gitSession(root, { maxBuffer: LS_MAX_BUFFER })
  if (run === undefined) return undefined
  const skip = (skipUntrackedIn ?? []).filter(name => typeof name === 'string' && name !== '' && !name.includes('/'))
  let listed
  if (skip.length === 0) {
    const tracked = await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    if (tracked === undefined) return undefined
    listed = tracked.stdout.split('\0')
  } else {
    // Tracked and untracked listed apart: only untracked derived files are left out.
    const cached = await run(['ls-files', '-z', '--cached'])
    if (cached === undefined) return undefined
    const others = await run(['ls-files', '-z', '--others', '--exclude-standard'])
    if (others === undefined) return undefined
    listed = [...cached.stdout.split('\0'), ...others.stdout.split('\0').filter(rel => !underDerived(rel, skip))]
  }
  const ignored = await run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  if (ignored === undefined) return undefined
  const excluded = normalizeRelList(exclude)
  const isExcluded = rel => excluded.some(ex => rel === ex || rel.startsWith(`${ex}/`) || rel === `${ex}/`)
  const files = [...new Set(listed.filter(rel => rel !== '' && !isExcluded(rel)))]
  const ignoredDirs = [...new Set(ignored.stdout.split('\0').filter(rel => rel !== ''))]
  return { files: sortBytes(files), ignoredDirs: sortBytes(ignoredDirs) }
}

function sortBytes(list) {
  return list.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
}

/**
 * Harness-captured change facts for an interactive candidate (dsh `workspaceState`, git.ts:105-121):
 * git status and diff stat, never a grade. `exclude` paths (harness state) are left out. Submodules are
 * not entered, and no external diff or textconv program runs.
 */
export async function workspaceFacts(root, { exclude = [], maxLines = 200 } = {}) {
  const unavailable = {
    text: `Candidate root: ${root}\nNo usable git repository: file-change capture is unavailable; inspect the live state directly.`,
    git: false,
  }
  const run = await gitSession(root)
  if (run === undefined) return unavailable
  const spec = pathspec(normalizeRelList(exclude))
  const status = await run(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all', ...spec])
  if (status === undefined) return unavailable
  const lines = status.stdout.split('\n').filter(Boolean)
  if (lines.length === 0) return { text: `Candidate root: ${root}\nThe working tree has no uncommitted changes.`, git: true }
  const cap = Math.max(1, Math.floor(maxLines))
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', `--stat-count=${cap}`, '--stat', 'HEAD']
  const stat = ((await run([...diffArgs, ...spec]))?.stdout ?? '').trim()
  const shown = lines.slice(0, cap).map(line => `  ${line}`).join('\n')
  const more = lines.length > cap ? `\n  … ${lines.length - cap} more` : ''
  return {
    text: `Candidate root: ${root}\nUNCOMMITTED CHANGES (git status --porcelain, ${lines.length}):\n${shown}${more}\n\nDIFF STAT:\n${stat === '' ? '(none)' : stat}`,
    git: true,
  }
}

/**
 * Cheap digest of the uncommitted state (SPEC §11.3, J2-7): sha256 of `git status --porcelain=v1 -z
 * --untracked-files=all --ignore-submodules=all` plus, for every listed path in byte order,
 * `'\0' + path + '\0' + size + '\0' + mtime` from lstat ('-' when missing), so a same-size edit of an
 * already-modified file changes it. mtime is integer microseconds (the precision a checkpoint restore
 * reproduces). Porcelain paths are relative to the repository top level. With `skipUntrackedIn`,
 * untracked (`??`) entries below a directory of that name are left out (r3-interactive-1; the
 * checkpoint leaves them out too). Null outside git, on failure, or after `timeoutMs` (the whole
 * computation).
 */
export async function statusDigest(root, { exclude = [], timeoutMs = 3000, skipUntrackedIn = [] } = {}) {
  const run = await gitSession(root, { timeoutMs })
  if (run === undefined) return null
  const top = (await run(['rev-parse', '--show-toplevel']))?.stdout.replace(/\n$/, '')
  if (!top) return null
  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', ...pathspec(normalizeRelList(exclude))])
  if (status === undefined) return null
  const skip = (skipUntrackedIn ?? []).filter(name => typeof name === 'string' && name !== '' && !name.includes('/'))
  const paths = new Set()
  const kept = []
  const tokens = status.stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.length < 4) continue
    const xy = token.slice(0, 2)
    let record = `${token}\0`
    const entryPaths = [token.slice(3)]
    // Renames and copies carry the original path as the next NUL-terminated field.
    if ((xy.includes('R') || xy.includes('C')) && i + 1 < tokens.length && tokens[i + 1] !== '') {
      entryPaths.push(tokens[++i])
      record += `${tokens[i]}\0`
    }
    if (xy === '??' && underDerived(entryPaths[0], skip)) continue
    for (const path of entryPaths) paths.add(path)
    kept.push(record)
  }
  const parts = [skip.length === 0 ? status.stdout : kept.join('')]
  for (const path of sortBytes([...paths])) {
    let stamp = '-'
    try {
      const info = await lstat(join(top, path), { bigint: true })
      stamp = `${info.size}\0${info.mtimeNs / 1000n}`
    } catch {
      // Missing or unreadable: '-' (a deletion is already visible in the status text).
    }
    parts.push(`\0${path}\0${stamp}`)
  }
  return sha256Hex(parts.join(''))
}

/**
 * Makes `dir` an inert repository (SPEC §4.1; dsh stores.ts:108-118): `git init` once, with no
 * template hooks and `core.hooksPath=/dev/null`, plus a `.gitignore` of '*' (written with 'wx', kept
 * when present). Role git commands under `dir` then never discover an enclosing repository (such as
 * one in the user's home) and see nothing to track. Returns true when it initialised the repository
 * now. Without git it only writes `.gitignore`; any other failure throws CcRsiError('inert_repo_failed').
 */
export async function initInertRepo(dir) {
  const abs = resolve(dir)
  await mkdir(abs, { recursive: true, mode: 0o700 })
  let created = false
  let hasGit = true
  try {
    await lstat(join(abs, '.git'))
  } catch {
    hasGit = false
  }
  if (!hasGit) {
    const init = await runGit(abs, ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '--template=', abs], { timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER })
    if (!init.ok) {
      const missing = await runGit(abs, ['--version'], { timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER })
      if (missing.ok) throw new CcRsiError('inert_repo_failed', `git init failed in ${abs}: ${init.stderr.trim()}`, { dir: abs })
    } else {
      created = true
      const config = await runGit(abs, [...SAFE, 'config', 'core.hooksPath', '/dev/null'], { timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER })
      if (!config.ok) throw new CcRsiError('inert_repo_failed', `cannot configure ${abs}: ${config.stderr.trim()}`, { dir: abs })
    }
  }
  try {
    await writeFile(join(abs, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return created
}

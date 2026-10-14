// Temp-dir helpers for every cc-rsi test (SPEC §15.1). Tests never touch ~/.cc-rsi or
// ~/.claude: every home is a fresh temp dir removed when the process exits.

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const created = new Set()
let hooked = false

/** Makes directories writable (read-only views use 0555) so cleanup can remove them. */
function unlockTree(path) {
  let info
  try {
    info = lstatSync(path)
  } catch {
    return
  }
  if (!info.isDirectory()) return
  try { chmodSync(path, 0o700) } catch { /* ignore */ }
  let names = []
  try { names = readdirSync(path) } catch { return }
  for (const name of names) unlockTree(join(path, name))
}

function cleanup() {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      unlockTree(dir)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
  created.clear()
}

/**
 * A fresh temp directory (realpath'd), removed at process exit, also when the test process is
 * interrupted (SIGINT/SIGTERM: cleanup, then the signal's default action; portability-13).
 */
export async function tmpDir(prefix = 'cc-rsi-test-') {
  if (!hooked) {
    hooked = true
    process.once('exit', cleanup)
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => {
        cleanup()
        process.kill(process.pid, sig)
      })
    }
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  created.add(dir)
  return dir
}

/**
 * A temp CC_RSI_HOME and an env for child processes: process.env + CC_RSI_HOME and a fresh temp
 * CLAUDE_CONFIG_DIR (so the developer's Claude Code settings, saved plugin options and transcripts
 * never reach a test), minus CC_RSI_ROLE and CLAUDECODE.
 */
export async function tmpHome() {
  const home = await tmpDir('cc-rsi-home-')
  const env = { ...process.env, CC_RSI_HOME: home, CLAUDE_CONFIG_DIR: await tmpDir('cc-rsi-claude-config-') }
  delete env.CC_RSI_ROLE
  delete env.CLAUDECODE
  return { home, env }
}

/** One POSIX shell word for `s` (single quotes; portability-13: temp paths may contain spaces). */
export const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

let unprivilegedReason

/**
 * Why a test that runs a child as the unprivileged user 65534 (nobody) must skip here, or false.
 * Only root switches users: then nobody must be able to run this Node binary and search the temp
 * directory (a TMPDIR under a 0700 directory, as in sandboxed sessions, is not searchable). Use as
 * `test(name, { skip: unprivilegedSkip() }, fn)`.
 */
export function unprivilegedSkip() {
  if (process.getuid?.() !== 0) return false
  if (unprivilegedReason !== undefined) return unprivilegedReason
  const probe = spawnSync(process.execPath, ['-e', 'const fs = require("node:fs"); fs.accessSync(process.argv[1], fs.constants.X_OK)', tmpdir()], {
    uid: 65534, gid: 65534, stdio: 'ignore', timeout: 15000,
  })
  unprivilegedReason = probe.status === 0
    ? false
    : `the unprivileged user 65534 cannot ${probe.error ? `run ${process.execPath}` : `search the temp directory ${tmpdir()}`}`
  return unprivilegedReason
}

/** Environment for hermetic git commands: no system or global configuration. */
export function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

/** A temp git repository whose initial commit holds `files` ({relPath: string|Buffer}). Returns its realpath. */
export async function gitRepo(files = {}) {
  const dir = await tmpDir('cc-rsi-repo-')
  const env = gitEnv()
  const git = args => execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  git(['add', '-A'])
  git(['-c', 'user.email=test@example.invalid', '-c', 'user.name=cc-rsi test', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'initial'])
  return dir
}

// Harness-private roots shared by every role child (SPEC §4.3 "all roles" row): the one list the
// interactive Verifier (lib/interactive/verify-job.mjs) and the lineage roles (lib/engine/roles.mjs)
// both hide, so the two cannot drift apart (portability-5).

import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isUnderLexical } from '../core/paths.mjs'
import { claudeConfigDir } from './models.mjs'

/**
 * Claude Code's per-user state that holds credentials or another context's reasoning: transcripts,
 * credentials, plans, task lists, file history and prompt history (security-9). shell-snapshots
 * and session-env stay readable: a role's own Bash sources them.
 */
export const CONFIG_PRIVATE = Object.freeze(['projects', '.credentials.json', 'plans', 'todos', 'tasks', 'file-history', 'history.jsonl'])

/** Literal traversal tokens of the same state (the Bash heuristic of SPEC §10.6). */
export const CONFIG_PRIVATE_TOKENS = Object.freeze([
  '.claude/projects', '.claude/.credentials', '.claude/plans', '.claude/todos', '.claude/tasks', '.claude/file-history', '.claude/history.jsonl',
  '/tmp/claude-',
])

/** The user's home of a role environment. */
export function userHomeOf(env = process.env) {
  return typeof env?.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir()
}

/**
 * Every harness-private root a role never sees: `<home>/{projects,run,bin,config.json,logs}`,
 * CONFIG_PRIVATE under ~/.claude and CLAUDE_CONFIG_DIR, the Claude Code session temp dirs of the
 * user (`<TMPDIR>/claude-<uid>`, `/tmp/claude-<uid>`: background task output and scratchpads of
 * other sessions; a role's own TMPDIR is private to it), and a memory store configured outside
 * `<home>/projects` (memory.dir). Callers add their role-specific roots and drop the roots that
 * contain the role's own directories (`withoutOwn`).
 */
export function harnessPrivateRoots({ home, env = process.env, storeDir } = {}) {
  const userHome = userHomeOf(env)
  const list = [join(home, 'projects'), join(home, 'run'), join(home, 'bin'), join(home, 'config.json'), join(home, 'logs')]
  for (const base of new Set([join(userHome, '.claude'), claudeConfigDir(env)])) {
    for (const name of CONFIG_PRIVATE) list.push(join(base, name))
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null) {
    const tmpBase = typeof env?.TMPDIR === 'string' && env.TMPDIR !== '' ? env.TMPDIR : tmpdir()
    for (const base of new Set([tmpBase, '/tmp'])) list.push(join(base, `claude-${uid}`))
  }
  if (typeof storeDir === 'string' && storeDir !== '' && !isUnderLexical(storeDir, join(home, 'projects'))) list.push(resolve(storeDir))
  return list.map(p => resolve(p))
}

/**
 * `roots` without those that would contain one of `own` (a role's cwd, scratch, added dirs): a
 * deny rule over its own directories would block the role. Duplicates removed.
 */
export function withoutOwn(roots, own) {
  const mine = own.filter(p => typeof p === 'string' && p !== '').map(p => resolve(p))
  return [...new Set(roots.map(p => resolve(p)))].filter(h => !mine.some(o => isUnderLexical(o, h)))
}

/** `tokens` without those found in one of `own` (a token in its own path would block the role). */
export function tokensWithoutOwn(tokens, own) {
  const mine = own.filter(p => typeof p === 'string' && p !== '').map(p => `${resolve(p)}/`)
  return tokens.filter(token => !mine.some(p => p.includes(token)))
}

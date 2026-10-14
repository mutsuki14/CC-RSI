// Main-session PreToolUse guard (SPEC §11.8 `guard`; PR §4.7, §4.8, §7.6). Applies to the main
// thread AND its subagents (payloads with `agent_id`), which are part of the Actor.
//
//  1. Workspace lock: while a live lock covers the cwd or a write path, file changes and shell
//     commands are denied (Read/Grep/Glob stay allowed), in every session.
//  2. Private state: all of `<home>` is hidden from file tools except this session's read-only
//     memory view, `<home>/bin`, and the open learning draft (read + write while learning). Verdict
//     state therefore cannot be written by the Actor (SPEC §2 boundary 2). Independent Verifier
//     transcripts are hidden too.
//  3. Bash: hidden paths and tokens (heuristic, lib/guard/bash.mjs; one scan over every hidden root),
//     human-only cc-rsi subcommands (J2-6; parsed from the command words, never matched in free text),
//     Verifier session ids.
//  4. An external memory store (`memory.dir`, global config) is private like `<home>` (security-5).
//     A store inside the project is private by direct path only: searches of the project stay allowed.
//  5. The running plugin code (CODE_ROOT, CLAUDE_PLUGIN_ROOT) is read/exec-only: every later verdict
//     runs verify-job.mjs, the hooks and the role guard from disk (security-4). Not enforced when the
//     project itself is a cc-rsi checkout the session develops.
//  6. Interactive Verifier transcripts: once this session minted a Verifier session id, the Claude
//     Code transcript directory of its candidate root (`<config>/projects/<slug>`) is private, except
//     Claude Code's auto-memory (`<slug>/memory`) and this session's own files (`<slug>/<sid>[.jsonl]`,
//     e.g. persisted tool results) (security-3). Shell commands that only name the config dir (`ls`,
//     `cd`, `cp` into it, commit messages) are not refused; tree walks and interpreters given an
//     ancestor of a transcript directory are (r2-overblock-2).
// Fails open on errors (main-session hooks never block on a cc-rsi bug).

import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { loadConfig } from '../core/config.mjs'
import { ccRsiHome, globalLayout, transcriptSlug } from '../core/paths.mjs'
import { commandWords, isTreeCommand, scanBash } from '../guard/bash.mjs'
import { canonicalRoot, isUnder, toolPathArgs } from '../guard/paths.mjs'
import { claudeConfigDir } from '../runtime/models.mjs'
import { CODE_ROOT, developsPlugin, pluginRootOf, sessionContext } from '../interactive/session.mjs'
import { jobPath, readJobSync, readTaskSync } from '../interactive/task.mjs'
import { listLocksSync, lockCovering, recoverPendingLocks } from '../interactive/wslock.mjs'
import { allowPre, denyPre, failOpen, hookLogger, isRole } from './common.mjs'

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor'])
const LOCKED_TOOLS = new Set([...WRITE_TOOLS, ...SHELL_TOOLS])

// Options of the cc-rsi CLI that take a value (lib/cli/*.mjs parseArgs specs), so a value such as
// `--direction "make start faster"` is never read as a subcommand (r2-overblock-4).
const CLI_VALUE_OPTIONS = new Set(['session', 'project', 'phase', 'direction', 'direction-file', 'target', 'target-file', 'fixtures', 'id', 'model',
  'actor-model', 'verifier-model', 'curriculum-model', 'escalation-model', 'summarizer-model', 'n', 'reason', 'timeout', 'release-lock', 'retries',
  'json-out', 'run', 'grace', 'older-than'])
// Flags that make any cc-rsi command human-only.
const HUMAN_ONLY_FLAGS = new Set(['release-lock', 'prune', 'accept-external'])
// Options of node-like runners that take a value before the script operand.
const RUNNER_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--input-type', '--title'])
const RUNNERS = new Set(['node', 'nodejs', 'bun', 'deno'])
const SHELL_WORDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'busybox'])

/** The arguments of a cc-rsi invocation (`cc-rsi …`, `node …/cc-rsi …`), or null for another command. */
function cliArgs(word, args) {
  const name = basename(word)
  if (name === 'cc-rsi') return args
  if (!RUNNERS.has(name)) return null
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print') return null // inline code, no script
    if (RUNNER_VALUE_OPTIONS.has(a)) { k++; continue }
    if (a.startsWith('-')) continue
    if (name === 'deno' && (a === 'run' || a === 'x')) continue
    return basename(a) === 'cc-rsi' ? args.slice(k + 1) : null
  }
  return null
}

/** Why a cc-rsi argument list is human-only, or null: its subcommand path or a human-only flag. */
function humanOnlyArgs(args, modelMayStart) {
  const positionals = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--') { positionals.push(...args.slice(k + 1)); break }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      if (HUMAN_ONLY_FLAGS.has(name)) return true
      if (eq < 0 && CLI_VALUE_OPTIONS.has(name)) k++
      continue
    }
    if (a === '-n') { k++; continue }
    if (/^-[A-Za-z]$/.test(a)) continue
    positionals.push(a)
  }
  const [command, sub] = positionals
  if (command === 'eval') return true
  if (command === 'memory' && ['restore', 'unfreeze', 'import'].includes(sub)) return true
  if (command === 'explore' && sub === 'abandon') return true
  if (command === 'explore' && (sub === 'start' || sub === 'resume') && !modelMayStart) return true
  if (command === 'verify' && sub === 'cancel') return true
  return false
}

/**
 * Whether a shell command runs a human-only cc-rsi command (SPEC §11.8 rule 3; J2-6): eval,
 * memory restore|unfreeze|import, explore abandon, verify cancel, `--release-lock`, `--prune`,
 * `--accept-external`, and explore start|resume unless `exploration.modelMayStart`. The command
 * words are parsed (also inside `sh -c`, `eval` and `find -exec`), so free text that merely mentions
 * these words (a commit message, an issue title, a path with a `cc-rsi` segment) is not refused
 * (r2-overblock-4). A command that also clears CLAUDECODE is judged by the conservative text test
 * as well, since the parsed words can miss an invocation whose command word is computed
 * (r3-guard-hooks-4).
 */
export function humanOnlyIn(command, { modelMayStart = false, words, depth = 0 } = {}) {
  if (depth > 4) return false
  if (depth === 0 && clearsClaudeMarker(command) && (HUMAN_ONLY_RE.test(command) || (!modelMayStart && EXPLORE_START_RE.test(command)))) return true
  for (const { word, args } of words ?? commandWords(command)) {
    const cli = cliArgs(word, args)
    if (cli && humanOnlyArgs(cli, modelMayStart)) return true
    const name = basename(word)
    let inner = null
    if (SHELL_WORDS.has(name)) {
      const ci = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
      if (ci >= 0 && ci + 1 < args.length) inner = args[ci + 1]
    } else if (name === 'eval' && args.length > 0) {
      inner = args.join(' ')
    } else if (name === 'find') {
      for (let k = 0; k < args.length - 1; k++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(args[k])) continue
        const end = args.findIndex((a, j) => j > k && (a === ';' || a === '+'))
        const argv = args.slice(k + 1, end < 0 ? args.length : end)
        const execCli = cliArgs(argv[0] ?? '', argv.slice(1))
        if (execCli && humanOnlyArgs(execCli, modelMayStart)) return true
      }
    }
    if (inner !== null && humanOnlyIn(inner, { modelMayStart, depth: depth + 1 })) return true
  }
  return false
}

/**
 * The conservative text form of the human-only rule (the pre-r2 test), applied only to a command that
 * also clears the CLAUDECODE marker the CLI itself refuses on (r3-guard-hooks-4): there the parsed
 * command words may not show the cc-rsi invocation, and free text rarely clears that variable.
 */
export const HUMAN_ONLY_RE = /\bcc-rsi\b[^\n;&|]*\b(eval|unfreeze|restore|import|accept-external|prune|abandon|release-lock|cancel)\b/
export const EXPLORE_START_RE = /\bcc-rsi\b[^\n;&|]*\bexplore\b[^\n;&|]*\s(start|resume)\b/
const CLEARS_MARKER = [
  /\benv\b[^\n;&|]*\s(-[A-Za-z]*u\s*|--unset[=\s]\s*)['"]?CLAUDECODE\b/,
  /\benv\b[^\n;&|]*\s(-i|--ignore-environment|-)(\s|$)/,
  /\bunset\b[^\n;&|]*\bCLAUDECODE\b/,
  /\bexport\s+-n\b[^\n;&|]*\bCLAUDECODE\b/,
  /(^|[^A-Za-z0-9_])CLAUDECODE=(?!['"]?[^\s'";&|)]+)/,
]

/** Whether a shell command removes or blanks CLAUDECODE for what it runs. */
export function clearsClaudeMarker(command) {
  return typeof command === 'string' && command.includes('CLAUDECODE') ? CLEARS_MARKER.some(re => re.test(command)) : false
}

const HUMAN_ONLY_REASON = 'cc-rsi: that command is human-only; ask the user to run it in a terminal'
const VIEW_READ_ONLY = 'the memory view is read-only; durable memory changes only through learn → memory_commit'
const SEARCH_COVERS_HOME = 'narrow the search path; it covers cc-rsi private state'
const HIDDEN_FROM_ROLE = /^(.*) is a harness-private path hidden from this role; it is not candidate evidence\.$/

const TRANSCRIPT_SEARCH = 'narrow the search path; it covers an independent Verifier transcript'

function privateReason(path) {
  return `${path} is cc-rsi private state; it is not part of your task.`
}

function codeReason(path) {
  return `${path} is the running cc-rsi plugin code; it cannot be changed from this session (read it with the Read tool).`
}

function transcriptReason(path) {
  return `${path} is an independent Verifier transcript (or lies in a Claude Code transcript directory that holds one); it is not part of your task.`
}

function hhmmss(iso) {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return 'unknown time'
  return new Date(at).toTimeString().slice(0, 8)
}

/** The lock deny reason (SPEC §11.8 rule 1). */
export function lockReason(lock) {
  if (lock.restoreFailed) {
    return `cc-rsi: a verification failed to restore the workspace; run cc-rsi doctor in a terminal (job ${lock.jobId ?? 'unknown'}, root ${lock.root}). File changes and shell commands stay paused until the user releases it.`
  }
  if (lock.recoveryPending) {
    return `cc-rsi: a verification job (job ${lock.jobId ?? 'unknown'}) ended without restoring its checkpoint of this workspace; its recovery is running, retry shortly. If this persists, ask the user to run cc-rsi doctor in a terminal.`
  }
  return `cc-rsi: an independent verification of this workspace is running (job ${lock.jobId ?? 'unknown'}, started ${hhmmss(lock.at)}). File changes and shell commands are paused until it finishes. Call the cc-rsi wait_verdict tool.`
}

/** Lexical and physical spellings of a root. */
function spellings(path) {
  const out = new Set([path])
  try { out.add(canonicalRoot(path)) } catch { /* lexical only */ }
  return [...out]
}

const under = (p, roots) => roots.some(root => isUnder(p, root))

const PATH_CHAR = /[A-Za-z0-9._\-~+@%]/

/** Whether `text` names `path` at a path boundary. */
function names(text, path) {
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    const after = text[at + path.length]
    if (after === undefined || after === '/' || !PATH_CHAR.test(after)) return true
  }
  return false
}

/** `$CC_RSI_HOME`, `$HOME` and `~` expanded like scanBash. */
function expandHomes(command, { home, userHome }) {
  let text = command.replace(/\$\{CC_RSI_HOME\}|\$CC_RSI_HOME(?![A-Za-z0-9_])/g, home)
  if (userHome) {
    text = text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, userHome)
    text = text.replace(/(^|[\s'"=:(`<>|;&])~(?=\/|$|[\s'";&|)<>])/g, (m, pre) => `${pre}${userHome}`)
  }
  return text
}

/**
 * The `<home>/bin` spelling used anywhere but in command position (an argument or a redirection
 * target), or null. `~`, `$HOME` and `$CC_RSI_HOME` are expanded first, like scanBash. With
 * `runnable`, a first `node`/`nodejs` operand naming one of those files is execution, not an argument
 * (`node <plugin>/bin/cc-rsi status`).
 */
export function binAsArgument(command, { home, userHome, bins, runnable = [], words }) {
  const text = expandHomes(command, { home, userHome })
  if (!bins.some(bin => names(text, bin))) return null
  for (const { word, args } of words ?? commandWords(text)) {
    const runs = (word === 'node' || word === 'nodejs') && args.length > 0 && runnable.includes(args[0])
    for (const arg of runs ? args.slice(1) : args) {
      const hit = bins.find(bin => names(arg, bin))
      if (hit) return hit
    }
  }
  return null
}

export { transcriptSlug }

const GLOB_CHAR = /[*?[\]{}]/

/** Whether shell glob `pattern` (`*`, `?`, `[…]`, `{a,b}`) can match the name `name` (unparsable → true). */
export function globMatches(pattern, name) {
  const esc = c => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end < 0) { re += '\\['; continue }
      let body = pattern.slice(i + 1, end)
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      re += `[${body.replace(/\\/g, '\\\\')}]`
      i = end
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end < 0) { re += '\\{'; continue }
      re += `(?:${pattern.slice(i + 1, end).split(',').map(esc).join('|')})`
      i = end
    } else {
      re += esc(c)
    }
  }
  try {
    return new RegExp(`^${re}$`).test(name)
  } catch {
    return true
  }
}

const SEGMENT_END = /[\s'"`;|&<>()$]/

/**
 * Whether the path text after a Claude config dir (`rest`, e.g. "/projects/*\/x.jsonl") reaches a
 * protected transcript directory by naming an ancestor itself or a glob that can match it: the
 * config dir or its `projects` dir named as such, `.`/`..`, or a glob matching `projects` or a slug.
 * A literal slug is left to the hidden-root check (which knows the allowed subpaths).
 */
function reachesTranscripts(rest, slugNames) {
  if (!rest.startsWith('/')) return true
  let end = 1
  while (end < rest.length && !SEGMENT_END.test(rest[end])) end++
  const segs = rest.slice(1, end).split('/')
  const level = (seg, names) => {
    if (seg === undefined || seg === '' || seg === '.' || seg === '..') return 'hit'
    if (names.includes(seg)) return 'down'
    if (GLOB_CHAR.test(seg) && names.some(n => globMatches(seg, n))) return 'hit'
    return 'away'
  }
  const first = level(segs[0], ['projects'])
  if (first !== 'down') return first === 'hit'
  return level(segs[1], slugNames) === 'hit'
}

// Commands that never walk a directory they are given (or whose recursive forms the tree-walk rule
// of scanBash already judges): naming the Claude config dir with them reaches no transcript.
const NON_WALKING = new Set(['echo', 'printf', 'cd', 'pushd', 'popd', 'mkdir', 'rmdir', 'touch', 'ln', 'install', 'cat', 'head', 'tail', 'less', 'more',
  'wc', 'file', 'stat', 'readlink', 'realpath', 'basename', 'dirname', 'test', '[', 'true', 'false', 'export', 'unset', 'set', 'alias', 'which',
  'type', 'command', 'git', 'gh', 'claude', 'code', 'open', 'xdg-open', 'sed', 'awk', 'jq', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'tee',
  'chmod', 'chown', 'chgrp', 'cp', 'mv', 'rm', 'ls', 'du', 'df', 'sleep', 'date', 'env', 'npm', 'npx', 'pnpm', 'yarn', 'make', 'cc-rsi'])
// Options of any command whose value is free text (a message), never a path to walk.
const TEXT_OPTIONS = new Set(['-m', '--message', '--title', '--body', '-F', '--subject', '--description', '--comment'])
const INTERPRETER = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|deno|perl|ruby|php|lua|tclsh|Rscript|osascript)$/
const CODE_OPTIONS = new Set(['-c', '-e', '-E', '--eval', '-p', '--print', '-r'])

/** The config dir a text (interpreter code) names in a way that reaches transcripts, or null. */
function transcriptAncestorInText(text, { configDirs, slugNames }) {
  for (const variant of new Set([text, text.replace(/["'\\]/g, '')])) {
    for (const dir of configDirs) {
      for (let at = variant.indexOf(dir); at >= 0; at = variant.indexOf(dir, at + 1)) {
        const before = at === 0 ? '' : variant[at - 1]
        const after = variant[at + dir.length]
        if (before !== '' && PATH_CHAR.test(before)) continue
        if (after !== undefined && after !== '/' && (PATH_CHAR.test(after) || GLOB_CHAR.test(after))) continue
        if (reachesTranscripts(variant.slice(at + dir.length), slugNames)) return dir
      }
    }
  }
  return null
}

/**
 * The Claude config dir a shell command reaches transcripts through, or null (rule 6, for programs
 * scanBash cannot see into). Only interpreters (`python3 walk.py ~/.claude`, `node -e '…/.claude'`),
 * shells running scripts, and programs this guard does not know are judged: their path operands
 * (resolved against the cwd, followed through `cd`) and their inline code. Tree walkers (`grep -r`,
 * `find`, `rg`, …) are judged by scanBash with the transcript directories as hidden roots; commands
 * that do not walk (`ls`, `cd`, `cp`, `git -C`, `echo`, commit messages, assignments) never reach a
 * transcript by naming the config dir (r2-overblock-2).
 */
export function transcriptAncestorIn(command, { configDirs, slugNames, home, userHome, cwd, words, depth = 0 }) {
  if (depth > 4) return null
  const opts = { configDirs, slugNames }
  let cur = typeof cwd === 'string' && cwd !== '' ? cwd : null
  const reaches = arg => {
    if (arg === '' || (cur === null && !arg.startsWith('/'))) return null
    const full = resolve(cur ?? '/', arg)
    for (const dir of configDirs) {
      if (full !== dir && !full.startsWith(`${dir}/`)) continue
      if (reachesTranscripts(full.slice(dir.length), slugNames)) return dir
    }
    return null
  }
  for (const { word, args } of words ?? commandWords(expandHomes(command, { home, userHome }))) {
    const name = basename(word)
    if (name === 'cd' || name === 'pushd') {
      const arg = args.find(a => !a.startsWith('-'))
      if (cur !== null && arg !== undefined && arg !== '-') cur = resolve(cur, arg)
      continue
    }
    if (NON_WALKING.has(name) || isTreeCommand(word)) continue
    const shell = SHELL_WORDS.has(name)
    if (name === 'eval') {
      const hit = transcriptAncestorIn(args.join(' '), { configDirs, slugNames, home, userHome, cwd: cur, depth: depth + 1 })
      if (hit) return hit
      continue
    }
    const interpreter = INTERPRETER.test(name)
    for (let k = 0; k < args.length; k++) {
      const a = args[k]
      if (TEXT_OPTIONS.has(a)) { k++; continue }
      if ((shell && /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) || (interpreter && CODE_OPTIONS.has(a))) {
        const code = args[k + 1] ?? ''
        k++
        const hit = shell
          ? transcriptAncestorIn(code, { configDirs, slugNames, home, userHome, cwd: cur, depth: depth + 1 })
          : transcriptAncestorInText(code, opts)
        if (hit) return hit
        continue
      }
      if (a.startsWith('-')) {
        const eq = a.indexOf('=')
        if (eq > 0) {
          const hit = reaches(a.slice(eq + 1))
          if (hit) return hit
        }
        continue
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue // an assignment-like argument (make VAR=…)
      const hit = reaches(a)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Every interactive Verifier session id this session minted: the append-only `verifierSessionIds`,
 * the task and prevTask contexts, and the running job's (a fresh context's id lives only there until
 * its verdict). Returns `{ ids, job }`.
 */
function verifierIdsOf(state, sl) {
  const ids = []
  const add = value => {
    const id = typeof value === 'string' ? value : value && typeof value === 'object' ? value.sessionId : null
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  for (const value of Array.isArray(state?.verifierSessionIds) ? state.verifierSessionIds : []) add(value)
  add(state?.task?.verifier?.sessionId)
  add(state?.prevTask?.verifier?.sessionId)
  let job = null
  if (sl && typeof state?.job?.id === 'string' && state.job.id !== '') {
    try { job = readJobSync(jobPath(sl, state.job.id)) } catch { job = null }
    add(job?.verifier?.sessionId)
  }
  return { ids: [...new Set(ids)], job }
}

/**
 * The transcript protection (rule 6), or null when this session never minted a Verifier id:
 * `{ ids, projectsRoots, slugDirs, slugNames, allowed, configDirs }`.
 */
function transcriptPolicy({ state, ctx, env, userHome }) {
  const { ids, job } = verifierIdsOf(state, ctx?.sl ?? null)
  if (ids.length === 0) return null
  const configDirs = [...new Set([join(userHome, '.claude'), claudeConfigDir(env)].map(d => resolve(d)))].flatMap(spellings)
  const projectsRoots = [...new Set(configDirs.map(d => join(d, 'projects')))]
  const roots = [
    state?.task?.candidateRoot, state?.task?.openRoot, state?.prevTask?.candidateRoot, state?.prevTask?.openRoot, job?.candidateRoot,
    ...(Array.isArray(state?.verifierCandidateRoots) ? state.verifierCandidateRoots : []), ctx?.projectRoot, ctx?.projectDir,
  ].filter(r => typeof r === 'string' && r.startsWith('/'))
  const slugNames = [...new Set(roots.flatMap(spellings).map(transcriptSlug))]
  const slugDirs = projectsRoots.flatMap(root => slugNames.map(name => join(root, name)))
  const allowed = []
  for (const dir of slugDirs) {
    allowed.push(join(dir, 'memory'))
    if (typeof ctx?.sid === 'string' && ctx.sid !== '') allowed.push(join(dir, ctx.sid), join(dir, `${ctx.sid}.jsonl`))
  }
  return { ids, projectsRoots, slugDirs, slugNames, allowed, configDirs }
}

/** The deny output of rule 6 for one file-tool path, or null. */
function transcriptFileDeny(t, p, search) {
  if (under(p, t.allowed)) return null
  if (under(p, t.slugDirs)) return denyPre(search ? TRANSCRIPT_SEARCH : transcriptReason(p))
  if (under(p, t.projectsRoots)) {
    if (p.split('/').some(seg => t.ids.some(id => seg.startsWith(id)))) return denyPre(transcriptReason(p))
    // A search inside another project's transcripts may reach a Verifier transcript of an earlier root.
    if (search) return denyPre(TRANSCRIPT_SEARCH)
  }
  if (search && t.projectsRoots.some(root => isUnder(root, p))) return denyPre(TRANSCRIPT_SEARCH)
  return null
}

/**
 * The external memory store (security-5) as `{ root, walkable }`, or null when the store lives under
 * `<home>` or contains the project (which it would hide). `walkable` is false when the store lies
 * inside the project (an absolute memory.dir in the repo): direct paths into it stay private, but a
 * project-wide search (Grep/Glob without a path, `rg TODO`, `grep -r x .`) is not refused for covering
 * it, or every search of the project would be (r2-overblock-1). SessionStart warns about such a store.
 */
export function externalStoreRoot({ ctx, home, cwd, env }) {
  let dir = ctx ? ctx.config?.memory?.dir : undefined
  if (!ctx) {
    try { dir = loadConfig({ home, env }).config?.memory?.dir } catch { dir = undefined }
  }
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return null
  const store = ctx?.pl?.store ?? resolve(dir)
  if (isUnder(store, home)) return null
  const bases = [cwd, ctx?.projectRoot, ctx?.projectDir].filter(p => typeof p === 'string' && p !== '').flatMap(spellings)
  const stores = spellings(store)
  // A store that contains the project would hide the project itself: not enforced then.
  if (bases.some(p => stores.some(s => isUnder(p, s)))) return null
  return { root: store, walkable: !bases.some(p => stores.some(s => isUnder(s, p))) }
}

/**
 * The plugin code roots (rule 5): CODE_ROOT and the reported plugin root, both spellings; empty when
 * the session's project is the cc-rsi checkout itself or lies inside it (developing cc-rsi with
 * cc-rsi). An installed plugin under the Claude config dir is always protected.
 */
function pluginCodeRoots({ ctx, env, userHome }) {
  const roots = [...new Set([CODE_ROOT, pluginRootOf(env)].map(r => resolve(r)))].flatMap(spellings)
  // The same rule as the submit/job fingerprint check (lib/interactive/session.mjs developsPlugin).
  if (developsPlugin(ctx?.projectRoot, { env, roots, userHome })) return []
  return [...new Set(roots)]
}

async function guard(payload, env) {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd()
  const userHome = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir()
  const home = ccRsiHome(env)
  const g = globalLayout(home)

  // Session state, read-only (no lock). An unknown session still gets the <home> and lock rules.
  let ctx = null
  try {
    ctx = await sessionContext({ payload, env, create: false })
  } catch {
    ctx = null
  }
  const state = ctx ? readTaskSync(ctx.sl, { sessionId: ctx.sid }) : null
  const viewDir = ctx?.sl.viewDir ?? null
  const draftDir = typeof state?.learning?.draftDir === 'string' ? state.learning.draftDir : null

  // (1) Workspace lock.
  if (LOCKED_TOOLS.has(tool)) {
    const locks = listLocksSync(g.locks)
    if (locks.length > 0) {
      // A lock whose job died with its checkpoint open stays live until its recovery restored the
      // checkpoint (memory-crash-2); this session may be the first to meet it, so it starts the
      // recovery (detached; recovery takes its own lock, so repeated spawns are harmless).
      const deny = lock => {
        if (lock.recoveryPending) {
          try {
            recoverPendingLocks(g.locks, { locks: [lock], env })
          } catch (error) {
            hookLogger(env).warn('lock recovery spawn failed', { error: error?.message })
          }
        }
        return { stdout: denyPre(lockReason(lock)) }
      }
      const paths = [cwd]
      if (WRITE_TOOLS.has(tool)) paths.push(...toolPathArgs(tool, input, cwd, { userHome }).paths)
      for (const p of paths) {
        const lock = lockCovering(locks, p)
        if (lock) return deny(lock)
      }
      // A shell command run elsewhere that names a locked root (heuristic, like the Bash path scan).
      const command = SHELL_TOOLS.has(tool) && typeof input.command === 'string' ? input.command : null
      if (command !== null) {
        const named = locks.find(l => l.live !== false && typeof l.root === 'string' && l.root !== '/' && command.includes(l.root))
        if (named) return deny(named)
      }
    }
  }

  const store = externalStoreRoot({ ctx, home, cwd, env })
  const privateRoots = [home, ...(store ? [store.root] : [])]
  // Roots a search or tree walk may not cover (an in-project store only by direct paths).
  const walkRoots = [home, ...(store?.walkable ? [store.root] : [])]
  const homeRoots = privateRoots.flatMap(spellings)
  const searchRoots = walkRoots.flatMap(spellings)
  const viewRoots = viewDir ? spellings(viewDir) : []
  const draftRoots = draftDir ? spellings(draftDir) : []
  const binRoots = spellings(g.bin)
  const codeRoots = pluginCodeRoots({ ctx, env, userHome })
  const transcripts = transcriptPolicy({ state, ctx, env, userHome })

  // (2) File tools.
  if (FILE_TOOLS.has(tool)) {
    const { paths, search, write, invalid } = toolPathArgs(tool, input, cwd, { userHome })
    if (invalid) return {}
    let allowAll = paths.length > 0
    for (const p of paths) {
      if (search && searchRoots.some(h => isUnder(h, p)) && !under(p, viewRoots) && !under(p, draftRoots)) {
        return { stdout: denyPre(SEARCH_COVERS_HOME) }
      }
      if (under(p, homeRoots)) {
        if (under(p, viewRoots)) {
          if (write) return { stdout: denyPre(VIEW_READ_ONLY) }
          continue
        }
        if (under(p, draftRoots)) continue
        if (!write && under(p, binRoots)) {
          allowAll = false
          continue
        }
        return { stdout: denyPre(privateReason(p)) }
      }
      allowAll = false
      if (write && under(p, codeRoots)) return { stdout: denyPre(codeReason(p)) }
      if (transcripts) {
        const deny = transcriptFileDeny(transcripts, p, search)
        if (deny) return { stdout: deny }
      }
    }
    if (write && state?.job && ctx && paths.some(p => p === join(ctx.projectRoot, '.claude', 'cc-rsi.json'))) {
      return { stdout: denyPre('cc-rsi: the cc-rsi project configuration cannot change while a verification runs; call wait_verdict first.') }
    }
    if (allowAll) {
      return { stdout: allowPre(write ? 'cc-rsi: the open learning draft' : 'cc-rsi: the read-only memory view or the open learning draft') }
    }
    return {}
  }

  // (3) Shell commands.
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === 'string' ? input.command : null
    if (command === null) return {}
    // One path scan over every hidden root (r2-overblock-8): <home> and an external store (rule 2,
    // 4), and once this session minted a Verifier id the transcript directories (rule 6).
    const slugRoots = transcripts ? transcripts.slugDirs.flatMap(spellings) : []
    const isTranscript = root => slugRoots.some(t => isUnder(root, t))
    const allowedPaths = [viewDir, g.bin, draftDir, ...(transcripts?.allowed ?? [])].filter(p => typeof p === 'string' && p !== '')
    // A tree walk rooted above a hidden root gets the same reason as a Grep/Glob search (security-6).
    const reason = scanBash(command, {
      hidden: [...privateRoots, ...(transcripts?.slugDirs ?? [])],
      walkHidden: [...walkRoots, ...(transcripts?.slugDirs ?? [])],
      allowedPaths, home, userHome, recursionGuard: false, cwd,
      coversReason: (path, root) => (isTranscript(root) ? TRANSCRIPT_SEARCH : SEARCH_COVERS_HOME),
    })
    if (reason) {
      const m = HIDDEN_FROM_ROLE.exec(reason)
      if (!m) return { stdout: denyPre(reason) }
      return { stdout: denyPre(isTranscript(m[1]) ? transcriptReason(m[1]) : privateReason(m[1])) }
    }
    const words = commandWords(expandHomes(command, { home, userHome }))
    // <home>/bin is exec-only for shell commands: the shim may be run, never written (a rewritten
    // shim would run Actor code when the user runs a human-only command in a terminal).
    const binArg = binAsArgument(command, { home, userHome, bins: spellings(g.bin), words })
    if (binArg) return { stdout: denyPre(`${binArg} is cc-rsi private state; only running the cc-rsi shim is allowed.`) }
    // The plugin code likewise: running `node <root>/bin/cc-rsi …` is allowed, naming it otherwise is not.
    if (codeRoots.length > 0) {
      const runnable = codeRoots.map(r => join(r, 'bin', 'cc-rsi'))
      const codeArg = binAsArgument(command, { home, userHome, bins: codeRoots, runnable, words })
      if (codeArg) return { stdout: denyPre(codeReason(codeArg)) }
    }
    const modelMayStart = ctx?.config?.exploration?.modelMayStart === true
    if (humanOnlyIn(command, { modelMayStart, words })) return { stdout: denyPre(HUMAN_ONLY_REASON) }
    if (transcripts) {
      const ancestor = transcriptAncestorIn(command, { configDirs: transcripts.configDirs, slugNames: transcripts.slugNames, home, userHome, cwd, words })
      if (ancestor) return { stdout: denyPre(`cc-rsi: ${ancestor} holds independent Verifier transcripts; they are not part of your task (name a narrower path).`) }
      for (const id of transcripts.ids) {
        if (command.includes(id)) return { stdout: denyPre(`cc-rsi: ${id} is an independent Verifier session; its transcript is not part of your task.`) }
      }
    }
  }
  return {}
}

/** PreToolUse guard entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  return failOpen('guard', () => guard(payload ?? {}, env), { env })
}

// Main-session PreToolUse guard (SPEC §11.8 `guard`; PR §4.7, §4.8, §7.6). Applies to the main
// thread AND its subagents (payloads with `agent_id`), which are part of the Actor.
//
//  1. Workspace lock: while a live lock covers the cwd or a write path, file changes and shell
//     commands are denied (Read/Grep/Glob stay allowed), in every session.
//  2. Private state: all of `<home>` is hidden from file tools except this session's read-only
//     memory view, `<home>/bin`, and the open learning draft (read + write while learning). Verdict
//     state therefore cannot be written by the Actor (SPEC §2 boundary 2). Independent Verifier
//     transcripts are hidden too.
//  3. Bash: hidden paths and tokens (heuristic, lib/guard/bash.mjs), human-only cc-rsi subcommands
//     (J2-6), Verifier session ids.
// Fails open on errors (main-session hooks never block on a cc-rsi bug).

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ccRsiHome, globalLayout } from '../core/paths.mjs'
import { commandWords, scanBash } from '../guard/bash.mjs'
import { canonicalRoot, isUnder, toolPathArgs } from '../guard/paths.mjs'
import { claudeConfigDir } from '../runtime/models.mjs'
import { sessionContext } from '../interactive/session.mjs'
import { readTaskSync } from '../interactive/task.mjs'
import { listLocksSync, lockCovering } from '../interactive/wslock.mjs'
import { allowPre, denyPre, failOpen, isRole } from './common.mjs'

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor'])
const LOCKED_TOOLS = new Set([...WRITE_TOOLS, ...SHELL_TOOLS])

/** Human-only cc-rsi subcommands (SPEC §11.8 rule 3; J2-6). */
export const HUMAN_ONLY_RE = /\bcc-rsi\b[^\n;&|]*\b(eval|unfreeze|restore|import|accept-external|prune|abandon|release-lock|cancel)\b/
/** `cc-rsi explore start|resume`, human-only unless `exploration.modelMayStart` (global config). */
export const EXPLORE_START_RE = /\bcc-rsi\b[^\n;&|]*\bexplore\s+(start|resume)\b/

const HUMAN_ONLY_REASON = 'cc-rsi: that command is human-only; ask the user to run it in a terminal'
const VIEW_READ_ONLY = 'the memory view is read-only; durable memory changes only through learn → memory_commit'
const SEARCH_COVERS_HOME = 'narrow the search path; it covers cc-rsi private state'
const HIDDEN_FROM_ROLE = /^(.*) is a harness-private path hidden from this role; it is not candidate evidence\.$/

function privateReason(path) {
  return `${path} is cc-rsi private state; it is not part of your task.`
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

/**
 * The `<home>/bin` spelling used anywhere but in command position (an argument or a redirection
 * target), or null. `~`, `$HOME` and `$CC_RSI_HOME` are expanded first, like scanBash.
 */
export function binAsArgument(command, { home, userHome, bins }) {
  let text = command.replace(/\$\{CC_RSI_HOME\}|\$CC_RSI_HOME(?![A-Za-z0-9_])/g, home)
  if (userHome) {
    text = text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, userHome)
    text = text.replace(/(^|[\s'"=:(`<>|;&])~(?=\/|$|[\s'";&|)<>])/g, (m, pre) => `${pre}${userHome}`)
  }
  if (!bins.some(bin => names(text, bin))) return null
  for (const { args } of commandWords(text)) {
    for (const arg of args) {
      const hit = bins.find(bin => names(arg, bin))
      if (hit) return hit
    }
  }
  return null
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
  const roleSessionIds = [state?.task?.verifier?.sessionId, state?.prevTask?.verifier?.sessionId].filter(s => typeof s === 'string' && s !== '')

  // (1) Workspace lock.
  if (LOCKED_TOOLS.has(tool)) {
    const locks = listLocksSync(g.locks)
    if (locks.length > 0) {
      const paths = [cwd]
      if (WRITE_TOOLS.has(tool)) paths.push(...toolPathArgs(tool, input, cwd, { userHome }).paths)
      for (const p of paths) {
        const lock = lockCovering(locks, p)
        if (lock) return { stdout: denyPre(lockReason(lock)) }
      }
      // A shell command run elsewhere that names a locked root (heuristic, like the Bash path scan).
      const command = SHELL_TOOLS.has(tool) && typeof input.command === 'string' ? input.command : null
      if (command !== null) {
        const named = locks.find(l => l.live !== false && typeof l.root === 'string' && l.root !== '/' && command.includes(l.root))
        if (named) return { stdout: denyPre(lockReason(named)) }
      }
    }
  }

  const homeRoots = spellings(home)
  const viewRoots = viewDir ? spellings(viewDir) : []
  const draftRoots = draftDir ? spellings(draftDir) : []
  const binRoots = spellings(g.bin)
  const transcriptRoots = [...new Set([join(userHome, '.claude', 'projects'), join(claudeConfigDir(env), 'projects')])].flatMap(spellings)

  // (2) File tools.
  if (FILE_TOOLS.has(tool)) {
    const { paths, search, write, invalid } = toolPathArgs(tool, input, cwd, { userHome })
    if (invalid) return {}
    let allowAll = paths.length > 0
    for (const p of paths) {
      if (search && homeRoots.some(h => isUnder(h, p)) && !under(p, viewRoots) && !under(p, draftRoots)) {
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
      if (roleSessionIds.length > 0) {
        if (under(p, transcriptRoots)) {
          const rel = p.split('/')
          if (rel.some(seg => roleSessionIds.some(id => seg.startsWith(id)))) {
            return { stdout: denyPre(`${p} is an independent Verifier transcript; it is not part of your task.`) }
          }
        }
        if (search && transcriptRoots.some(t => isUnder(t, p) || isUnder(p, t))) {
          return { stdout: denyPre('narrow the search path; it covers an independent Verifier transcript') }
        }
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
    const allowedPaths = [viewDir, g.bin, draftDir].filter(p => typeof p === 'string' && p !== '')
    const reason = scanBash(command, { hidden: [home], allowedPaths, home, userHome, recursionGuard: false, cwd })
    if (reason) {
      const m = HIDDEN_FROM_ROLE.exec(reason)
      return { stdout: denyPre(m ? privateReason(m[1]) : reason) }
    }
    // <home>/bin is exec-only for shell commands: the shim may be run, never written (a rewritten
    // shim would run Actor code when the user runs a human-only command in a terminal).
    const binArg = binAsArgument(command, { home, userHome, bins: spellings(g.bin) })
    if (binArg) return { stdout: denyPre(`${binArg} is cc-rsi private state; only running the cc-rsi shim is allowed.`) }
    const modelMayStart = ctx?.config?.exploration?.modelMayStart === true
    if (HUMAN_ONLY_RE.test(command) || (!modelMayStart && EXPLORE_START_RE.test(command))) return { stdout: denyPre(HUMAN_ONLY_REASON) }
    for (const id of roleSessionIds) {
      if (command.includes(id)) return { stdout: denyPre(`cc-rsi: ${id} is an independent Verifier session; its transcript is not part of your task.`) }
    }
  }
  return {}
}

/** PreToolUse guard entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  return failOpen('guard', () => guard(payload ?? {}, env), { env })
}

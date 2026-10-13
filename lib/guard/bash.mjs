// Heuristic Bash scanner for role children and the main-session guard (SPEC §10.6 `lib/guard/bash.mjs`).
//
// Bash read-hiding without an OS sandbox is heuristic (SPEC §16 item 1): the scanner denies
// commands that name a hidden root (absolute, `~`/`$HOME`-relative, or a relative path that
// resolves under one), that contain a hidden traversal token, that start Claude Code or cc-rsi
// again (recursion closure, J2-4), or that match a policy deny pattern (RSIAgent's rule that an
// external service cannot be rolled back, verifier-system.md F `_ROLLBACK_MIRROR_DESCRIPTION`).
// Imports only node:* and lib/guard (SPEC §3).

import { basename, resolve } from 'node:path'
import { canonicalRoot, isUnder, physicalPath } from './paths.mjs'

// ---------------------------------------------------------------- tokenizer

const SEGMENT = Symbol('segment')

/**
 * Shell-ish tokenization: quotes and backslashes are honoured; newline, `;`, `&&`, `||`, `|`,
 * `&`, `(`, `)`, `$(`, backticks and `{`/`}` words split commands. A command substitution inside
 * double quotes is tokenized as normal shell text until its closing `)` or backtick, so
 * `"$(claude …)"` is seen as the command `claude`. `<` and `>` split words.
 * Returns an array of word strings and SEGMENT markers.
 */
function tokenize(command) {
  const out = []
  let cur = ''
  let has = false
  let quote = null
  // Command substitutions opened inside double quotes: {closer: ')' | '`', depth}.
  const frames = []
  const push = () => {
    if (has) out.push(cur)
    cur = ''
    has = false
  }
  const seg = () => {
    push()
    if (out.length > 0 && out[out.length - 1] !== SEGMENT) out.push(SEGMENT)
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '"') { quote = null; continue }
      if (c === '\\' && next !== undefined && '"\\$`\n'.includes(next)) { if (next !== '\n') cur += next; i++; continue }
      if ((c === '$' && next === '(') || c === '`') {
        // A command substitution inside double quotes runs a command: tokenize it as shell text.
        seg()
        frames.push({ closer: c === '$' ? ')' : '`', depth: 0 })
        quote = null
        if (c === '$') i++
        continue
      }
      cur += c
      has = true
      continue
    }
    const frame = frames[frames.length - 1]
    if (frame && c === frame.closer && (c === '`' || frame.depth === 0)) {
      seg()
      frames.pop()
      quote = '"'
      continue
    }
    if (c === '\\') {
      if (next === '\n') { i++; continue }
      if (next !== undefined) { cur += next; has = true; i++ }
      continue
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue }
    if (c === ' ' || c === '\t' || c === '\r') { push(); continue }
    if (c === '(' && frame) frame.depth++
    if (c === ')' && frame && frame.depth > 0) frame.depth--
    if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') { seg(); continue }
    if (c === '&' || c === '|') {
      if (c === '&' && next === '>') { push(); i++; continue } // &> redirection
      seg()
      if (next === c) i++
      continue
    }
    if (c === '$' && next === '(') { seg(); i++; if (frame) frame.depth++; continue }
    if (c === '<' || c === '>') { push(); continue }
    if (c === '#' && !has) {
      // A comment runs to the end of the line.
      while (i < command.length && command[i] !== '\n') i++
      seg()
      continue
    }
    cur += c
    has = true
  }
  push()
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'case', 'esac', 'in', 'select', 'function', 'coproc', '[[', ']]'])
// Prefix commands whose operand is another command (SPEC §10.6 list plus close relatives).
const PREFIXES = new Set(['env', 'sudo', 'doas', 'exec', 'nohup', 'time', 'command', 'builtin', 'nice', 'timeout', 'setsid', 'stdbuf', 'xargs', 'watch', 'unbuffer', 'chronic', 'ionice', 'taskset', 'flock'])
// Options of those prefixes that take a separate argument.
const OPTION_ARGS = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  xargs: new Set(['-I', '-i', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']),
  watch: new Set(['-n', '--interval', '-d']),
  ionice: new Set(['-c', '-n', '-p']),
  taskset: new Set(['-p', '-c']),
  flock: new Set(['-w', '-E', '-c']),
  stdbuf: new Set([]),
}

/** Index of the real command word in a segment's tokens after skipping assignments, keywords and prefixes. */
function commandStart(tokens) {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (ASSIGNMENT.test(t) || KEYWORDS.has(t)) { i++; continue }
    const base = basename(t)
    if (!PREFIXES.has(base)) break
    i++
    const takesArg = OPTION_ARGS[base] ?? new Set()
    // Options of the prefix (and, for env, assignments; for timeout/flock, the duration/lock operand).
    while (i < tokens.length) {
      const o = tokens[i]
      if (o === '--') { i++; break }
      if (base === 'env' && ASSIGNMENT.test(o)) { i++; continue }
      if (o.startsWith('-') && o.length > 1) {
        i += takesArg.has(o) ? 2 : 1
        continue
      }
      break
    }
    if ((base === 'timeout' || base === 'flock') && i < tokens.length) i++ // DURATION / lock file operand
  }
  return i
}

/**
 * Splits `command` into simple commands (SPEC §10.6): newline `;` `&&` `||` `|` `(` `)` `$(` and
 * backticks separate them; leading `VAR=val`, `env`, `sudo`, `exec`, `nohup`, `time`, `command`,
 * `nice`, `timeout N` (and similar wrappers) are skipped. Returns `[{ word, args }]`.
 */
export function commandWords(command) {
  if (typeof command !== 'string' || command === '') return []
  const tokens = tokenize(command)
  const out = []
  let current = []
  const flush = () => {
    if (current.length > 0) {
      const start = commandStart(current)
      if (start < current.length) out.push({ word: current[start], args: current.slice(start + 1) })
    }
    current = []
  }
  for (const t of tokens) {
    if (t === SEGMENT) flush()
    else current.push(t)
  }
  flush()
  return out
}

/** The word tokens of each simple command, in order (prefixes and assignments included). */
function rawSegments(command) {
  const out = []
  let current = []
  for (const t of tokenize(command)) {
    if (t === SEGMENT) {
      if (current.length > 0) out.push(current)
      current = []
    } else current.push(t)
  }
  if (current.length > 0) out.push(current)
  return out
}

// ---------------------------------------------------------------- recursion closure (J2-4)

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'busybox'])
const RECURSIVE_WORDS = new Set(['claude', 'claude-code', 'cc-rsi'])
const PACKAGE_RUNNERS = new Set(['npx', 'pnpm', 'pnpx', 'bunx', 'bun', 'yarn', 'npm'])

function recursionIn(command, depth) {
  if (depth > 4) return null
  for (const { word, args } of commandWords(command)) {
    const base = basename(word)
    if (RECURSIVE_WORDS.has(base)) return base
    if ((base === 'node' || base === 'nodejs' || base === 'bun' || base === 'deno') && args.length > 0) {
      const first = args.find(a => !a.startsWith('-')) ?? ''
      if (/cc-rsi|claude-code/.test(first)) return `${base} ${first}`
    }
    if (PACKAGE_RUNNERS.has(base) && args.some(a => a.includes('@anthropic-ai/claude-code'))) return `${base} @anthropic-ai/claude-code`
    if (SHELLS.has(base)) {
      const ci = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
      if (ci >= 0 && ci + 1 < args.length) {
        const inner = recursionIn(args[ci + 1], depth + 1)
        if (inner) return inner
      }
    }
    if (base === 'eval' && args.length > 0) {
      const inner = recursionIn(args.join(' '), depth + 1)
      if (inner) return inner
    }
    if (base === 'find') {
      for (let k = 0; k < args.length - 1; k++) {
        if (/^-(exec|execdir|ok|okdir)$/.test(args[k])) {
          const target = basename(args[k + 1])
          if (RECURSIVE_WORDS.has(target)) return target
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------- deny patterns

const ROLLBACK_RULE = 'State in an external service outside this workspace cannot be rolled back: observe such services without sending mutating requests.'

function denyRule(source, flags, what) {
  return Object.freeze({ source, flags, reason: `cc-rsi: refused: ${what} could change state outside the candidate, which the harness cannot roll back. ${ROLLBACK_RULE}` })
}

/**
 * External-mutation patterns for a Verifier whose shell is not sandboxed (SPEC §10.6 `bashDeny`,
 * config `isolation.verifierBashDeny`). The reason cites RSIAgent's rollback rule verbatim
 * (verifier-system.md F, `_ROLLBACK_MIRROR_DESCRIPTION`).
 */
export const MUTATION_BASH_DENY = Object.freeze([
  denyRule(String.raw`\bgit\b[^\n;&|]*\bpush\b`, '', 'git push'),
  denyRule(String.raw`\bgit\b[^\n;&|]*\bremote\s+set-url\b`, '', 'git remote set-url'),
  denyRule(String.raw`\bcurl\b[^\n;&|]*(\s(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b|\s--data(-[a-z]+)?\b|\s-d(\s|['"])|\s--json\b|\s(-F|--form)\b|\s(-T|--upload-file)\b)`, 'i', 'a mutating curl request'),
  denyRule(String.raw`\bwget\b[^\n;&|]*--(post|method|body)`, 'i', 'a mutating wget request'),
  denyRule(String.raw`(^|[\s;&|(\x60])ssh\s`, '', 'ssh'),
  denyRule(String.raw`(^|[\s;&|(\x60])scp\s`, '', 'scp'),
  denyRule(String.raw`\brsync\b[^\n;&|]*\s[^\s:'"]*[A-Za-z0-9_.@-]+:`, '', 'rsync to a remote host'),
  denyRule(String.raw`(^|[\s;&|(\x60])sudo\s`, '', 'sudo'),
  denyRule(String.raw`\bkill\s+(-9|-KILL|-SIGKILL|-s\s+KILL)\s+-?1\b`, '', 'kill -9 1'),
  denyRule(String.raw`\bdocker\s+(container\s+)?(rm|stop|kill)\b`, '', 'docker rm/stop/kill'),
  denyRule(String.raw`\bkubectl\b[^\n;&|]*\b(apply|delete)\b`, '', 'kubectl apply/delete'),
])

/** Normalizes a bashDeny entry (RegExp or `{source, flags, reason}`) to `{ re, reason }`; throws on an invalid pattern. */
function compileDeny(entry) {
  if (entry instanceof RegExp) return { re: new RegExp(entry.source, entry.flags.replace(/[gy]/g, '')), reason: `cc-rsi: refused by the role policy (${entry.source})` }
  if (!entry || typeof entry.source !== 'string') throw new TypeError('bashDeny entry without a source')
  const flags = typeof entry.flags === 'string' ? entry.flags.replace(/[gy]/g, '') : ''
  return { re: new RegExp(entry.source, flags), reason: typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : `cc-rsi: refused by the role policy (${entry.source})` }
}

// ---------------------------------------------------------------- path heuristics

/** Hidden-path deny reason (RSIAgent Look guard, isolation-harness-markers.md §5). */
export function hiddenReason(path) {
  return `${path} is a harness-private path hidden from this role; it is not candidate evidence.`
}

// Characters that continue a path segment; ':' ',' and '=' separate list entries and option values.
const PATH_CHAR = /[A-Za-z0-9._\-~+@%]/
const SENTINEL = '\u0000ALLOWED\u0000'

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `~/`, `$HOME/`, `${HOME}/` → `userHome/`; `$CC_RSI_HOME`, `${CC_RSI_HOME}` → `home` (SPEC §10.6 step 1). */
function expandHomes(command, { home, userHome }) {
  let out = command
  if (typeof home === 'string' && home !== '') out = out.replace(/\$\{CC_RSI_HOME\}|\$CC_RSI_HOME(?![A-Za-z0-9_])/g, home)
  if (typeof userHome === 'string' && userHome !== '') {
    out = out.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, userHome)
    out = out.replace(/(^|[\s'"=:(`<>|;&])~(?=\/|$|[\s'";&|)<>])/g, (m, pre) => `${pre}${userHome}`)
  }
  return out
}

/** Replaces each allowed path (longest first) when it ends at a path boundary (SPEC §10.6 step 2). */
function maskAllowed(text, allowed) {
  let out = text
  for (const a of allowed) {
    if (a === '/' || a === '') continue
    const re = new RegExp(`${escapeRegExp(a)}(?=$|/|[^A-Za-z0-9._\\-~+@%])`, 'g')
    out = out.replace(re, SENTINEL)
  }
  return out
}

/** Whether `text` contains `path` followed by a path boundary (end, '/', or a non-path character). */
function containsAtBoundary(text, path) {
  let from = 0
  for (;;) {
    const at = text.indexOf(path, from)
    if (at < 0) return false
    const after = text[at + path.length]
    if (after === undefined || after === '/' || !PATH_CHAR.test(after)) return true
    from = at + 1
  }
}

function uniq(list) {
  return [...new Set(list.filter(x => typeof x === 'string' && x !== ''))]
}

/** Lexical and physical spellings of each root, without a trailing slash. */
function spellings(roots) {
  const out = []
  for (const r of roots ?? []) {
    if (typeof r !== 'string' || r === '') continue
    const lexical = resolve(r)
    out.push(lexical)
    try { out.push(canonicalRoot(lexical)) } catch { /* keep the lexical form */ }
  }
  return uniq(out)
}

/** Candidate path operands of a token: the token, the value of `--opt=value`/`VAR=value`, and `:`-separated parts. */
function pathOperands(token) {
  const out = [token]
  const eq = token.indexOf('=')
  if (eq > 0) out.push(token.slice(eq + 1))
  for (const part of token.split(':')) if (part !== token) out.push(part)
  return out.filter(t => t !== '' && (t.includes('/') || t === '..' || t === '.' || t.startsWith('~')))
}

/**
 * Scans one Bash command against a role policy (SPEC §10.6). Returns a deny reason or null.
 *  1. `~/`, `$HOME/`, `${HOME}/` expand to `userHome`; `$CC_RSI_HOME` to `home`.
 *  2. Each `allowedPaths` entry (longest first) is masked when it ends at a path boundary.
 *  3. Deny when the result contains a hidden absolute path at a path boundary, or a hidden token.
 *     The same check runs on a quote-stripped copy, and (extension) every path-like word is resolved
 *     lexically and physically against `cwd` and denied when it lands under a hidden root that is not
 *     inside an allowed path, which catches relative traversal such as `../w002/secret`.
 *  4. Recursion: a command word `claude`/`claude-code`/`cc-rsi`; `node`/`nodejs` whose first operand
 *     matches /cc-rsi|claude-code/; `npx`/`pnpm`/`bunx`/`yarn`/`npm` naming `@anthropic-ai/claude-code`;
 *     also inside `sh -c`, `eval` and `find -exec`.
 *  5. `bashDeny` patterns against the original command.
 */
export function scanBash(command, { hidden = [], hiddenTokens = [], allowedPaths = [], home, userHome, recursionGuard = true,
  bashDeny = [], cwd } = {}) {
  if (typeof command !== 'string') return 'cc-rsi: malformed Bash call (the command is not a string)'
  const hiddenRoots = spellings(hidden).filter(h => h !== '/')
  const allowedRoots = spellings(allowedPaths).filter(a => a !== '/').sort((a, b) => b.length - a.length)
  const tokens = uniq(hiddenTokens)

  const normalized = expandHomes(command, { home, userHome })
  const variants = uniq([normalized, normalized.replace(/["'\\]/g, '')])
  for (const variant of variants) {
    const masked = maskAllowed(variant, allowedRoots)
    for (const h of hiddenRoots) if (containsAtBoundary(masked, h)) return hiddenReason(h)
    for (const t of tokens) if (masked.includes(t)) return hiddenReason(t)
  }

  // Semantic path check: resolve every path-like operand against the directory the command would be in
  // (the payload cwd, followed through `cd`/`pushd` within this command).
  if (hiddenRoots.length > 0) {
    let cur = typeof cwd === 'string' && cwd !== '' ? cwd : null
    const offending = candidate => {
      if (allowedRoots.some(a => isUnder(candidate, a))) return null
      return hiddenRoots.find(root => isUnder(candidate, root)) ?? null
    }
    for (const segment of rawSegments(normalized)) {
      // Once a `cd` left the role's own directories, bare words may name siblings ("cd .. && ls b").
      const outside = cur !== null && !allowedRoots.some(a => isUnder(cur, a))
      for (const raw of segment) {
        const operands = pathOperands(raw)
        if (outside && !raw.startsWith('-') && !operands.includes(raw)) operands.push(raw)
        for (const operand of operands) {
          const expanded = operand.startsWith('~') && userHome ? userHome + operand.slice(1) : operand
          if (!expanded.startsWith('/') && cur === null) continue
          const lexical = resolve(cur ?? '/', expanded)
          let physical = lexical
          try { physical = physicalPath(expanded, cur ?? '/') } catch { /* keep lexical */ }
          for (const candidate of uniq([lexical, physical])) {
            const h = offending(candidate)
            if (h) return hiddenReason(h)
          }
        }
      }
      const start = commandStart(segment)
      const word = segment[start]
      if ((word === 'cd' || word === 'pushd') && cur !== null) {
        const arg = segment.slice(start + 1).find(a => !a.startsWith('-'))
        if (arg === undefined || arg === '~') cur = userHome || cur
        else if (arg !== '-') cur = resolve(cur, arg.startsWith('~') && userHome ? userHome + arg.slice(1) : arg)
        let physicalCur = cur
        try { physicalCur = physicalPath(cur, '/') } catch { /* keep lexical */ }
        for (const candidate of uniq([cur, physicalCur])) {
          const h = offending(candidate)
          if (h) return hiddenReason(h)
        }
      }
    }
  }

  if (recursionGuard) {
    const hit = recursionIn(command, 0)
    if (hit) return `cc-rsi: role contexts may not start Claude Code or cc-rsi (${hit}); recursion is refused.`
  }

  for (const entry of bashDeny ?? []) {
    let rule
    try {
      rule = compileDeny(entry)
    } catch {
      return 'cc-rsi: the role policy holds an invalid bashDeny pattern; the command is refused (fail closed).'
    }
    if (rule.re.test(command)) return rule.reason
  }
  return null
}

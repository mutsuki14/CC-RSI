// Heuristic Bash scanner for role children and the main-session guard (SPEC §10.6 `lib/guard/bash.mjs`).
//
// Bash read-hiding without an OS sandbox is heuristic (SPEC §16 item 1): the scanner denies
// commands that name a hidden root (absolute, `~`/`$HOME`-relative, or a relative path that
// resolves under one), that contain a hidden traversal token, that start Claude Code or cc-rsi
// again (recursion closure, J2-4), or that match a policy deny pattern (RSIAgent's rule that an
// external service cannot be rolled back, verifier-system.md F `_ROLLBACK_MIRROR_DESCRIPTION`).
// Imports only node:* and lib/guard (SPEC §3).

import { readdirSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import { canonicalRoot, isUnder, physicalPath } from './paths.mjs'

// ---------------------------------------------------------------- tokenizer

const SEGMENT = Symbol('segment')
// Marks that the next word is the target of a redirection (`> f`, `2>> f`, `&> f`, `< f`, `<<EOF`).
const REDIRECT = Symbol('redirect')
// Marks the current segment as text of a here-document with a quoted delimiter (`<<'EOF'`).
const DATA = Symbol('data')

// Characters with no meaning to tokenize() inside single quotes, double quotes and unquoted text.
const SINGLE_RUN = /[^']+/y
const DOUBLE_RUN = /[^"\\$`]+/y
const PLAIN_RUN = /[A-Za-z0-9_.\/,:=+@%^~!?*[\]{}-]+/y

/**
 * Shell-ish tokenization: quotes and backslashes are honoured; newline, `;`, `&&`, `||`, `|`,
 * `&`, `(`, `)`, `$(`, backticks and `{`/`}` words split commands. A command substitution inside
 * double quotes is tokenized as normal shell text until its closing `)` or backtick, so
 * `"$(claude …)"` is seen as the command `claude`. `<` and `>` split words and are followed by a
 * REDIRECT marker (a file-descriptor number written directly before them, as in `2>`, is dropped;
 * `>&`, `>>`, `>|`, `<<`, `<<<`, `<>` and `<&` are one operator).
 * A here-document body (`<<EOF` … a line `EOF`) is cut out by lines, as the shell does (quotes in it
 * are literal), and tokenized on its own; the segments of a body whose delimiter is quoted
 * (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) carry a DATA marker: that text is not expanded by the shell.
 * Returns an array of word strings, SEGMENT, REDIRECT and DATA markers.
 */
function tokenize(command) {
  const out = []
  let cur = ''
  let has = false
  let quote = null
  let quotedWord = false
  // A pending `<<` whose delimiter is the next word, and the here-documents whose bodies start after
  // the next newline: { delim, quoted, dash }.
  let heredocNext = null
  const heredocs = []
  // Command substitutions opened inside double quotes: {closer: ')' | '`', depth}.
  const frames = []
  const push = () => {
    if (has) {
      out.push(cur)
      if (heredocNext) {
        heredocs.push({ delim: cur, quoted: quotedWord, dash: heredocNext.dash })
        heredocNext = null
      }
    }
    cur = ''
    has = false
    quotedWord = false
  }
  const seg = () => {
    push()
    if (out.length > 0 && out[out.length - 1] !== SEGMENT) out.push(SEGMENT)
  }
  // The bodies of the pending here-documents, which start after the newline at `at`; returns the
  // index of the last character consumed (the end of the last delimiter line).
  const bodies = at => {
    let pos = at + 1
    for (const doc of heredocs.splice(0)) {
      const lines = []
      while (pos <= command.length - 1) {
        let end = command.indexOf('\n', pos)
        if (end < 0) end = command.length
        const raw = command.slice(pos, end)
        const line = doc.dash ? raw.replace(/^\t+/, '') : raw
        pos = end + 1
        if (line === doc.delim) break
        lines.push(line)
      }
      seg()
      if (doc.quoted) out.push(DATA)
      for (const t of tokenize(lines.join('\n'))) {
        out.push(t)
        if (t === SEGMENT && doc.quoted) out.push(DATA)
      }
      seg()
    }
    return pos - 1
  }
  for (let i = 0; i < command.length; i++) {
    // Runs of characters that mean nothing to the tokenizer in the current state are taken whole.
    const run = quote === "'" ? SINGLE_RUN : quote === '"' ? DOUBLE_RUN : PLAIN_RUN
    run.lastIndex = i
    const m = run.exec(command)
    if (m !== null) {
      cur += m[0]
      has = true
      i += m[0].length - 1
      continue
    }
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
      if (next !== undefined) { cur += next; has = true; quotedWord = true; i++ }
      continue
    }
    if (c === "'" || c === '"') { quote = c; has = true; quotedWord = true; continue }
    if (c === ' ' || c === '\t' || c === '\r') { push(); continue }
    if (c === '(' && frame) frame.depth++
    if (c === ')' && frame && frame.depth > 0) frame.depth--
    if (c === '\n') {
      seg()
      if (heredocs.length > 0) i = bodies(i)
      continue
    }
    if (c === ';' || c === '(' || c === ')' || c === '`') { seg(); continue }
    if (c === '&' || c === '|') {
      if (c === '&' && next === '>') { // &> and &>> redirections
        push()
        i++
        if (command[i + 1] === '>') i++
        out.push(REDIRECT)
        continue
      }
      seg()
      if (next === c) i++
      continue
    }
    if (c === '$' && next === '(') { seg(); i++; if (frame) frame.depth++; continue }
    if (c === '<' || c === '>') {
      if (has && /^\d+$/.test(cur)) { cur = ''; has = false } else push() // `2>`: a descriptor, not a word
      if (c === '>' && (next === '>' || next === '|' || next === '&')) i++
      else if (c === '<' && next === '<') {
        i++
        if (command[i + 1] === '<') i++ // a here-string
        else {
          heredocNext = { dash: command[i + 1] === '-' }
          if (heredocNext.dash) i++
        }
      }
      else if (c === '<' && (next === '>' || next === '&')) i++
      out.push(REDIRECT)
      continue
    }
    if (c === '#' && !has) {
      // A comment runs to the end of the line.
      while (i < command.length && command[i] !== '\n') i++
      seg()
      if (i < command.length && heredocs.length > 0) i = bodies(i)
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
 * The simple commands of `command`, in order: `{ words, args, at, data }` where `words` are all word
 * tokens (prefixes, assignments and redirection targets included), `args` the words that are not
 * redirection targets, `at[k]` the index in `words` of `args[k]`, and `data` whether the segment is
 * text of a quoted here-document.
 */
function segmentsOf(command) {
  // The guard splits one command several times (path pass, command words, recursion closure); the
  // last few splits are kept (their arrays are only read).
  const known = SEGMENTS_MEMO.get(command)
  if (known !== undefined) return known
  const out = Object.freeze(splitSegments(command).map(seg => Object.freeze({
    words: Object.freeze(seg.words), args: Object.freeze(seg.args), at: Object.freeze(seg.at), data: seg.data,
  })))
  if (SEGMENTS_MEMO.size >= SEGMENTS_MEMO_MAX) SEGMENTS_MEMO.delete(SEGMENTS_MEMO.keys().next().value)
  SEGMENTS_MEMO.set(command, out)
  return out
}

const SEGMENTS_MEMO = new Map()
const SEGMENTS_MEMO_MAX = 8

function splitSegments(command) {
  const out = []
  let seg = { words: [], args: [], at: [], data: false }
  let redirect = false
  const flush = () => {
    if (seg.words.length > 0) out.push(seg)
    seg = { words: [], args: [], at: [], data: false }
    redirect = false
  }
  for (const t of tokenize(command)) {
    if (t === SEGMENT) flush()
    else if (t === DATA) seg.data = true
    else if (t === REDIRECT) redirect = true
    else {
      if (!redirect) {
        seg.at.push(seg.words.length)
        seg.args.push(t)
      }
      seg.words.push(t)
      redirect = false
    }
  }
  flush()
  return out
}

/**
 * Splits `command` into simple commands (SPEC §10.6): newline `;` `&&` `||` `|` `(` `)` `$(` and
 * backticks separate them; leading `VAR=val`, `env`, `sudo`, `exec`, `nohup`, `time`, `command`,
 * `nice`, `timeout N` (and similar wrappers) are skipped, and so are redirections written before the
 * command word. Returns `[{ word, args }]` (`args` include redirection targets).
 */
export function commandWords(command) {
  if (typeof command !== 'string' || command === '') return []
  const out = []
  for (const { words, args, at } of segmentsOf(command)) {
    const start = commandStart(args)
    if (start >= args.length) continue
    const index = at[start]
    const plain = new Set(at)
    out.push({ word: args[start], args: words.filter((w, i) => i > index || (i < index && !plain.has(i))) })
  }
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

/**
 * Replaces each allowed path (longest first) when it ends at a path boundary (SPEC §10.6 step 2),
 * together with the rest of that path word unless the rest climbs out (`..`): what lies below an
 * allowed directory is the role's own, so a hidden spelling inside it (`<scratch>/.tmp/claude-0`,
 * the role's own `…/.claude/projects/<slug>/<sid>/tool-results`) is not a match (r2-interactive-5).
 * The semantic pass still resolves every word unmasked.
 */
function maskAllowed(text, allowed) {
  let out = text
  for (const a of allowed) {
    if (a === '/' || a === '') continue
    const re = new RegExp(`${escapeRegExp(a)}(?=$|/|[^A-Za-z0-9._\\-~+@%])(/[^\\s'"\`;|&<>()$:,=]*)?`, 'g')
    out = out.replace(re, (m, rest) => (rest && rest.includes('..') ? `${SENTINEL}${rest}` : SENTINEL))
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
 * Deny reason when the path pass runs out of its time budget (a huge command): failing closed keeps
 * the hook well inside its timeout, after which Claude Code would run the command unchecked.
 */
export const TOO_LARGE = 'cc-rsi: this command is too large to check against hidden paths in time; split it into smaller commands, or write file contents with the Write tool.'

/** Default time budget of scanBash's path pass, in ms (hooks time out after 10 s). */
export const SCAN_BUDGET_MS = 4000

/**
 * Deny reason for a command that would walk a hidden root from above, like a Grep/Glob search rooted
 * above one (the role guard's search-root reason).
 */
export function coversHiddenReason(path) {
  return `${path} contains a harness-private path hidden from this role; narrow the search path (hidden paths are not candidate evidence).`
}

// ---------------------------------------------------------------- globs (security-6)

const GLOB_META = /[*?[]/
const BRACE_LIMIT = 64

/**
 * Bash brace expansion of one word (`a{b,c}` → `ab ac`), bounded to BRACE_LIMIT words. A sequence
 * `{x..y}` becomes `*` (it never yields a leading dot). Returns null when the limit is exceeded.
 */
function braceAlternatives(word) {
  if (!word.includes('{')) return [word]
  if (word.length > 4096 || word.split('{').length > BRACE_LIMIT) return null
  const out = []
  const queue = [word]
  while (queue.length > 0) {
    const w = queue.shift()
    const group = firstBraceGroup(w)
    if (!group) {
      out.push(w)
    } else {
      for (const part of group.parts) queue.push(w.slice(0, group.start) + part + w.slice(group.end + 1))
    }
    if (out.length + queue.length > BRACE_LIMIT) return null
  }
  return out
}

/** The first `{…}` group with a top-level comma or a `..` range: `{ start, end, parts }`, or null. */
function firstBraceGroup(w) {
  for (let start = w.indexOf('{'); start >= 0; start = w.indexOf('{', start + 1)) {
    let depth = 0
    const commas = []
    let end = -1
    for (let i = start; i < w.length; i++) {
      if (w[i] === '{') depth++
      else if (w[i] === '}' && --depth === 0) { end = i; break }
      else if (w[i] === ',' && depth === 1) commas.push(i)
    }
    if (end < 0) return null
    const body = w.slice(start + 1, end)
    if (commas.length > 0) {
      const parts = []
      let from = start + 1
      for (const c of [...commas, end]) { parts.push(w.slice(from, c)); from = c + 1 }
      return { start, end, parts }
    }
    if (/^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(\.\.-?\d+)?$/.test(body)) return { start, end, parts: ['*'] }
  }
  return null
}

/**
 * Whether the glob segment `glob` matches the file name `name` (bash rules: `*`, `?`, `[…]`; a
 * leading `.` must be matched literally unless dotglob is on; a leading `[` is treated as able to
 * match it, which only widens the check).
 */
function segmentMatches(glob, name, dotglob) {
  if (name.startsWith('.') && !dotglob && !glob.startsWith('.') && !glob.startsWith('[')) return false
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      let j = i + 1
      if (glob[j] === '!' || glob[j] === '^') j++
      if (glob[j] === ']') j++
      while (j < glob.length && glob[j] !== ']') j++
      if (j >= glob.length) { re += '\\['; continue }
      let body = glob.slice(i + 1, j).replace(/\\/g, '\\\\').replace(/^([!^]?)\]/, '$1\\]')
      if (body[0] === '!') body = `^${body.slice(1)}`
      re += `[${body}]`
      i = j
    } else re += escapeRegExp(c)
  }
  try {
    return new RegExp(`${re}$`).test(name)
  } catch {
    return true // an unparsable class: assume it matches (fail closed)
  }
}

/**
 * How an absolute glob `pattern` relates to the hidden root `root` (both resolved):
 * `inside` when some expansion is the root or lies below it, `ancestor` when some expansion is a
 * proper ancestor of it (which matters for commands that walk directory trees). `**` matches any
 * number of segments (not descending into dot directories without dotglob). `rests` lists, for each
 * way the pattern reaches the root, the pattern segments left below it (an expansion is
 * `root/<rest>`); `below` lists, for each ancestor expansion, the root's segments under it.
 */
function globReach(pattern, root, dotglob) {
  const g = pattern.split('/').filter(Boolean)
  const h = root.split('/').filter(Boolean)
  const out = { inside: false, ancestor: false, rests: [], below: [] }
  const seen = new Set()
  const walk = (i, j) => {
    const key = `${i},${j}`
    if (seen.has(key) || out.rests.length + out.below.length > 64) return
    seen.add(key)
    if (j === h.length) { out.inside = true; out.rests.push(g.slice(i)); return }
    if (i === g.length) { out.ancestor = true; out.below.push(h.slice(j)); return }
    if (g[i] === '**') {
      walk(i + 1, j)
      if (dotglob || !h[j].startsWith('.')) walk(i, j + 1)
      return
    }
    if (g[i] === h[j] || (GLOB_META.test(g[i]) && segmentMatches(g[i], h[j], dotglob))) walk(i + 1, j + 1)
  }
  walk(0, 0)
  // Past the bound the lists are incomplete: callers then assume the worst.
  out.overflow = out.rests.length + out.below.length > 64
  return out
}

// ---------------------------------------------------------------- tree walkers (security-6)

// Commands that walk whole directory trees. A directory operand that is an ancestor of a hidden root
// reaches it, like a Grep/Glob search rooted above one (paths.mjs searchCoversHidden).
//  always: recursive without a flag; flags/long: what makes it recursive; values/longValues: options
//  whose value is the next word; pattern: the first operand is a pattern unless patternFlags/patternLong
//  supply one; cwd: with no path operand the cwd is walked; dest: the last operand is a destination
//  (unless targetFlags/targetLong name it); chdir: options that change the base of later operands;
//  skipsHidden: dot entries are not entered unless hiddenFlags/hiddenLong (or `unrestricted` given
//  `count` times) say so; depth: options whose value limits how deep the walk goes (r2-overblock-6).
const GREP_LIKE = {
  flags: 'rR', long: ['--recursive', '--dereference-recursive'], values: 'efmABCdDX',
  longValues: ['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude',
    '--exclude-dir', '--exclude-from', '--label', '--binary-files', '--devices', '--directories'],
  pattern: true, patternFlags: 'ef', patternLong: ['--regexp', '--file'], cwd: true,
}
const COPY_LIKE = { values: 'tS', longValues: ['--target-directory', '--suffix'], dest: true, targetFlags: 't', targetLong: ['--target-directory'] }
const MODE_LIKE = { flags: 'R', long: ['--recursive'], longValues: ['--reference'] }
const FD_LIKE = {
  always: true, values: 'dtexXEcjS',
  longValues: ['--max-depth', '--min-depth', '--exact-depth', '--type', '--extension', '--exec', '--exec-batch', '--exclude', '--changed-within',
    '--changed-before', '--size', '--owner', '--threads', '--max-results', '--ignore-file', '--search-path', '--base-directory'],
  pattern: true, cwd: true, chdir: ['--base-directory'], pathValues: ['--search-path'],
  skipsHidden: true, hiddenFlags: 'Hu', hiddenLong: ['--hidden', '--unrestricted'], depth: ['d', '--max-depth', '--exact-depth'],
}
const TREE_COMMANDS = new Map(Object.entries({
  grep: GREP_LIKE,
  egrep: GREP_LIKE,
  fgrep: GREP_LIKE,
  rg: {
    always: true, values: 'efgtTmABCjMEdr',
    longValues: ['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--after-context', '--before-context', '--context',
      '--threads', '--max-columns', '--encoding', '--max-depth', '--replace', '--type-add', '--pre', '--pre-glob', '--sort', '--sortr', '--max-filesize'],
    pattern: true, patternFlags: 'ef', patternLong: ['--regexp', '--file', '--files', '--type-list'], cwd: true,
    // rg skips dot entries unless --hidden/-. or -uu (a single -u is only --no-ignore).
    skipsHidden: true, hiddenFlags: '.', hiddenLong: ['--hidden'], unrestricted: { flag: 'u', long: '--unrestricted', count: 2 }, depth: ['d', '--max-depth'],
  },
  ag: {
    always: true, values: 'ABCmpGg', longValues: ['--ignore', '--ignore-dir', '--depth', '--path-to-ignore', '--pager', '--after', '--before', '--context', '--max-count'],
    pattern: true, patternFlags: 'g', cwd: true, skipsHidden: true, hiddenFlags: 'u', hiddenLong: ['--hidden', '--unrestricted'],
  },
  ack: { always: true, values: 'ABCmg', longValues: ['--type', '--ignore-dir', '--match', '--after-context', '--before-context', '--context', '--max-count'], pattern: true, patternFlags: 'fg', patternLong: ['--match'], cwd: true },
  fd: FD_LIKE,
  fdfind: FD_LIKE,
  du: { always: true, values: 'dBtX', longValues: ['--max-depth', '--block-size', '--threshold', '--exclude-from', '--exclude', '--files0-from', '--time-style'], cwd: true },
  tree: { always: true, values: 'LPIoHT', longValues: ['--charset', '--filelimit', '--timefmt', '--sort'], cwd: true, skipsHidden: true, hiddenFlags: 'a', depth: ['L'] },
  ls: {
    flags: 'R', long: ['--recursive'], values: 'IwT', longValues: ['--ignore', '--hide', '--width', '--tabsize', '--format', '--sort', '--time-style', '--quoting-style', '--indicator-style', '--block-size'],
    cwd: true, skipsHidden: true, hiddenFlags: 'aA', hiddenLong: ['--all', '--almost-all'],
  },
  cp: { ...COPY_LIKE, flags: 'rRa', long: ['--recursive', '--archive'] },
  mv: { ...COPY_LIKE, always: true },
  rsync: {
    flags: 'ra', long: ['--recursive', '--archive'], values: 'efBT',
    longValues: ['--rsh', '--exclude', '--include', '--filter', '--exclude-from', '--include-from', '--files-from', '--temp-dir', '--log-file', '--chmod', '--chown',
      '--block-size', '--port', '--password-file', '--partial-dir', '--backup-dir', '--compare-dest', '--copy-dest', '--link-dest', '--suffix', '--rsync-path', '--out-format', '--timeout'],
    dest: true,
  },
  scp: { flags: 'r', values: 'cFiJlopPS', dest: true },
  rm: { flags: 'rR', long: ['--recursive'] },
  chmod: MODE_LIKE,
  chown: MODE_LIKE,
  chgrp: MODE_LIKE,
  diff: { flags: 'r', long: ['--recursive'], values: 'xXIFSLCUD', longValues: ['--exclude', '--exclude-from', '--ignore-matching-lines', '--starting-file', '--label', '--from-file', '--to-file', '--context', '--unified'] },
  zip: { flags: 'rR', long: ['--recurse-paths'], values: 'bnOtTZ' },
  tar: {
    always: true, values: 'CfTXbKNgVL',
    longValues: ['--directory', '--file', '--files-from', '--exclude-from', '--blocking-factor', '--newer', '--listed-incremental', '--label', '--tape-length',
      '--exclude', '--transform', '--owner', '--group', '--mode'],
    chdir: ['C', '--directory'],
  },
}))

/** getopt-style parse: `[{ kind: 'pos'|'opt', name?, value? , text? }]` (short options split per letter). */
function parseOptions(args, spec) {
  const values = spec.values ?? ''
  const longValues = new Set(spec.longValues ?? [])
  const items = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      for (const rest of args.slice(i + 1)) items.push({ kind: 'pos', text: rest })
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq > 0 ? a.slice(0, eq) : a
      if (eq > 0) items.push({ kind: 'opt', name, value: a.slice(eq + 1) })
      else if (longValues.has(name) && i + 1 < args.length) items.push({ kind: 'opt', name, value: args[++i] })
      else items.push({ kind: 'opt', name })
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const letter = a[k]
        if (values.includes(letter)) {
          if (k + 1 < a.length) items.push({ kind: 'opt', name: letter, value: a.slice(k + 1) })
          else items.push({ kind: 'opt', name: letter, value: i + 1 < args.length ? args[++i] : undefined })
          break
        }
        items.push({ kind: 'opt', name: letter })
      }
      continue
    }
    items.push({ kind: 'pos', text: a })
  }
  return items
}

/** `find [-H|-L|-P|-D x|-Olevel] [path…] [expression]`: the start paths. */
function findRoots(args) {
  let i = 0
  while (i < args.length && (/^-(H|L|P|O\d*)$/.test(args[i]) || args[i] === '-D')) i += args[i] === '-D' ? 2 : 1
  const roots = []
  for (; i < args.length; i++) {
    const a = args[i]
    if ((a.startsWith('-') && a.length > 1) || a === '(' || a === '!' || a === ')' || a === ',') break
    roots.push(a)
  }
  return roots
}

/** A non-negative integer option value, or null. */
function depthValue(text) {
  return typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : null
}

/** `path` spelled relative to `base` (a later `-C dir` style base), or `path` itself when absolute. */
function under(base, path) {
  if (base === null || path.startsWith('/') || path.startsWith('~')) return path
  return `${base}/${path}`
}

/** Whether `word` is a command the tree-walk rule knows (whether or not these arguments make it walk). */
export function isTreeCommand(word) {
  const name = basename(word)
  return name === 'find' || TREE_COMMANDS.has(name)
}

/**
 * The directories a tree-walking command walks: `{ operands, skipsHidden, maxDepth }` with operand
 * spellings relative to the command's cwd (absolute, `~`-relative or relative), or null when `word`
 * does not walk directory trees with these arguments. `skipsHidden`: the walk never enters dot
 * entries below an operand (rg, fd, ag, tree, `ls -R` without their show-hidden options);
 * `maxDepth`: entries deeper than this many levels below an operand are not reached (`find
 * -maxdepth`, `tree -L`, `rg --max-depth`, `fd -d`), or null (r2-overblock-6).
 */
export function treeOperands(word, args) {
  const name = basename(word)
  if (name === 'find') {
    const roots = findRoots(args)
    let maxDepth = null
    for (let k = 0; k < args.length - 1; k++) {
      if (args[k] === '-maxdepth') {
        const n = depthValue(args[k + 1])
        if (n !== null) maxDepth = maxDepth === null ? n : Math.max(maxDepth, n)
      }
    }
    return { operands: roots.length > 0 ? roots : ['.'], skipsHidden: false, maxDepth }
  }
  const spec = TREE_COMMANDS.get(name)
  if (!spec) return null
  const items = parseOptions(args, spec)
  const opts = items.filter(x => x.kind === 'opt')
  const has = (letters, longs) => opts.some(o => (o.name.length === 1 && (letters ?? '').includes(o.name)) || (longs ?? []).includes(o.name))
  let recursive = spec.always === true || has(spec.flags, spec.long)
  if (!recursive && spec === GREP_LIKE) recursive = opts.some(o => (o.name === 'd' || o.name === '--directories') && o.value === 'recurse')
  if (!recursive) return null
  const walked = []
  const positionals = []
  let base = null
  for (const item of items) {
    if (item.kind === 'pos') positionals.push(under(base, item.text))
    else if (typeof item.value !== 'string') continue
    else if ((spec.chdir ?? []).includes(item.name)) base = under(base, item.value) // later operands are relative to it
    else if ((spec.pathValues ?? []).includes(item.name)) walked.push(under(base, item.value))
  }
  if (spec.pattern && !has(spec.patternFlags, spec.patternLong)) positionals.shift()
  if (spec.dest && !has(spec.targetFlags, spec.targetLong) && positionals.length >= 2) positionals.pop()
  if (positionals.length === 0 && spec.cwd) positionals.push(base ?? '.')
  let skipsHidden = spec.skipsHidden === true && !has(spec.hiddenFlags, spec.hiddenLong)
  if (skipsHidden && spec.unrestricted) {
    const { flag, long, count } = spec.unrestricted
    if (opts.filter(o => o.name === flag || o.name === long).length >= count) skipsHidden = false
  }
  let maxDepth = null
  for (const o of opts) {
    if (!(spec.depth ?? []).includes(o.name)) continue
    const n = depthValue(o.value)
    if (n !== null) maxDepth = n // the last one wins, as getopt parsers do
  }
  return { operands: [...walked, ...positionals], skipsHidden, maxDepth }
}

/**
 * Whether a walk from `from` reaches the contents of `root` (a proper descendant of it), given the
 * walk's `skipsHidden`/`maxDepth`: the contents of `root` lie `depth(root) + 1` levels below `from`.
 */
function walkReaches(segments, walk) {
  if (walk?.skipsHidden && segments.some(segment => segment.startsWith('.'))) return false
  if (typeof walk?.maxDepth === 'number' && segments.length >= walk.maxDepth) return false
  return true
}

/** Resolves one operand spelling against `cur` (`~`, `$PWD` expanded): its lexical and physical forms, or null. */
function placeOperand(operand, cur, userHome, cache = null) {
  const key = `${cur}\u0000${operand}`
  if (cache?.places.has(key)) return cache.places.get(key)
  let expanded = operand
  if (expanded.startsWith('~') && userHome) expanded = userHome + expanded.slice(1)
  else if (cur !== null && /^\$(PWD|\{PWD\})(?=\/|$)/.test(expanded)) expanded = cur + expanded.replace(/^\$(PWD|\{PWD\})/, '')
  let out = null
  if (expanded.startsWith('/') || cur !== null) {
    const lexical = resolve(cur ?? '/', expanded)
    let physical = lexical
    try {
      physical = cache ? listedPhysical(expanded, cur ?? '/', cache) : physicalPath(expanded, cur ?? '/')
    } catch { /* keep lexical */ }
    out = uniq([lexical, physical])
  }
  cache?.places.set(key, out)
  return out
}

/**
 * physicalPath(`spelled`, `base`) with the scan's memo, found by directory listings: a path whose
 * component is not an entry of its (listable) directory does not exist below that component, so its
 * physical form is that directory's physical form plus the rest, which is what physicalPath computes
 * (its deepest existing prefix). One listing per directory replaces a failing realpath per word, the
 * bulk of a large here-document or script (r2-overblock-8). `.`/`..` components and directories that
 * cannot be listed take physicalPath itself.
 */
function listedPhysical(spelled, base, cache) {
  const absolute = spelled.startsWith('/')
  const parts = spelled.split('/').filter(part => part !== '')
  let dir = absolute ? '/' : base
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]
    if (part === '.' || part === '..') break
    const listed = isListed(dir, part, cache)
    if (listed === null) break
    if (!listed) return resolve(physicalPath(dir, '/', cache.real), ...parts.slice(k))
    dir = dir === '/' ? `/${part}` : `${dir}/${part}`
  }
  return physicalPath(spelled, base, cache.real)
}

const ASCII = /^[\x00-\x7f]*$/

/**
 * Whether `name` may open an entry of directory `dir`: false only when it certainly cannot, null when
 * a listing cannot tell. Names compare without ASCII case, since a case-insensitive filesystem (the
 * macOS default) opens `LINK` through an entry `link`; a non-ASCII name, or a directory holding one
 * (Unicode case folding and normalization), is left to realpath.
 */
function isListed(dir, name, cache) {
  if (!ASCII.test(name)) return null
  if (!cache.dirs.has(dir)) {
    let names = null
    try {
      const list = readdirSync(dir)
      names = list.every(entry => ASCII.test(entry)) ? new Set(list.map(entry => entry.toLowerCase())) : null
    } catch { names = null }
    cache.dirs.set(dir, names)
  }
  const names = cache.dirs.get(dir)
  return names === null ? null : names.has(name.toLowerCase())
}

/**
 * `isUnder` for paths that are already normalized and absolute (resolve() or realpath output, no
 * trailing slash): a plain prefix test, which the path pass runs for every operand and root.
 */
function within(child, parent) {
  if (child === parent || parent === '/') return child.startsWith('/')
  return child.startsWith(parent) && child[parent.length] === '/'
}

/** The path segments from `from` down to its descendant `to`. */
function segmentsBetween(from, to) {
  return relative(from, to).split(sep).filter(Boolean)
}

/**
 * The semantic path pass of scanBash over one (home-expanded) command, starting in `cur`. Every
 * path-like operand, brace-expanded, is resolved lexically and physically; a plain path is denied
 * when it lands under a hidden root outside the allowed paths, a glob when one of its expansions
 * could. For a command that walks directory trees (`grep -r`, `find`, `du`, `ls -R`, `cp -r`, `tar`
 * …), an operand directory (or the cwd when it names none) that is an ancestor of a hidden root is
 * denied too, as is a glob that could expand to one. `sh -c` and `eval` strings are scanned the same
 * way (bounded depth). `cd`/`pushd` move `cur` for later commands.
 */
function semanticPass(text, cur, ctx, depth) {
  const { hiddenRoots, walkRoots, allowedRoots, userHome, dotglob, covers, cache } = ctx
  const offending = candidate => {
    if (allowedRoots.some(a => within(candidate, a))) return null
    return hiddenRoots.find(root => within(candidate, root)) ?? null
  }
  // Glob remainders may hold `..`: those paths are resolved first.
  const allowedPath = path => allowedRoots.some(a => isUnder(path, a))
  // `walk` is null for a plain operand, else the walk's `{ skipsHidden, maxDepth }`.
  const checkCandidates = (candidates, walk) => {
    for (const candidate of candidates) {
      // Literal first: metacharacters may also be part of real directory names (the cwd).
      const h = offending(candidate)
      if (h) return hiddenReason(h)
      if (walk) {
        const root = walkRoots.find(r => r !== candidate && within(r, candidate) && walkReaches(segmentsBetween(candidate, r), walk))
        if (root) return covers(candidate, root)
      }
      if (!GLOB_META.test(candidate)) continue
      // Every expansion of a glob whose literal spelling lies in an allowed path stays inside it.
      const allowed = allowedRoots.some(a => within(candidate, a))
      for (const root of hiddenRoots) {
        const reach = globReach(candidate, root, dotglob)
        // An expansion inside the root is fine when what the glob leaves below it stays in an allowed
        // path (`~/.claude/projects/*/memory/MEMORY.md` with `<slug>/memory` allowed; r2-overblock-2).
        if (reach.inside && !allowed && (reach.overflow || reach.rests.some(rest => !allowedPath([root, ...rest].join('/'))))) return hiddenReason(root)
        if (walk && reach.ancestor && walkRoots.includes(root) && (reach.overflow || reach.below.some(below => walkReaches(below, walk)))) return covers(candidate, root)
      }
    }
    return null
  }
  const checkOperand = (operand, walk) => {
    if (Date.now() > ctx.deadline) return TOO_LARGE
    // A plain operand's verdict depends only on it and the directory: repeated words are judged once.
    const key = walk ? null : `${cur}\u0000${operand}`
    if (key !== null && cache?.checks.has(key)) return cache.checks.get(key)
    const verdict = judgeOperand(operand, walk)
    if (key !== null) cache?.checks.set(key, verdict)
    return verdict
  }
  const judgeOperand = (operand, walk) => {
    const alternatives = braceAlternatives(operand)
    if (alternatives === null) {
      // Too many brace alternatives: judge the literal prefix (fail closed when it is near a hidden root).
      const cut = operand.search(/[{*?[]/)
      const literal = operand.slice(0, cut < 0 ? operand.length : cut)
      const dir = literal.includes('/') ? literal.slice(0, literal.lastIndexOf('/')) || '/' : '.'
      for (const candidate of placeOperand(dir, cur, userHome, cache) ?? []) {
        const root = hiddenRoots.find(r => isUnder(candidate, r) || isUnder(r, candidate))
        if (root && !allowedRoots.some(a => isUnder(candidate, a))) return hiddenReason(root)
      }
      return null
    }
    for (const alternative of alternatives) {
      const candidates = placeOperand(alternative, cur, userHome, cache)
      if (candidates === null) continue
      const reason = checkCandidates(candidates, walk)
      if (reason) return reason
    }
    return null
  }

  for (const { words, args, data } of segmentsOf(text)) {
    // Once a `cd` left the role's own directories, bare words may name siblings ("cd .. && ls b").
    // Not in quoted here-document text, which the shell never expands (path-like words still count;
    // r2-overblock-8: every word of a large heredoc would otherwise be resolved).
    const outside = !data && cur !== null && !allowedRoots.some(a => isUnder(cur, a))
    for (const raw of words) {
      const operands = pathOperands(raw)
      if (outside && !raw.startsWith('-') && !operands.includes(raw)) operands.push(raw)
      for (const operand of operands) {
        const reason = checkOperand(operand, null)
        if (reason) return reason
      }
    }
    const start = commandStart(args)
    const word = args[start]
    if (word === undefined) continue
    const rest = args.slice(start + 1)
    const walk = treeOperands(word, rest)
    for (const operand of walk?.operands ?? []) {
      const reason = checkOperand(operand, walk)
      if (reason) return reason
    }
    if (depth < 3) {
      let inner = null
      if (SHELLS.has(basename(word))) {
        const ci = rest.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
        if (ci >= 0 && ci + 1 < rest.length) inner = rest[ci + 1]
      } else if (word === 'eval' && rest.length > 0) inner = rest.join(' ')
      if (inner !== null) {
        const reason = semanticPass(inner, cur, ctx, depth + 1)
        if (reason) return reason
      }
    }
    if ((word === 'cd' || word === 'pushd') && cur !== null) {
      const arg = rest.find(a => !a.startsWith('-'))
      if (arg === undefined || arg === '~') cur = userHome || cur
      else if (arg !== '-') cur = resolve(cur, arg.startsWith('~') && userHome ? userHome + arg.slice(1) : arg)
      let physicalCur = cur
      try { physicalCur = physicalPath(cur, '/', cache?.real) } catch { /* keep lexical */ }
      for (const candidate of uniq([cur, physicalCur])) {
        const h = offending(candidate)
        if (h) return hiddenReason(h)
      }
    }
  }
  return null
}

/**
 * Scans one Bash command against a role policy (SPEC §10.6). Returns a deny reason or null.
 *  1. `~/`, `$HOME/`, `${HOME}/` expand to `userHome`; `$CC_RSI_HOME` to `home`.
 *  2. Each `allowedPaths` entry (longest first) is masked when it ends at a path boundary.
 *  3. Deny when the result contains a hidden absolute path at a path boundary, or a hidden token.
 *     The same check runs on a quote-stripped copy, and (extension) every path-like word is resolved
 *     lexically and physically against `cwd` and denied when it lands under a hidden root that is not
 *     inside an allowed path, which catches relative traversal such as `../w002/secret`. Globs and
 *     brace lists are expanded against the hidden roots (`~/.cc-r*`, `~/.cc-rs[i]`), and a command that
 *     walks directory trees is denied when it starts above a hidden root (`grep -r x ~`, `find ..`,
 *     `cd .. && grep -r x .`), mirroring the Grep/Glob search-root rule (security-6). The reason for
 *     the latter is `coversReason(path, hiddenRoot)` (default: the hidden-path reason of the root).
 *     A walk that skips dot entries (rg, fd, ag, tree, `ls -R` without their show-hidden options) or is
 *     depth-limited (`find -maxdepth`, `tree -L`) counts only when it can reach the root's contents,
 *     and `walkHidden` (default: `hidden`) names the roots the walk rule applies to (r2-overblock-6, -1).
 *     A glob that reaches into a hidden root is fine when what it leaves below the root stays inside an
 *     allowed path. Quoted here-document text is data: its bare words are not resolved. The pass is
 *     memoized per operand and bounded by `budgetMs`; out of time it refuses (TOO_LARGE).
 *  4. Recursion: a command word `claude`/`claude-code`/`cc-rsi`; `node`/`nodejs` whose first operand
 *     matches /cc-rsi|claude-code/; `npx`/`pnpm`/`bunx`/`yarn`/`npm` naming `@anthropic-ai/claude-code`;
 *     also inside `sh -c`, `eval` and `find -exec`.
 *  5. `bashDeny` patterns against the original command.
 */
export function scanBash(command, { hidden = [], walkHidden, hiddenTokens = [], allowedPaths = [], home, userHome, recursionGuard = true,
  bashDeny = [], cwd, coversReason, budgetMs = SCAN_BUDGET_MS } = {}) {
  const started = Date.now()
  if (typeof command !== 'string') return 'cc-rsi: malformed Bash call (the command is not a string)'
  const hiddenRoots = spellings(hidden).filter(h => h !== '/')
  // Roots a tree walk may not cover (default: every hidden root). The main-session guard leaves out a
  // memory store inside the project, which every project-wide search would cover (r2-overblock-1).
  const walkRoots = Array.isArray(walkHidden) ? spellings(walkHidden).filter(h => h !== '/' && hiddenRoots.includes(h)) : hiddenRoots
  const allowedRoots = spellings(allowedPaths).filter(a => a !== '/').sort((a, b) => b.length - a.length)
  const tokens = uniq(hiddenTokens)

  const normalized = expandHomes(command, { home, userHome })
  const variants = uniq([normalized, normalized.replace(/["'\\]/g, '')])
  for (const variant of variants) {
    const masked = maskAllowed(variant, allowedRoots)
    for (const h of hiddenRoots) if (containsAtBoundary(masked, h)) return hiddenReason(h)
    for (const t of tokens) if (masked.includes(t)) return hiddenReason(t)
  }

  // Semantic path check against the directory the command would be in (the payload cwd, followed
  // through `cd`/`pushd` within this command).
  if (hiddenRoots.length > 0) {
    const ctx = {
      hiddenRoots,
      walkRoots,
      allowedRoots,
      userHome: typeof userHome === 'string' && userHome !== '' ? userHome : null,
      dotglob: /dotglob|glob_?dots/i.test(command),
      covers: typeof coversReason === 'function' ? coversReason : (path, root) => hiddenReason(root),
      // Per-scan memo: placed operands and realpath per prefix (r2-overblock-8).
      cache: { places: new Map(), real: new Map(), dirs: new Map(), checks: new Map() },
      deadline: started + budgetMs,
    }
    const reason = semanticPass(normalized, typeof cwd === 'string' && cwd !== '' ? cwd : null, ctx, 0)
    if (reason) return reason
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

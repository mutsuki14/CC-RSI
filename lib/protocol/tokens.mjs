// Transport-only token parsers (SPEC §7.1).
//
// Role outputs stay free-form: the harness recognises one lexical token in the role's FINAL
// assistant message and never reinterprets the rest of the text. Port of dsh-rsi
// src/protocol/tokens.ts (prose view, unique token) and RSIAgent `_parse_unique_handoff`
// (explore/practice_loop.py:413-444) / `_parse_agentic_verifier_report`, with the cc-rsi changes:
//   - a token is a unique standalone line anywhere in prose (not only the first non-empty line),
//   - one layer of Markdown emphasis or inline code around the line, a heading marker, a bold
//     label or value and one trailing period are tolerated ("## **VERDICT:** PASS."); a list,
//     quoted or fenced token line does not count, and the failure detail names it,
//   - identical repeats are idempotent, conflicting values are invalid,
//   - CommonMark fences: a closing fence uses the same character and is at least as long as
//     the opener; an unterminated fence swallows to the end of the text,
//   - every failure carries a precise English `detail` that is fed back verbatim through a
//     same-context continuation (dsh steps.ts transport detail strings).

/** `Parsed<T>` success. */
export function ok(value) {
  return { ok: true, value }
}

/** `Parsed<T>` failure; `detail` is a sentence fragment fed back to the role verbatim. */
export function fail(detail) {
  return { ok: false, detail: String(detail) }
}

// A fence opener may be indented by up to three spaces (CommonMark); four spaces or a tab make
// the line indented code instead. A backtick fence's info string cannot contain a backtick, so
// "```VERDICT: PASS```" is an inline code span, not a fence.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const INDENTED_CODE = /^(?:\t| {4})/
const BLOCKQUOTE = /^\s*>/

function fenceOpener(line) {
  const match = FENCE_OPEN.exec(line)
  if (!match) return null
  const marker = match[1]
  if (marker[0] === '`' && match[2].includes('`')) return null
  return { char: marker[0], length: marker.length }
}

function closesFence(line, fence) {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.length
}

/**
 * The prose lines of `text` with their indices in the ORIGINAL line split, as
 * `[{ line, index, quoted }]`. Lines inside ``` or ~~~ fences (and the fence lines themselves)
 * and lines indented by a TAB or four spaces are dropped. Blockquote lines are kept but marked
 * `quoted` (they never carry a token). Literal "\n" sequences are not reinterpreted.
 */
function proseEntries(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let fence = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    if (INDENTED_CODE.test(line)) continue
    const opener = fenceOpener(line)
    if (opener !== null) {
      fence = opener
      continue
    }
    out.push({ line, index, quoted: BLOCKQUOTE.test(line) })
  }
  return { lines, entries: out }
}

/** The prose lines of `text` (fenced and indented code removed; blockquote lines kept). */
export function proseLines(text) {
  return proseEntries(text).entries.map(entry => entry.line)
}

const WRAPPERS = ['**', '__', '*', '_', '`']
const HEADING = /^#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?$/
// "**VERDICT:** PASS" and "**VERDICT**: PASS" (a bold or italic label), and "VERDICT: **PASS**".
const LABEL_EMPHASIS = /^(\*\*|__|\*|_)([A-Za-z_]+)(?::\1|\1:)[ \t]*(.*)$/
const VALUE_EMPHASIS = /^([A-Za-z_]+:)[ \t]*(\*\*|__|\*|_|`)(.+)\2$/

function unwrap(text) {
  for (const marker of WRAPPERS) {
    if (text.length > 2 * marker.length && text.startsWith(marker) && text.endsWith(marker)) {
      return text.slice(marker.length, text.length - marker.length).trim()
    }
  }
  return text
}

/** Drops one trailing period ("VERDICT: PASS." → "VERDICT: PASS"), never an ellipsis. */
function unperiod(text) {
  return text.endsWith('.') && !text.endsWith('..') ? text.slice(0, -1).trimEnd() : text
}

/**
 * The token form of one line: trimmed, without an ATX heading marker ("## VERDICT: PASS"), with
 * ONE layer of wrapping `**`, `__`, `*`, `_` or `` ` `` stripped (the same marker at both ends:
 * "**VERDICT: PASS**"), with a bold or italic label ("**VERDICT:** PASS", "**VERDICT**: PASS") or
 * emphasis around the value ("VERDICT: **PASS**") removed, and without one trailing period. List
 * items, quotations and code are NOT normalised: they never carry a token (see `parseUniqueToken`
 * for the near-miss detail they produce).
 */
export function normalizeTokenLine(line) {
  let text = String(line ?? '').trim()
  const heading = HEADING.exec(text)
  if (heading) text = heading[1].trim()
  text = unwrap(unperiod(text))
  text = unperiod(text)
  const label = LABEL_EMPHASIS.exec(text)
  if (label) text = `${label[2]}: ${label[3]}`.trim()
  const value = VALUE_EMPHASIS.exec(text)
  if (value) text = `${value[1]} ${unperiod(value[3].trim())}`
  return unperiod(text)
}

const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])[ \t]+/
const QUOTE_MARKER = /^(?:>[ \t]*)+/

/**
 * A line with every Markdown decoration a token line must not carry removed (quote and list
 * markers, any emphasis characters), for the near-miss detail only. Returns `{ text, kind }`.
 */
function looseTokenLine(line) {
  let text = String(line ?? '').trim()
  let kind = null
  if (QUOTE_MARKER.test(text)) {
    text = text.replace(QUOTE_MARKER, '')
    kind = 'quoted'
  }
  if (LIST_MARKER.test(text)) {
    text = text.replace(LIST_MARKER, '')
    kind = kind ?? 'list'
  }
  // Emphasis characters go; an underscore inside a word (READY_FOR_TARGET) stays.
  text = text.replace(/[*`]+/g, ' ').replace(/(^|[\s:])_+/g, '$1').replace(/_+(?=[\s:]|$)/g, '')
  text = normalizeTokenLine(text.replace(/[ \t]+/g, ' '))
  return { text, kind }
}

const NEAR_MISS_REASON = {
  code: 'is inside a code block',
  quoted: 'is a quotation',
  list: 'is a list item',
  decorated: 'carries Markdown decoration',
}

function lineExcerpt(line, max = 80) {
  const flat = String(line).trim().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The first line of `text` that would be a token line without its decoration (a list or quote
 * marker, emphasis the normaliser does not strip, or a code block around it), as
 * `{ line, reason }`, or null.
 */
function nearMiss(text, re) {
  const { lines, entries } = proseEntries(text)
  const prose = new Map(entries.map(entry => [entry.index, entry]))
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '') continue
    const loose = looseTokenLine(line)
    const match = re.exec(loose.text)
    if (!match || match[1] === undefined) continue
    const entry = prose.get(index)
    const reason = entry === undefined ? 'code' : (loose.kind ?? 'decorated')
    return { line: lineExcerpt(line), reason: NEAR_MISS_REASON[reason] }
  }
  return null
}

const NEAR_MISS_TAIL = ', so it does not count'
const SYNTAX_DETAIL = new RegExp(`^.*; the line ".*" (?:${Object.values(NEAR_MISS_REASON).join('|')})${NEAR_MISS_TAIL}$|^your reply contained conflicting [A-Z_]+ lines \\(`, 's')

/**
 * True when a failure `detail` of this module says the reply carried its token in an unusable
 * FORM (a decorated, listed, quoted or fenced token line, or conflicting token lines) rather
 * than lacking it: a report-channel syntax problem (RSIAgent "Report rejected by lexical
 * validator", core/verifier_runtime.py:428-436) that the role fixes without new investigation.
 */
export function isSyntaxDetail(detail) {
  return SYNTAX_DETAIL.test(String(detail ?? ''))
}

function anchored(pattern) {
  let flags = pattern.flags.replace(/[gy]/g, '')
  if (!flags.includes('i')) flags += 'i'
  return new RegExp(`^(?:${pattern.source})$`, flags)
}

function tokenName(pattern, name) {
  if (typeof name === 'string' && name !== '') return name
  const match = /^\^?([A-Za-z_]+):/.exec(pattern.source)
  return match ? match[1].toUpperCase() : 'TOKEN'
}

/** Every prose line whose normalised form fully matches `pattern`, as `[{ value, lineIndex }]`. */
function tokenMatches(text, pattern) {
  const re = anchored(pattern)
  const { lines, entries } = proseEntries(text)
  const matches = []
  for (const entry of entries) {
    if (entry.quoted) continue
    const match = re.exec(normalizeTokenLine(entry.line))
    if (match && match[1] !== undefined) matches.push({ value: match[1].toUpperCase(), lineIndex: entry.index })
  }
  return { lines, matches }
}

/** The "no token line" detail, naming a near-miss line when the reply has one. */
function missingDetail(base, text, pattern) {
  const miss = nearMiss(text, anchored(pattern))
  return miss === null ? base : `${base}; the line "${miss.line}" ${miss.reason}${NEAR_MISS_TAIL}`
}

function listOf(values) {
  if (values.length <= 1) return values.join('')
  if (values.length === 2) return `${values[0]} or ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`
}

/**
 * Finds the single standalone token line in the prose of `text`.
 * `pattern` is a full-line, case-insensitive RegExp whose group 1 is the value.
 * Options: `allowed` (uppercase values accepted here), `name` (the token name used in the
 * failure detail; derived from the pattern when omitted — an optional cc-rsi addition).
 * Returns `Parsed<{ value, lineIndex }>`: `value` is UPPERCASE and `lineIndex` is the index of the
 * first matching line in the ORIGINAL text lines.
 */
export function parseUniqueToken(text, pattern, { allowed, name } = {}) {
  const label = tokenName(pattern, name)
  const { matches } = tokenMatches(text, pattern)
  if (matches.length === 0) {
    return fail(missingDetail(`your reply had no standalone line "${label}: …" outside code fences`, text, pattern))
  }
  const values = [...new Set(matches.map(match => match.value))]
  if (values.length > 1) {
    return fail(`your reply contained conflicting ${label} lines (${values.join(', ')})`)
  }
  const value = values[0]
  if (Array.isArray(allowed) && !allowed.map(v => String(v).toUpperCase()).includes(value)) {
    return fail(`${label}: ${value} is not available here; use one of ${listOf(allowed.map(v => String(v).toUpperCase()))}`)
  }
  return ok({ value, lineIndex: matches[0].lineIndex })
}

const VERDICT = /^VERDICT:\s*(PASS|FAIL|UNVERIFIED)$/i
const SUBMIT = /^STATUS:\s*(SUBMIT)$/i
const DECISION = /^DECISION:\s*([A-Z_]+)$/i

/**
 * Parses a Verifier report (RSIAgent `_parse_agentic_verifier_report`; dsh tokens.ts parseVerdict).
 * `report` is the whole text, trimmed — never edited, summarised or capped.
 */
export function parseVerdict(text, { allowUnverified = false } = {}) {
  const allowed = allowUnverified ? ['PASS', 'FAIL', 'UNVERIFIED'] : ['PASS', 'FAIL']
  const parsed = parseUniqueToken(text, VERDICT, { allowed, name: 'VERDICT' })
  if (!parsed.ok) return parsed
  return ok({ verdict: parsed.value.value, report: String(text).trim() })
}

/**
 * Parses an Actor handoff (RSIAgent `^STATUS: (SUBMIT)$`, practice_loop.py:78; dsh steps.ts
 * parseSubmitHandoff). `body` is the text without the token line(s), trimmed. The body is
 * private Actor material: it is never forwarded to a Verifier.
 */
export function parseSubmit(text) {
  const parsed = parseUniqueToken(text, SUBMIT, { name: 'STATUS' })
  if (!parsed.ok) {
    return fail(missingDetail('your final message had no standalone line "STATUS: SUBMIT" outside code fences', text, SUBMIT))
  }
  const { lines, matches } = tokenMatches(text, SUBMIT)
  const drop = new Set(matches.map(match => match.lineIndex))
  return ok({ body: lines.filter((_, index) => !drop.has(index)).join('\n').trim() })
}

/**
 * Parses a Curriculum decision (RSIAgent `_parse_handoff`, practice_loop.py:398-410, with the
 * cc-rsi unique-standalone-token rule). `body` = the original lines AFTER the first token line,
 * verbatim, trimmed; `rationale` = the lines before it, trimmed. PROJECT requires a body.
 */
export function parseDecision(text, allowed) {
  const vocabulary = (Array.isArray(allowed) ? allowed : []).map(v => String(v).toUpperCase())
  const parsed = parseUniqueToken(text, DECISION, { allowed: vocabulary, name: 'DECISION' })
  if (!parsed.ok) return parsed
  const { value: decision, lineIndex } = parsed.value
  const lines = String(text).split(/\r?\n/)
  const body = lines.slice(lineIndex + 1).join('\n').trim()
  const rationale = lines.slice(0, lineIndex).join('\n').trim()
  if (decision === 'PROJECT' && body === '') {
    return fail('a DECISION: PROJECT line must be followed by the complete natural-language project on the lines after it')
  }
  return ok({ decision, body, rationale })
}

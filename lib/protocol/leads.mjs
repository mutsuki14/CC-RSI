// Evidence leads (SPEC §7.3): the only Actor material that ever reaches a Verifier.
//
// Port of dsh-rsi src/engine/steps.ts scanLeads/parseLeads/leadsProblem/formatLeads and of
// RSIAgent `_actor_evidence_leads` (core/loop.py:447-465). The harness never executes a probe
// (J1-3): every lead is classified NOT_RUN, the only classification cc-rsi emits (SPEC §16.5).
// cc-rsi additions: a CLAIM without a PROBE and a PROBE without a CLAIM are reported as problems
// (RSIAgent core/checks.py:150 "malformed check (need desc + probe)"), the MCP argument form is
// validated with the same limits, and a probe may not contain the LEAD block's own delimiters.

export const MAX_LEADS = 16
export const MAX_CLAIM_CHARS = 2000
export const MAX_PROBE_CHARS = 4000

const BEGIN = '--- BEGIN PROBE ---'
const END = '--- END PROBE ---'

/** The CLAIM/PROBE format paragraph used in engine prompts (dsh roles/actor.ts leadsRequest). */
export const LEADS_REQUEST_FORMAT = [
  'CLAIM: <the requirement the probe demonstrates, on one line>',
  'PROBE: <one exact read-only shell command on one line; the Verifier can re-run it and it prints PASS only when the claim holds>',
  'Start each CLAIM: and PROBE: line with its label, as plain text (no bullet, number or bold) outside any code block.',
  'A probe that needs several lines goes in a fenced code block right after an empty PROBE: line. Only these',
  'CLAIM/PROBE pairs reach the Verifier; any other text in your message is not forwarded. The harness does not',
  'run the probes: the Verifier reproduces or falsifies them with its own instruments.',
].join('\n')

const FENCE_OPENER = /^\s*(`{3,}|~{3,})[^\s`~]*\s*$/
const INLINE_FENCE = /^(`{3,}|~{3,})(.+?)\1\s*$/
const INLINE_CODE = /^`([^`]+)`$/
// A CLAIM:/PROBE: label at the start of a line, after an optional list marker, with optional bold
// or italic emphasis around the label ("- **CLAIM:** x", "1. PROBE: y", "**CLAIM: x**").
const LABEL = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(\*\*|__|\*|_)?(CLAIM|PROBE)((?:\*\*|__|\*|_)?:(?:\*\*|__|\*|_)?)(.*)$/
/** A shell line that continues onto the next one: an open heredoc (not `<<<`) or a trailing backslash. */
const CONTINUES = /(?:(?<!<)<<-?\s*['"]?[A-Za-z_]\w*['"]?\s*$)|\\$/

function closesFence(line, marker) {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
  return match !== null && match[1][0] === marker[0] && match[1].length >= marker.length
}

/** `{ label: 'CLAIM'|'PROBE', rest }` of a CLAIM:/PROBE: line, or null. */
function labelLine(line) {
  const match = LABEL.exec(line)
  if (!match) return null
  const [, open = '', label, colon, tail] = match
  if (open === '') {
    if (!colon.startsWith(':')) return null
    return { label, rest: `${colon.slice(1)}${tail}`.trim() }
  }
  if (colon === `${open}:` || colon === `:${open}`) return { label, rest: tail.trim() }
  const rest = tail.trim()
  if (colon === ':' && rest.endsWith(open)) return { label, rest: rest.slice(0, rest.length - open.length).trim() }
  return null
}

/**
 * Whether the fence on line `next` (the first non-empty line after the one-line PROBE on line
 * `index`) carries the rest of that probe: it is closed later with no CLAIM/PROBE line before its
 * closer, and the probe text is a lead-in ending with ':' ("Run this:") or — unless the line can
 * close the fence enclosing the pairs — the fence follows the PROBE line directly. A fenced
 * block of notes after a blank line, or the end of a fence around the whole lead block, is not.
 */
function continuesInFence(lines, index, next, wrapper, probe) {
  const line = lines[next] ?? ''
  const fence = FENCE_OPENER.exec(line)
  if (!fence) return false
  const leadIn = probe.endsWith(':')
  if (!leadIn && (next !== index + 1 || (wrapper !== null && closesFence(line, wrapper)))) return false
  return closedLater(lines, next, fence[1])
}

/** Whether a fence opened with `marker` on line `open` is closed before any CLAIM/PROBE line. */
function closedLater(lines, open, marker) {
  for (let i = open + 1; i < lines.length; i++) {
    if (labelLine(lines[i]) !== null) return false
    if (closesFence(lines[i], marker)) return true
  }
  return false
}

function excerpt(text, max = 60) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Problems with one well-formed pair, or [] (shared by the text and MCP forms). */
function leadProblems(n, claim, probe) {
  const problems = []
  if (claim === '') problems.push(`the CLAIM of lead ${n} is empty`)
  if (probe === '') problems.push(`the PROBE of lead ${n} is empty`)
  if (claim.length > MAX_CLAIM_CHARS) problems.push(`the CLAIM of lead ${n} is longer than ${MAX_CLAIM_CHARS} characters`)
  if (probe.length > MAX_PROBE_CHARS) problems.push(`the PROBE of lead ${n} is longer than ${MAX_PROBE_CHARS} characters`)
  if (probe.split(/\r?\n/).some(line => line.trim() === BEGIN || line.trim() === END)) {
    problems.push(`the PROBE of lead ${n} contains a "${END}" or "${BEGIN}" line`)
  }
  return problems
}

const CONTINUATION_PROBLEM = 'continues onto later lines; a multi-line probe goes in a fenced code block right after an empty PROBE: line'

/**
 * Extracts CLAIM/PROBE pairs from a handoff. A probe is the rest of its PROBE: line (or the text
 * of an inline fence or inline code span there), or — when that is empty or opens a fence — the
 * fenced code block that follows. Every other line (narrative before, between or after the pairs)
 * is dropped, so only the pairs reach the Verifier. Common Markdown around the labels is tolerated:
 * a list marker, bold or italic labels, and one fence enclosing the pairs (its closer never
 * continues a one-line probe). An unterminated fence never swallows later text or pairs; an
 * unfenced heredoc or backslash continuation, or a one-line probe that runs on into a code block,
 * is rejected instead of being truncated; `<<<` here-strings are fine. Returns
 * `{ leads: [{ claim, probe }], problems: string[] }`; a handoff without any pair is a problem
 * (dsh leadsProblem).
 */
export function parseLeads(text) {
  const leads = []
  const problems = []
  const lines = String(text ?? '').split(/\r?\n/)
  let claim
  let pairs = 0
  // The marker of the fence that encloses the pairs (or narrative) at this point, or null.
  let wrapper = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const pair = labelLine(line)
    if (pair === null) {
      if (wrapper !== null) {
        if (closesFence(line, wrapper)) wrapper = null
      } else {
        const opener = FENCE_OPENER.exec(line)
        if (opener) wrapper = opener[1]
      }
      continue
    }
    if (pair.label === 'CLAIM') {
      if (claim !== undefined) problems.push(`the CLAIM "${excerpt(claim)}" has no PROBE line after it`)
      claim = pair.rest
      continue
    }
    const n = ++pairs
    if (claim === undefined) {
      problems.push(`PROBE ${n} has no CLAIM line before it`)
      continue
    }
    let probe = pair.rest
    const inline = INLINE_FENCE.exec(probe)
    if (inline) {
      probe = inline[2].trim()
    } else if (probe === '' || FENCE_OPENER.test(probe)) {
      // A multi-line probe: the fenced block opening on this line or on the next non-empty one.
      let open = index
      if (probe === '') {
        open = index + 1
        while (open < lines.length && lines[open].trim() === '') open++
      }
      const openLine = probe === '' ? lines[open] ?? '' : probe
      let fence = FENCE_OPENER.exec(openLine)
      // A bare fence that could close the enclosing fence opens the probe only if it is closed later.
      if (fence && probe === '' && wrapper !== null && closesFence(openLine, wrapper) && !closedLater(lines, open, fence[1])) fence = null
      if (!fence) {
        problems.push(`PROBE ${n} is empty; put a multi-line probe in a fenced code block right after the PROBE: line`)
        claim = undefined
        continue
      }
      // A fence indented under a list item: its body loses the same indentation (CommonMark).
      const indent = probe === '' ? /^ */.exec(openLine)[0].length : 0
      const dedent = new RegExp(`^ {0,${indent}}`)
      const body = []
      let end = open + 1
      while (end < lines.length && !closesFence(lines[end], fence[1]) && labelLine(lines[end]) === null) body.push(lines[end++].replace(dedent, ''))
      if (end >= lines.length || !closesFence(lines[end], fence[1])) {
        // Never swallow the text or pairs after an unterminated fence.
        problems.push(`the fenced block of PROBE ${n} is never closed`)
        claim = undefined
        continue
      }
      probe = body.join('\n').trim()
      index = end
    } else {
      const code = INLINE_CODE.exec(probe)
      if (code) probe = code[1].trim()
      let next = index + 1
      while (next < lines.length && lines[next].trim() === '') next++
      if (CONTINUES.test(probe) || continuesInFence(lines, index, next, wrapper, probe)) {
        problems.push(`PROBE ${n} ${CONTINUATION_PROBLEM}`)
        claim = undefined
        continue
      }
    }
    const found = leadProblems(n, claim, probe)
    if (found.length > 0) problems.push(...found)
    else leads.push({ claim, probe })
    claim = undefined
  }
  if (claim !== undefined) problems.push(`the CLAIM "${excerpt(claim)}" has no PROBE line after it`)
  if (leads.length > MAX_LEADS) {
    problems.push(`at most ${MAX_LEADS} evidence leads are forwarded; your message has ${leads.length}`)
  }
  if (leads.length === 0 && problems.length === 0) problems.push('your message carries no CLAIM/PROBE evidence lead')
  return { leads: leads.slice(0, MAX_LEADS), problems }
}

/**
 * Validates the MCP `submit` `evidence_leads` argument (an array of `{claim, probe}`) with the
 * same limits as `parseLeads`. A missing argument is not a problem; an empty array yields no
 * leads and no problem (the caller decides whether leads were required).
 * Returns `{ leads: [{ claim, probe }], problems: string[] }`.
 */
export function validateLeadArgs(arr) {
  if (arr === undefined || arr === null) return { leads: [], problems: [] }
  if (!Array.isArray(arr)) return { leads: [], problems: ['evidence_leads must be a list of {"claim", "probe"} objects'] }
  const leads = []
  const problems = []
  arr.forEach((item, i) => {
    const n = i + 1
    if (typeof item !== 'object' || item === null || Array.isArray(item)
      || typeof item.claim !== 'string' || typeof item.probe !== 'string') {
      problems.push(`evidence lead ${n} needs a string "claim" and a string "probe"`)
      return
    }
    // The LEAD block prints the claim on one line; the probe keeps its exact lines.
    const claim = item.claim.replace(/\s+/g, ' ').trim()
    const probe = item.probe.replace(/\r\n/g, '\n').trim()
    const found = leadProblems(n, claim, probe)
    if (found.length > 0) problems.push(...found)
    else leads.push({ claim, probe })
  })
  if (leads.length > MAX_LEADS) problems.push(`at most ${MAX_LEADS} evidence leads are forwarded; ${leads.length} were given`)
  return { leads: leads.slice(0, MAX_LEADS), problems }
}

/** RSIAgent's LEAD blocks (core/loop.py:459-464), joined by a blank line; each is NOT_RUN. */
export function formatLeads(leads) {
  return (Array.isArray(leads) ? leads : []).map((lead, index) => [
    `LEAD ${index + 1}`,
    `Actor-stated claim: ${lead.claim}`,
    'Exact reproducible probe proposed by Actor:',
    BEGIN,
    lead.probe,
    END,
    'Harness execution classification: NOT_RUN',
  ].join('\n')).join('\n\n')
}

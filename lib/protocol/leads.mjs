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
  'A probe that needs several lines goes in a fenced code block right after an empty PROBE: line. Only these',
  'CLAIM/PROBE pairs reach the Verifier; any other text in your message is not forwarded. The harness does not',
  'run the probes: the Verifier reproduces or falsifies them with its own instruments.',
].join('\n')

const FENCE_OPENER = /^\s*(`{3,}|~{3,})[^\s`~]*\s*$/
const INLINE_FENCE = /^(`{3,}|~{3,})(.+?)\1\s*$/
const PAIR_LINE = /^\s*(CLAIM|PROBE):/
const CLAIM_LINE = /^\s*CLAIM:\s*(.*)$/
const PROBE_LINE = /^\s*PROBE:\s*(.*)$/
/** A shell line that continues onto the next one: an open heredoc (not `<<<`) or a trailing backslash. */
const CONTINUES = /(?:(?<!<)<<-?\s*['"]?[A-Za-z_]\w*['"]?\s*$)|\\$/

function closesFence(line, marker) {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
  return match !== null && match[1][0] === marker[0] && match[1].length >= marker.length
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

/**
 * Extracts CLAIM/PROBE pairs from a handoff. A probe is the rest of its PROBE: line (or the text
 * of an inline fence there), or — when that is empty or opens a fence — the fenced code block
 * that follows. Every other line (narrative before, between or after the pairs) is dropped, so
 * only the pairs reach the Verifier. An unterminated fence never swallows later text or pairs;
 * an unfenced heredoc or backslash continuation is rejected instead of being truncated; `<<<`
 * here-strings are fine. Returns `{ leads: [{ claim, probe }], problems: string[] }`; a handoff
 * without any pair is a problem (dsh leadsProblem).
 */
export function parseLeads(text) {
  const leads = []
  const problems = []
  const lines = String(text ?? '').split(/\r?\n/)
  let claim
  let pairs = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const claimMatch = CLAIM_LINE.exec(line)
    if (claimMatch) {
      if (claim !== undefined) problems.push(`the CLAIM "${excerpt(claim)}" has no PROBE line after it`)
      claim = claimMatch[1].trim()
      continue
    }
    const probeMatch = PROBE_LINE.exec(line)
    if (!probeMatch) continue
    const n = ++pairs
    if (claim === undefined) {
      problems.push(`PROBE ${n} has no CLAIM line before it`)
      continue
    }
    let probe = probeMatch[1].trim()
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
      const fence = FENCE_OPENER.exec(probe === '' ? lines[open] ?? '' : probe)
      if (!fence) {
        problems.push(`PROBE ${n} is empty; put a multi-line probe in a fenced code block right after the PROBE: line`)
        claim = undefined
        continue
      }
      const body = []
      let end = open + 1
      while (end < lines.length && !closesFence(lines[end], fence[1]) && !PAIR_LINE.test(lines[end])) body.push(lines[end++])
      if (end >= lines.length || !closesFence(lines[end], fence[1])) {
        // Never swallow the text or pairs after an unterminated fence.
        problems.push(`the fenced block of PROBE ${n} is never closed`)
        claim = undefined
        continue
      }
      probe = body.join('\n').trim()
      index = end
    } else {
      let next = index + 1
      while (next < lines.length && lines[next].trim() === '') next++
      if (CONTINUES.test(probe) || FENCE_OPENER.test(lines[next] ?? '')) {
        problems.push(`PROBE ${n} continues onto later lines; a multi-line probe goes in a fenced code block right after an empty PROBE: line`)
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

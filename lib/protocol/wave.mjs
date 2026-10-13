// Phase-1 wave envelope (SPEC §7.2). Port of dsh-rsi src/protocol/wave.ts and RSIAgent
// `parse_wave_handoff` (explore/phase1_wave.py:106-144). The JSON shape is a lossless
// control-plane transport, not a search policy. cc-rsi changes: the envelope is read from the
// Curriculum's final message (last fenced block that parses as an object, else the first `{`
// to the last `}`); every rejection carries a precise detail for the same-context
// continuation; the wave ceiling is disclosed only in the failure detail (SPEC §8.3 A5).

import { ID_RE } from '../core/ids.mjs'
import { fail, ok } from './tokens.mjs'

export const PROJECT_ROOT_TOKEN = '<PROJECT_ROOT>'

const DECISIONS = ['WAVE', 'SATURATED', 'STALLED']

/** Contents of every fenced block (``` or ~~~, CommonMark closing rule), in order. */
function fencedBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const blocks = []
  let fence = null
  let body = []
  for (const line of lines) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        fence = { char: open[1][0], length: open[1].length }
        body = []
      }
      continue
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
    if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
      blocks.push(body.join('\n'))
      fence = null
      continue
    }
    body.push(line)
  }
  return blocks
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The candidate envelope: `{ value }` for the last fenced block whose content parses as a JSON
 * object; otherwise the substring from the first `{` to the last `}` (`{ raw }` when it does not
 * parse, so the caller can report the JSON error); `null` when there is no candidate at all.
 */
function candidateEnvelope(text) {
  const blocks = fencedBlocks(text)
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(blocks[i])
      if (isPlainObject(value)) return { value }
    } catch {
      // Not this block: keep looking at earlier ones.
    }
  }
  const source = String(text ?? '')
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const raw = source.slice(start, end + 1)
  try {
    return { value: JSON.parse(raw), raw }
  } catch (error) {
    return { raw, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Parses the Curriculum's wave handoff.
 * Returns `Parsed<{ decision: 'WAVE'|'SATURATED'|'STALLED', rationale, projects: [{ id, instruction }] }>`
 * with projects in authored (array) order.
 */
export function parseWave(text, { ceiling } = {}) {
  const candidate = candidateEnvelope(text)
  if (candidate === null) {
    return fail('your final message contained no JSON object; publish the envelope {"decision", "rationale", "projects"} in a fenced json block')
  }
  if (candidate.error !== undefined) {
    return fail(`the wave envelope is not valid JSON (${candidate.error})`)
  }
  const envelope = candidate.value
  if (!isPlainObject(envelope)) return fail('the wave envelope must be one JSON object')
  const { decision, rationale, projects } = envelope
  if (typeof decision !== 'string' || !DECISIONS.includes(decision)) {
    return fail('the envelope\'s "decision" must be exactly "WAVE", "SATURATED", or "STALLED"')
  }
  if (typeof rationale !== 'string' || rationale.trim() === '') {
    return fail('the envelope\'s "rationale" must be a non-empty string')
  }
  if (!Array.isArray(projects)) return fail('the envelope\'s "projects" must be a list')
  if (decision !== 'WAVE') {
    if (projects.length > 0) return fail(`a ${decision} decision requires an empty "projects" list`)
    return ok({ decision, rationale: rationale.trim(), projects: [] })
  }
  if (projects.length === 0) return fail('a WAVE decision needs at least one project in "projects"')
  const limit = Number.isInteger(ceiling) && ceiling > 0 ? ceiling : Infinity
  if (projects.length > limit) {
    return fail(`this harness can run at most ${limit} projects in one wave; the envelope declared ${projects.length}`)
  }
  const seen = new Set()
  const parsed = []
  for (let i = 0; i < projects.length; i++) {
    const record = projects[i]
    if (!isPlainObject(record)) return fail(`project ${i + 1} of the envelope is not an object with "id" and "instruction"`)
    const { id, instruction } = record
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      return fail(`project ${i + 1} has an invalid id ${JSON.stringify(id ?? null)}: use a short unique lowercase id of letters, digits, "_" or "-"`)
    }
    if (seen.has(id)) return fail(`the project id "${id}" is used more than once`)
    if (typeof instruction !== 'string' || instruction.trim() === '') {
      return fail(`project "${id}" has no natural-language "instruction"`)
    }
    if (!instruction.includes(PROJECT_ROOT_TOKEN)) {
      return fail(`the instruction of project "${id}" does not name ${PROJECT_ROOT_TOKEN} as the Actor's project root`)
    }
    seen.add(id)
    parsed.push({ id, instruction: instruction.trim() })
  }
  return ok({ decision, rationale: rationale.trim(), projects: parsed })
}

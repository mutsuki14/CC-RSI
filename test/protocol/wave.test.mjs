// SPEC §7.2 / §15.3 WP2: dsh wave rules (last fenced block, ids, <PROJECT_ROOT>, terminal
// decisions with an empty list, ceiling disclosed only in the detail).
import test from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_ROOT_TOKEN, parseWave } from '../../lib/protocol/wave.mjs'

const wave = (projects, extra = {}) => JSON.stringify({ decision: 'WAVE', rationale: 'r', projects, ...extra })

test('the placeholder token', () => {
  assert.equal(PROJECT_ROOT_TOKEN, '<PROJECT_ROOT>')
})

test('accepts a fenced WAVE envelope in authored order', () => {
  const text = 'Here is the wave.\n```json\n{"decision":"WAVE","rationale":" probe CLI ","projects":[{"id":"csv-1","instruction":" In <PROJECT_ROOT> write a CSV merger. "},{"id":"a_2","instruction":"<PROJECT_ROOT>/x"}]}\n```\nDone.'
  const parsed = parseWave(text, { ceiling: 16 })
  assert.ok(parsed.ok, parsed.detail)
  assert.deepEqual(parsed.value, {
    decision: 'WAVE',
    rationale: 'probe CLI',
    projects: [
      { id: 'csv-1', instruction: 'In <PROJECT_ROOT> write a CSV merger.' },
      { id: 'a_2', instruction: '<PROJECT_ROOT>/x' },
    ],
  })
})

test('the LAST fenced block that parses as an object wins', () => {
  const first = wave([{ id: 'old', instruction: '<PROJECT_ROOT>' }])
  const last = wave([{ id: 'new', instruction: '<PROJECT_ROOT>' }])
  const text = `Draft:\n\`\`\`json\n${first}\n\`\`\`\nFinal:\n~~~\n${last}\n~~~\nTrailing example:\n\`\`\`\nnot json\n\`\`\``
  const parsed = parseWave(text, { ceiling: 4 })
  assert.ok(parsed.ok)
  assert.equal(parsed.value.projects[0].id, 'new')
  // An array in a fence is not an object: the earlier object block wins.
  const withArray = `\`\`\`json\n${first}\n\`\`\`\n\`\`\`json\n[1,2]\n\`\`\``
  assert.equal(parseWave(withArray).value.projects[0].id, 'old')
})

test('falls back to the first { through the last } of bare text', () => {
  const parsed = parseWave(`Decision follows: ${JSON.stringify({ decision: 'SATURATED', rationale: 'coverage', projects: [] })} end`)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.value, { decision: 'SATURATED', rationale: 'coverage', projects: [] })
})

test('terminal decisions only with an empty project list', () => {
  assert.equal(parseWave('{"decision":"STALLED","rationale":"x","projects":[]}').value.decision, 'STALLED')
  const bad = parseWave('{"decision":"STALLED","rationale":"x","projects":[{"id":"a","instruction":"<PROJECT_ROOT>"}]}')
  assert.equal(bad.ok, false)
  assert.equal(bad.detail, 'a STALLED decision requires an empty "projects" list')
  const sat = parseWave('{"decision":"SATURATED","rationale":"x","projects":[{"id":"a","instruction":"<PROJECT_ROOT>"}]}')
  assert.equal(sat.detail, 'a SATURATED decision requires an empty "projects" list')
})

test('rejects bad ids, duplicates, missing roots, empty waves and malformed envelopes', () => {
  const detail = text => parseWave(text, { ceiling: 16 }).detail
  assert.match(detail(wave([{ id: 'Bad Id', instruction: '<PROJECT_ROOT>' }])), /invalid id "Bad Id"/)
  assert.match(detail(wave([{ id: '-a', instruction: '<PROJECT_ROOT>' }])), /invalid id/)
  assert.match(detail(wave([{ id: 'a'.repeat(65), instruction: '<PROJECT_ROOT>' }])), /invalid id/)
  assert.match(detail(wave([{ instruction: '<PROJECT_ROOT>' }])), /invalid id null/)
  assert.equal(detail(wave([{ id: 'a', instruction: '<PROJECT_ROOT>' }, { id: 'a', instruction: '<PROJECT_ROOT>' }])),
    'the project id "a" is used more than once')
  assert.equal(detail(wave([{ id: 'a', instruction: 'no root' }])),
    'the instruction of project "a" does not name <PROJECT_ROOT> as the Actor\'s project root')
  assert.match(detail(wave([{ id: 'a', instruction: '  ' }])), /no natural-language "instruction"/)
  assert.match(detail(wave(['x'])), /project 1 of the envelope is not an object/)
  assert.match(detail(wave([])), /needs at least one project/)
  assert.match(detail('not json at all'), /contained no JSON object/)
  assert.match(detail('{"decision": WAVE}'), /not valid JSON/)
  assert.match(detail('{"decision":"MORE","rationale":"r","projects":[]}'), /"decision" must be exactly "WAVE", "SATURATED", or "STALLED"/)
  assert.match(detail('{"decision":"wave","rationale":"r","projects":[]}'), /"decision" must be exactly/)
  assert.match(detail('{"decision":"WAVE","rationale":"","projects":[]}'), /"rationale" must be a non-empty string/)
  assert.match(detail('{"decision":"WAVE","rationale":"r","projects":{}}'), /"projects" must be a list/)
})

test('the ceiling is enforced and disclosed only in the failure detail', () => {
  const three = wave([1, 2, 3].map(i => ({ id: `p${i}`, instruction: '<PROJECT_ROOT>' })))
  const parsed = parseWave(three, { ceiling: 2 })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.detail, 'this harness can run at most 2 projects in one wave; the envelope declared 3')
  assert.ok(parseWave(three, { ceiling: 3 }).ok)
  assert.ok(parseWave(three).ok)
})

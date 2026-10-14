// SPEC §7.1 / §15.3 WP2: token parsing (fences, indentation, emphasis, blockquotes, repeats,
// conflicts, UNVERIFIED gating, DECISION body, STATUS body). Cases ported from dsh-rsi
// test/protocol.test.ts plus the cc-rsi rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fail, isSyntaxDetail, normalizeTokenLine, ok, parseDecision, parseSubmit, parseUniqueToken, parseVerdict, proseLines,
} from '../../lib/protocol/tokens.mjs'

const verdict = (text, allowUnverified = false) => {
  const parsed = parseVerdict(text, { allowUnverified })
  return parsed.ok ? parsed.value.verdict : undefined
}

test('ok/fail shapes', () => {
  assert.deepEqual(ok(1), { ok: true, value: 1 })
  assert.deepEqual(fail('x'), { ok: false, detail: 'x' })
})

test('finds one standalone verdict anywhere in a free-form report', () => {
  assert.equal(verdict('# Report\nAll checks hold.\nVERDICT: PASS\n'), 'PASS')
  assert.equal(verdict('verdict: fail'), 'FAIL')
  assert.equal(verdict('Intro\nVERDICT: FAIL\nMore evidence after the line.'), 'FAIL')
  assert.equal(verdict('VERDICT:PASS'), 'PASS')
})

test('the report is the whole text, trimmed and never edited', () => {
  const text = '\n\n  # Findings\nx = 1\nVERDICT: PASS\n```\ncode\n```\n\n'
  const parsed = parseVerdict(text, { allowUnverified: false })
  assert.ok(parsed.ok)
  assert.equal(parsed.value.report, text.trim())
})

test('ignores tokens inside backtick and tilde fences and indented code', () => {
  assert.equal(verdict('Format:\n```\nVERDICT: PASS\n```\n    VERDICT: PASS\nVERDICT: FAIL'), 'FAIL')
  assert.equal(verdict('~~~\nVERDICT: PASS\n~~~\nVERDICT: FAIL'), 'FAIL')
  assert.equal(verdict('\tVERDICT: PASS\nVERDICT: FAIL'), 'FAIL')
  assert.equal(verdict('```text\nVERDICT: PASS\n```'), undefined)
})

test('a longer closing fence closes; a shorter or different one does not', () => {
  assert.equal(verdict('````\nVERDICT: PASS\n``````\nVERDICT: FAIL'), 'FAIL')
  // ``` cannot close a ```` fence, and ~~~ cannot close a ``` fence: both lines stay inside.
  assert.equal(verdict('````\n```\nVERDICT: PASS\n````\nVERDICT: FAIL'), 'FAIL')
  assert.equal(verdict('```\n~~~\nVERDICT: PASS\n```\nVERDICT: FAIL'), 'FAIL')
  // A closing fence with an info string is not a closing fence.
  assert.equal(verdict('```\n```js\nVERDICT: PASS'), undefined)
})

test('an unterminated fence swallows the rest of the text', () => {
  const parsed = parseVerdict('Example:\n```\nVERDICT: PASS\nstill code', { allowUnverified: false })
  assert.equal(parsed.ok, false)
  assert.match(parsed.detail, /no standalone line "VERDICT: …" outside code fences/)
  assert.equal(verdict('VERDICT: FAIL\n```\nVERDICT: PASS'), 'FAIL')
})

test('an inline triple-backtick span is not a fence', () => {
  assert.equal(verdict('```VERDICT: PASS```\nVERDICT: FAIL'), 'FAIL')
})

test('tolerates one layer of emphasis or inline code', () => {
  assert.equal(verdict('**VERDICT: PASS**'), 'PASS')
  assert.equal(verdict('__VERDICT: FAIL__'), 'FAIL')
  assert.equal(verdict('*VERDICT: PASS*'), 'PASS')
  assert.equal(verdict('_VERDICT: PASS_'), 'PASS')
  assert.equal(verdict('`VERDICT: PASS`'), 'PASS')
  assert.equal(verdict('  **VERDICT: PASS**  '), 'PASS')
  assert.equal(verdict('***VERDICT: PASS***'), undefined)
  assert.equal(normalizeTokenLine(' ** VERDICT: PASS ** '), 'VERDICT: PASS')
  assert.equal(normalizeTokenLine('**'), '**')
})

test('tolerates a heading marker, a bold label or value and one trailing period (prompts-4)', () => {
  // Markdown forms a Verifier, Actor or Curriculum commonly writes for its token line.
  assert.equal(verdict('**VERDICT:** PASS'), 'PASS')
  assert.equal(verdict('**VERDICT**: FAIL'), 'FAIL')
  assert.equal(verdict('__VERDICT__: FAIL'), 'FAIL')
  assert.equal(verdict('*Verdict:* fail'), 'FAIL')
  assert.equal(verdict('## VERDICT: PASS'), 'PASS')
  assert.equal(verdict('### VERDICT: FAIL ###'), 'FAIL')
  assert.equal(verdict('VERDICT: **PASS**'), 'PASS')
  assert.equal(verdict('VERDICT: `FAIL`'), 'FAIL')
  assert.equal(verdict('VERDICT: PASS.'), 'PASS')
  assert.equal(verdict('**VERDICT: PASS.**'), 'PASS')
  assert.equal(verdict('**VERDICT: PASS**.'), 'PASS')
  assert.equal(verdict('## **VERDICT:** FAIL.'), 'FAIL')
  assert.equal(verdict('VERDICT: PASS..'), undefined)
  assert.equal(verdict('VERDICT: PASS!'), undefined)
  assert.equal(verdict('#VERDICT: PASS'), undefined)
  assert.equal(parseSubmit('**STATUS:** SUBMIT\nwork').value.body, 'work')
  assert.equal(parseSubmit('## STATUS: SUBMIT').ok, true)
  assert.deepEqual(parseDecision('### DECISION: PROJECT\nIn <PROJECT_ROOT> do x.', ['PROJECT']).value,
    { decision: 'PROJECT', body: 'In <PROJECT_ROOT> do x.', rationale: '' })
  assert.equal(parseDecision('DECISION: STALLED.', ['STALLED']).value.decision, 'STALLED')
  assert.equal(parseDecision('**DECISION:** READY_FOR_TARGET', ['READY_FOR_TARGET']).value.decision, 'READY_FOR_TARGET')
  // A heading or bold token still conflicts with a differing plain one.
  assert.equal(parseVerdict('## VERDICT: PASS\nVERDICT: FAIL').detail, 'your reply contained conflicting VERDICT lines (PASS, FAIL)')
})

test('a list, quoted, fenced or over-decorated token line is named in the detail and is a syntax problem (prompts-4)', () => {
  const base = 'your reply had no standalone line "VERDICT: …" outside code fences'
  const detail = text => parseVerdict(text, { allowUnverified: true }).detail
  assert.equal(detail('Report.\n- VERDICT: PASS'), `${base}; the line "- VERDICT: PASS" is a list item, so it does not count`)
  assert.equal(detail('1. **VERDICT:** FAIL'), `${base}; the line "1. **VERDICT:** FAIL" is a list item, so it does not count`)
  assert.equal(detail('> VERDICT: PASS'), `${base}; the line "> VERDICT: PASS" is a quotation, so it does not count`)
  assert.equal(detail('Report.\n```\nVERDICT: FAIL\n```'), `${base}; the line "VERDICT: FAIL" is inside a code block, so it does not count`)
  assert.equal(detail('    VERDICT: UNVERIFIED'), `${base}; the line "VERDICT: UNVERIFIED" is inside a code block, so it does not count`)
  assert.equal(detail('***VERDICT: PASS***'), `${base}; the line "***VERDICT: PASS***" carries Markdown decoration, so it does not count`)
  assert.equal(detail('No decision yet; I will check the parser next.'), base)
  assert.equal(parseSubmit('- STATUS: SUBMIT\nwork').detail,
    'your final message had no standalone line "STATUS: SUBMIT" outside code fences; the line "- STATUS: SUBMIT" is a list item, so it does not count')
  assert.equal(parseDecision('- DECISION: READY_FOR_TARGET', ['READY_FOR_TARGET']).detail,
    'your reply had no standalone line "DECISION: …" outside code fences; the line "- DECISION: READY_FOR_TARGET" is a list item, so it does not count')
  for (const text of ['- VERDICT: PASS', '> VERDICT: PASS', '```\nVERDICT: PASS\n```', '***VERDICT: PASS***', 'VERDICT: PASS\nVERDICT: FAIL']) {
    assert.equal(isSyntaxDetail(detail(text)), true, text)
  }
  for (const text of ['no verdict here', 'VERDICT: UNVERIFIED']) {
    assert.equal(isSyntaxDetail(parseVerdict(text, { allowUnverified: false }).detail), false, text)
  }
  assert.equal(isSyntaxDetail(undefined), false)
  assert.equal(isSyntaxDetail('it did not contain exactly one standalone VERDICT line'), false)
})

test('blockquote lines are kept as prose but never carry a token', () => {
  assert.deepEqual(proseLines('> VERDICT: PASS\ntext'), ['> VERDICT: PASS', 'text'])
  assert.equal(verdict('> VERDICT: PASS'), undefined)
  assert.equal(verdict('  > VERDICT: PASS\nVERDICT: FAIL'), 'FAIL')
})

test('proseLines drops fences and indented code and does not reinterpret literal \\n', () => {
  assert.deepEqual(proseLines('a\n```\nb\n```\n    c\nd\\nVERDICT: PASS'), ['a', 'd\\nVERDICT: PASS'])
  assert.equal(verdict('line\\nVERDICT: PASS'), undefined)
  assert.deepEqual(proseLines('x\r\ny'), ['x', 'y'])
})

test('identical repeats are fine; conflicting values are invalid; inline tokens do not count', () => {
  assert.equal(verdict('VERDICT: PASS\nVERDICT: PASS'), 'PASS')
  assert.equal(verdict('VERDICT: PASS\n**verdict: pass**'), 'PASS')
  const conflict = parseVerdict('VERDICT: PASS\nVERDICT: FAIL', { allowUnverified: false })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.detail, 'your reply contained conflicting VERDICT lines (PASS, FAIL)')
  assert.equal(verdict('no verdict here'), undefined)
  assert.equal(verdict('The VERDICT: PASS is inline'), undefined)
})

test('UNVERIFIED only when allowed, with a precise detail', () => {
  const refused = parseVerdict('VERDICT: UNVERIFIED', { allowUnverified: false })
  assert.equal(refused.ok, false)
  assert.equal(refused.detail, 'VERDICT: UNVERIFIED is not available here; use one of PASS or FAIL')
  assert.equal(verdict('VERDICT: UNVERIFIED', true), 'UNVERIFIED')
  assert.equal(verdict('verdict: unverified', true), 'UNVERIFIED')
})

test('parseUniqueToken reports the first matching line index in the original text', () => {
  const text = 'a\n```\nX: ONE\n```\nX: ONE\nb\n  x: one'
  const parsed = parseUniqueToken(text, /^X:\s*(ONE|TWO)$/i)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.value, { value: 'ONE', lineIndex: 4 })
  const missing = parseUniqueToken('nothing', /^X:\s*(ONE)$/i)
  assert.equal(missing.detail, 'your reply had no standalone line "X: …" outside code fences')
  const named = parseUniqueToken('nothing', /^X:\s*(ONE)$/i, { name: 'MARK' })
  assert.match(named.detail, /"MARK: …"/)
  const notAllowed = parseUniqueToken('X: TWO', /^X:\s*(ONE|TWO|THREE)$/i, { allowed: ['ONE', 'THREE'] })
  assert.equal(notAllowed.detail, 'X: TWO is not available here; use one of ONE or THREE')
  const three = parseUniqueToken('X: TWO', /^X:\s*(ONE|TWO|THREE|FOUR)$/i, { allowed: ['ONE', 'THREE', 'FOUR'] })
  assert.equal(three.detail, 'X: TWO is not available here; use one of ONE, THREE, or FOUR')
})

test('parseSubmit: STATUS anywhere in prose; body without the token lines', () => {
  const parsed = parseSubmit('\nI built merge.py.\nSTATUS: SUBMIT\nOpen question: encoding.\n')
  assert.ok(parsed.ok)
  assert.equal(parsed.value.body, 'I built merge.py.\nOpen question: encoding.')
  const repeated = parseSubmit('STATUS: SUBMIT\nwork\n**STATUS: SUBMIT**')
  assert.ok(repeated.ok)
  assert.equal(repeated.value.body, 'work')
  const fenced = parseSubmit('```\nSTATUS: SUBMIT\n```\nI am finished.')
  assert.equal(fenced.ok, false)
  assert.equal(fenced.detail, 'your final message had no standalone line "STATUS: SUBMIT" outside code fences; the line "STATUS: SUBMIT" is inside a code block, so it does not count')
  assert.equal(parseSubmit('I am finished.').detail, 'your final message had no standalone line "STATUS: SUBMIT" outside code fences')
  assert.equal(parseSubmit('status: submit').ok, true)
  assert.equal(parseSubmit('STATUS: DONE').ok, false)
})

test('parseDecision: body after the first token line verbatim; rationale before it', () => {
  const allowed = ['PROJECT', 'READY_FOR_TARGET', 'STALLED']
  const text = 'My evidence says the parser is the gap.\n\nDECISION: PROJECT\nIn <PROJECT_ROOT>, write a parser.\n  Keep inputs.\n'
  const parsed = parseDecision(text, allowed)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.value, {
    decision: 'PROJECT',
    body: 'In <PROJECT_ROOT>, write a parser.\n  Keep inputs.',
    rationale: 'My evidence says the parser is the gap.',
  })
  const first = parseDecision('\n\nDECISION: PROJECT\nBuild a parser in <PROJECT_ROOT>.', allowed)
  assert.deepEqual(first.value, { decision: 'PROJECT', body: 'Build a parser in <PROJECT_ROOT>.', rationale: '' })
  const ready = parseDecision('DECISION: READY_FOR_TARGET\nNothing beats the target now.', allowed)
  assert.equal(ready.value.decision, 'READY_FOR_TARGET')
  assert.equal(ready.value.body, 'Nothing beats the target now.')
})

test('parseDecision: vocabulary, empty PROJECT body, conflicts, fenced examples', () => {
  const allowed = ['PROJECT', 'READY_FOR_TARGET', 'STALLED']
  const outside = parseDecision('DECISION: SATURATED', allowed)
  assert.equal(outside.ok, false)
  assert.equal(outside.detail, 'DECISION: SATURATED is not available here; use one of PROJECT, READY_FOR_TARGET, or STALLED')
  const empty = parseDecision('rationale\nDECISION: PROJECT\n   \n', allowed)
  assert.equal(empty.ok, false)
  assert.match(empty.detail, /must be followed by the complete natural-language project/)
  assert.equal(parseDecision('DECISION: STALLED', allowed).ok, true)
  assert.equal(parseDecision('DECISION: PROJECT\nx\nDECISION: STALLED', allowed).ok, false)
  const fencedExample = parseDecision('Format:\n```\nDECISION: STALLED\n```\nDECISION: PROJECT\nIn <PROJECT_ROOT> do x.', allowed)
  assert.equal(fencedExample.value.decision, 'PROJECT')
  assert.equal(fencedExample.value.body, 'In <PROJECT_ROOT> do x.')
  assert.equal(fencedExample.value.rationale, 'Format:\n```\nDECISION: STALLED\n```')
})

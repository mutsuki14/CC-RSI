// SPEC §7.3 / §15.3 WP2: CLAIM/PROBE parsing (fenced, inline fence, unterminated never swallows,
// heredoc/backslash rejected, `<<<` allowed, at most 16), MCP argument validation, and the exact
// LEAD block text. Cases ported from dsh-rsi test/protocol.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEADS_REQUEST_FORMAT, MAX_LEADS, formatLeads, parseLeads, validateLeadArgs,
} from '../../lib/protocol/leads.mjs'

test('extracts pairs with fenced multi-line probes and drops all narrative', () => {
  const handoff = [
    'STATUS: SUBMIT',
    'I am confident.',
    'CLAIM: output exists',
    'PROBE: test -f out.txt && echo PASS',
    'This line explains my work and must not reach the Verifier.',
    'CLAIM: two lines',
    'PROBE:',
    '```sh',
    'python3 - <<PY',
    'print("PASS")',
    'PY',
    '```',
    '',
    'I fixed parse.py and all my own tests pass; the task is complete.',
  ].join('\n')
  const { leads, problems } = parseLeads(handoff)
  assert.deepEqual(problems, [])
  assert.deepEqual(leads, [
    { claim: 'output exists', probe: 'test -f out.txt && echo PASS' },
    { claim: 'two lines', probe: 'python3 - <<PY\nprint("PASS")\nPY' },
  ])
  assert.deepEqual(parseLeads('STATUS: SUBMIT\nCLAIM: sorted\nPROBE: sort -c out.txt && echo PASS\n\nI fixed parse.py; the task is complete.').leads,
    [{ claim: 'sorted', probe: 'sort -c out.txt && echo PASS' }])
})

test('a fence may open on the PROBE line itself; tilde fences and longer closers work', () => {
  const { leads, problems } = parseLeads('CLAIM: a\nPROBE: ```bash\ntest -f a && echo PASS\n```\nCLAIM: b\nPROBE:\n~~~~\ncat b\n~~~~~\n')
  assert.deepEqual(problems, [])
  assert.deepEqual(leads, [{ claim: 'a', probe: 'test -f a && echo PASS' }, { claim: 'b', probe: 'cat b' }])
})

test('an inline fence is a one-line probe; an unterminated fence never swallows narrative or the next pair', () => {
  const handoff = [
    'STATUS: SUBMIT',
    'CLAIM: a exists',
    'PROBE: ```test -f a && echo PASS```',
    'I rewrote parse.py and all my own tests pass; the task is complete.',
    'CLAIM: b exists',
    'PROBE:',
    '```sh',
    'test -f b && echo PASS',
    '```',
  ].join('\n')
  assert.deepEqual(parseLeads(handoff), {
    leads: [
      { claim: 'a exists', probe: 'test -f a && echo PASS' },
      { claim: 'b exists', probe: 'test -f b && echo PASS' },
    ],
    problems: [],
  })
  const unterminated = parseLeads('STATUS: SUBMIT\nCLAIM: a\nPROBE:\n```\ncat a\nmy narrative\nCLAIM: b\nPROBE: test -f b && echo PASS')
  assert.deepEqual(unterminated.leads, [{ claim: 'b', probe: 'test -f b && echo PASS' }])
  assert.deepEqual(unterminated.problems, ['the fenced block of PROBE 1 is never closed'])
  const atEof = parseLeads('CLAIM: a\nPROBE:\n```\ncat a\nnarrative to the end')
  assert.deepEqual(atEof.leads, [])
  assert.deepEqual(atEof.problems, ['the fenced block of PROBE 1 is never closed'])
})

test('rejects multi-line probes given without a fence; allows here-strings', () => {
  const heredoc = parseLeads("STATUS: SUBMIT\nCLAIM: works\nPROBE: python3 - <<'EOF'\nimport sys\nprint('PASS')\nEOF")
  assert.deepEqual(heredoc.leads, [])
  assert.match(heredoc.problems.join('; '), /PROBE 1 continues onto later lines/)
  assert.match(parseLeads('CLAIM: c\nPROBE: grep -q x a \\\n  && echo PASS').problems.join(), /continues onto later lines/)
  assert.match(parseLeads('CLAIM: c\nPROBE: cat <<-EOF').problems.join(), /continues onto later lines/)
  assert.match(parseLeads('CLAIM: c\nPROBE: echo x\n```\nmore\n```').problems.join(), /continues onto later lines/)
  assert.deepEqual(parseLeads('CLAIM: c\nPROBE: cat <<< "x" | grep -q x && echo PASS'),
    { leads: [{ claim: 'c', probe: 'cat <<< "x" | grep -q x && echo PASS' }], problems: [] })
})

test('a fence around the pairs or a separate fenced notes block does not continue a one-line probe (protocol-4)', () => {
  const F = '```'
  // The whole lead block wrapped in one fence (the body after the STATUS: SUBMIT line).
  assert.deepEqual(parseLeads(`\n${F}text\nCLAIM: out.txt holds JSON\nPROBE: python3 -c "import json;json.load(open('out.txt'))" && echo PASS\n${F}\n`), {
    leads: [{ claim: 'out.txt holds JSON', probe: 'python3 -c "import json;json.load(open(\'out.txt\'))" && echo PASS' }],
    problems: [],
  })
  assert.deepEqual(parseLeads(`${F}\nCLAIM: a\nPROBE: test -f a && echo PASS\n\nCLAIM: b\nPROBE: test -f b && echo PASS\n${F}`).leads,
    [{ claim: 'a', probe: 'test -f a && echo PASS' }, { claim: 'b', probe: 'test -f b && echo PASS' }])
  // An unrelated fenced block after a blank line, also after a wrapper has closed.
  assert.deepEqual(parseLeads(`CLAIM: a\nPROBE: test -f a && echo PASS\n\n${F}\nnotes\n${F}`),
    { leads: [{ claim: 'a', probe: 'test -f a && echo PASS' }], problems: [] })
  assert.deepEqual(parseLeads(`${F}\nCLAIM: a\nPROBE: echo PASS\n${F}\n\nnotes\n${F}\nmore\n${F}`).problems, [])
  // A multi-line probe inside the wrapper (nested bare fences) still parses.
  assert.deepEqual(parseLeads(`${F}text\nCLAIM: a\nPROBE:\n${F}\necho PASS\n${F}\n${F}`),
    { leads: [{ claim: 'a', probe: 'echo PASS' }], problems: [] })
  assert.deepEqual(parseLeads(`${F}text\nCLAIM: a\nPROBE:\n${F}`).problems,
    ['PROBE 1 is empty; put a multi-line probe in a fenced code block right after the PROBE: line'])
  // A lead-in on the PROBE line followed by the real code is still rejected, never truncated.
  const continued = /^PROBE 1 continues onto later lines; a multi-line probe goes in a fenced code block right after an empty PROBE: line$/
  assert.match(parseLeads(`CLAIM: a\nPROBE: run this:\n${F}\ncmd\n${F}`).problems.join(), continued)
  assert.match(parseLeads(`CLAIM: a\nPROBE: run this:\n\n${F}\ncmd\n${F}`).problems.join(), continued)
  assert.match(parseLeads(`${F}\nCLAIM: a\nPROBE: run this:\n${F}\ncmd\n${F}\n${F}`).problems.join(), continued)
  assert.match(parseLeads(`CLAIM: a\nPROBE: bash\n${F}sh\nset -e\ntest -f a\n${F}`).problems.join(), continued)
})

test('list markers, bold labels and an inline code span around a probe are tolerated (prompts-5)', () => {
  const F = '```'
  const one = [{ claim: 'a', probe: 'test -f a && echo PASS' }]
  for (const text of [
    '- CLAIM: a\n- PROBE: test -f a && echo PASS',
    '* CLAIM: a\n  PROBE: test -f a && echo PASS',
    '1. CLAIM: a\n   PROBE: test -f a && echo PASS',
    '2) CLAIM: a\n2) PROBE: test -f a && echo PASS',
    '**CLAIM:** a\n**PROBE:** test -f a && echo PASS',
    '**CLAIM**: a\n__PROBE__: test -f a && echo PASS',
    '*CLAIM: a*\n**PROBE: test -f a && echo PASS**',
    '- **CLAIM:** a\n- **PROBE:** `test -f a && echo PASS`',
    'CLAIM: a\nPROBE: `test -f a && echo PASS`',
  ]) assert.deepEqual(parseLeads(text), { leads: one, problems: [] }, text)
  // A backtick inside the span is shell syntax, not a wrapper.
  assert.deepEqual(parseLeads('CLAIM: a\nPROBE: test "`cat a`" = x && echo PASS').leads, [{ claim: 'a', probe: 'test "`cat a`" = x && echo PASS' }])
  assert.match(parseLeads('CLAIM: a\nPROBE: `cat <<EOF`').problems.join(), /continues onto later lines/)
  // A fence indented under a list item loses that indentation, keeping the code's own.
  assert.deepEqual(parseLeads(`- CLAIM: a\n- PROBE:\n  ${F}sh\n  python3 - <<EOF\n  if True:\n      print("PASS")\n  EOF\n  ${F}`).leads,
    [{ claim: 'a', probe: 'python3 - <<EOF\nif True:\n    print("PASS")\nEOF' }])
  // Lookalikes are not labels.
  assert.deepEqual(parseLeads('CLAIMS: a\nPROBES: b').problems, ['your message carries no CLAIM/PROBE evidence lead'])
  assert.deepEqual(parseLeads('CLAIM**: a\nPROBE: b').problems, ['PROBE 1 has no CLAIM line before it'])
})

test('reports unpaired lines, empty parts and handoffs without any pair', () => {
  assert.deepEqual(parseLeads('STATUS: SUBMIT\nno pairs here').problems, ['your message carries no CLAIM/PROBE evidence lead'])
  const lone = parseLeads('CLAIM: forgotten probe\nCLAIM: ok\nPROBE: true\nCLAIM: trailing')
  assert.deepEqual(lone.leads, [{ claim: 'ok', probe: 'true' }])
  assert.deepEqual(lone.problems, [
    'the CLAIM "forgotten probe" has no PROBE line after it',
    'the CLAIM "trailing" has no PROBE line after it',
  ])
  assert.deepEqual(parseLeads('PROBE: true').problems, ['PROBE 1 has no CLAIM line before it'])
  assert.deepEqual(parseLeads('CLAIM:\nPROBE: true').problems, ['the CLAIM of lead 1 is empty'])
  assert.match(parseLeads('CLAIM: x\nPROBE:\n\nnarrative').problems.join(), /PROBE 1 is empty/)
  assert.match(parseLeads('CLAIM: x\nPROBE:\n```\n\n```').problems.join(), /the PROBE of lead 1 is empty/)
  assert.match(parseLeads('CLAIM: x\nPROBE:\n```\necho\n--- END PROBE ---\n```').problems.join(), /contains a "--- END PROBE ---"/)
})

test('limits: at most 16 leads and bounded claim/probe sizes', () => {
  const many = Array.from({ length: MAX_LEADS + 1 }, (_, i) => `CLAIM: c${i}\nPROBE: echo ${i}`).join('\n')
  const parsed = parseLeads(many)
  assert.equal(parsed.leads.length, MAX_LEADS)
  assert.deepEqual(parsed.problems, ['at most 16 evidence leads are forwarded; your message has 17'])
  assert.match(parseLeads(`CLAIM: ${'x'.repeat(2001)}\nPROBE: true`).problems.join(), /longer than 2000 characters/)
  assert.match(parseLeads(`CLAIM: x\nPROBE: ${'y'.repeat(4001)}`).problems.join(), /longer than 4000 characters/)
})

test('validateLeadArgs: MCP evidence_leads with the same limits', () => {
  assert.deepEqual(validateLeadArgs(undefined), { leads: [], problems: [] })
  assert.deepEqual(validateLeadArgs([]), { leads: [], problems: [] })
  assert.deepEqual(validateLeadArgs('x').problems, ['evidence_leads must be a list of {"claim", "probe"} objects'])
  const result = validateLeadArgs([
    { claim: ' sorted\n output ', probe: 'sort -c out.txt \\\n && echo PASS\r\n' },
    { claim: 'x' },
    null,
    { claim: '', probe: 'true' },
  ])
  assert.deepEqual(result.leads, [{ claim: 'sorted output', probe: 'sort -c out.txt \\\n && echo PASS' }])
  assert.deepEqual(result.problems, [
    'evidence lead 2 needs a string "claim" and a string "probe"',
    'evidence lead 3 needs a string "claim" and a string "probe"',
    'the CLAIM of lead 4 is empty',
  ])
  const many = validateLeadArgs(Array.from({ length: 17 }, (_, i) => ({ claim: `c${i}`, probe: 'true' })))
  assert.equal(many.leads.length, 16)
  assert.deepEqual(many.problems, ['at most 16 evidence leads are forwarded; 17 were given'])
})

test('formatLeads renders RSIAgent LEAD blocks marked NOT_RUN, joined by a blank line', () => {
  assert.equal(formatLeads([{ claim: 'c', probe: 'p' }, { claim: 'c2', probe: 'line1\nline2' }]), [
    'LEAD 1',
    'Actor-stated claim: c',
    'Exact reproducible probe proposed by Actor:',
    '--- BEGIN PROBE ---',
    'p',
    '--- END PROBE ---',
    'Harness execution classification: NOT_RUN',
    '',
    'LEAD 2',
    'Actor-stated claim: c2',
    'Exact reproducible probe proposed by Actor:',
    '--- BEGIN PROBE ---',
    'line1',
    'line2',
    '--- END PROBE ---',
    'Harness execution classification: NOT_RUN',
  ].join('\n'))
  assert.equal(formatLeads([]), '')
})

test('the request format names the CLAIM/PROBE lines and never promises execution', () => {
  assert.match(LEADS_REQUEST_FORMAT, /^CLAIM: </)
  assert.match(LEADS_REQUEST_FORMAT, /\nPROBE: </)
  assert.match(LEADS_REQUEST_FORMAT, /does not\s+run the probes/)
  // prompts-5: the plain-line form is stated, not only shown.
  assert.match(LEADS_REQUEST_FORMAT, /\nStart each CLAIM: and PROBE: line with its label, as plain text \(no bullet, number or bold\) outside any code block\.\n/)
})

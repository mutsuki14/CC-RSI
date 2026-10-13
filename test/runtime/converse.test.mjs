// SPEC §10.10 / §15.3 WP4 `converse.test.mjs`: continues while acting; 3 actionless → TransportInfraError
// (transport_liveness); ceiling; a valid publication wins even when actionless; truncation not counted; an
// override resets and sends the stall continuation. Port of dsh-rsi test/engine.test.ts converse cases.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { converse } from '../../lib/runtime/converse.mjs'
import { InfraError, TransportInfraError } from '../../lib/runtime/errors.mjs'

const OK = value => ({ ok: true, value })
const BAD = detail => ({ ok: false, detail })

/** A scripted role: each send returns the next scripted reply; every message is recorded. */
function role(replies) {
  const sent = []
  let i = 0
  return {
    sent,
    send: async (message, index) => {
      sent.push({ message, index })
      const r = replies[Math.min(i++, replies.length - 1)]
      return { text: r.text ?? '', actions: r.actions ?? 0, truncated: r.truncated ?? false }
    },
  }
}

const parseToken = r => (r.text.includes('STATUS: SUBMIT') ? OK(r.text) : BAD('your reply had no standalone line "STATUS: …"'))
const cont = d => `CONTINUE (${d})`

test('a first-message publication returns immediately', async () => {
  const r = role([{ text: 'STATUS: SUBMIT' }])
  const out = await converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont })
  assert.equal(out.index, 1)
  assert.equal(out.value, 'STATUS: SUBMIT')
  assert.deepEqual(r.sent, [{ message: 'go', index: 1 }])
})

test('continues while the role keeps acting (no fixed retry count)', async () => {
  const replies = [...Array.from({ length: 10 }, () => ({ text: 'working', actions: 2 })), { text: 'STATUS: SUBMIT', actions: 1 }]
  const r = role(replies)
  const out = await converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont, policy: { actionlessLimit: 3, ceiling: 24 } })
  assert.equal(out.index, 11)
  assert.equal(r.sent[1].message, 'CONTINUE (your reply had no standalone line "STATUS: …")')
  assert.deepEqual(r.sent.map(s => s.index), Array.from({ length: 11 }, (_, k) => k + 1))
})

test('3 consecutive actionless segments → TransportInfraError(transport_liveness) with a liveness key', async () => {
  const r = role([{ text: 'hmm', actions: 0 }])
  await assert.rejects(converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont, who: 'ACTOR w001' }), err => {
    assert.ok(err instanceof TransportInfraError)
    assert.ok(err instanceof InfraError)
    assert.equal(err.cls, 'transport_liveness')
    assert.equal(err.extra.livenessKey, 'liveness@3')
    assert.match(err.detail, /^ACTOR w001: 3 consecutive actionless segments without a usable handoff \(your reply had no standalone line/)
    return true
  })
  assert.equal(r.sent.length, 3)
})

test('an acting reply resets the actionless counter', async () => {
  const r = role([{ actions: 0 }, { actions: 0 }, { actions: 1 }, { actions: 0 }, { actions: 0 }, { text: 'STATUS: SUBMIT', actions: 0 }])
  const out = await converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont })
  assert.equal(out.index, 6)
})

test('a valid publication wins even when the reply was actionless (after two actionless replies)', async () => {
  const r = role([{ actions: 0 }, { actions: 0 }, { text: 'STATUS: SUBMIT', actions: 0 }])
  const out = await converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont })
  assert.equal(out.index, 3)
})

test('the emergency ceiling ends an acting conversation', async () => {
  const r = role([{ text: 'busy', actions: 1 }])
  await assert.rejects(converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont, policy: { actionlessLimit: 3, ceiling: 5 } }), err => {
    assert.equal(err.cls, 'transport_ceiling')
    assert.equal(err.extra.livenessKey, 'liveness@5')
    assert.match(err.detail, /emergency transport ceiling of 5 segments/)
    return true
  })
  assert.equal(r.sent.length, 5)
})

test('truncation is continued with the truncation text and not counted as actionless', async () => {
  const r = role([{ truncated: true }, { truncated: true }, { truncated: true }, { truncated: true }, { text: 'STATUS: SUBMIT' }])
  const out = await converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont, truncatedContinuation: () => 'CONTINUE FROM THE CUT', policy: { actionlessLimit: 3 } })
  assert.equal(out.index, 5)
  assert.deepEqual(r.sent.slice(1).map(s => s.message), ['CONTINUE FROM THE CUT', 'CONTINUE FROM THE CUT', 'CONTINUE FROM THE CUT', 'CONTINUE FROM THE CUT'])
})

test('a model that always truncates is still bounded by the ceiling', async () => {
  const r = role([{ truncated: true }])
  await assert.rejects(converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont, truncatedContinuation: 'T', policy: { ceiling: 6 } }), TransportInfraError)
  assert.ok(r.sent.length <= 7)
})

test('an override for the liveness key resets the counters and sends the stall continuation', async () => {
  const replies = [{ actions: 0 }, { actions: 0 }, { actions: 0 }, { actions: 0 }, { text: 'STATUS: SUBMIT' }]
  const r = role(replies)
  const asked = []
  const out = await converse({
    first: 'go', send: r.send, parse: parseToken, continuation: cont, stallContinuation: () => 'STALL: the harness resumed after a pause',
    overrideFor: key => { asked.push(key); return key === 'liveness@3' },
  })
  assert.deepEqual(asked, ['liveness@3'])
  assert.equal(r.sent[3].message, 'STALL: the harness resumed after a pause')
  assert.equal(out.index, 5)
})

test('without an override the liveness key is reported for a later resume', async () => {
  const r = role([{ actions: 0 }])
  const err = await converse({ first: 'go', send: r.send, parse: parseToken, continuation: cont, overrideFor: async () => false }).catch(e => e)
  assert.equal(err.extra.livenessKey, 'liveness@3')
})

test('async parse functions and parse details reach the continuation verbatim', async () => {
  const r = role([{ text: 'a', actions: 1 }, { text: 'b', actions: 1 }])
  let n = 0
  const out = await converse({
    first: 'go', send: r.send, continuation: d => `detail=${d}`,
    parse: async reply => (++n === 2 ? OK(reply.text) : BAD('your reply contained conflicting VERDICT lines (PASS, FAIL)')),
  })
  assert.equal(out.value, 'b')
  assert.equal(r.sent[1].message, 'detail=your reply contained conflicting VERDICT lines (PASS, FAIL)')
})

test('send errors (infra) propagate unchanged', async () => {
  const boom = new InfraError('crash', 'claude exited without a result')
  await assert.rejects(converse({ first: 'go', send: async () => { throw boom }, parse: parseToken, continuation: cont }), e => e === boom)
})

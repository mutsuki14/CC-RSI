// SPEC §8.2 builder behaviour beyond the goldens: Verifier blindness, isolation-true mechanics,
// verbatim RSIAgent sentences, size bound of the SessionStart protocol, composition rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PromptError } from '../../lib/prompts/render.mjs'
import * as R from '../../lib/prompts/roles.mjs'
import * as G from '../../lib/prompts/guidance.mjs'
import { formatLeads } from '../../lib/protocol/leads.mjs'
import { parseVerdict } from '../../lib/protocol/tokens.mjs'

const LEADS = formatLeads([{ claim: 'out.csv exists', probe: 'test -f out.csv && echo PASS' }])
const base = { generation: 1, task: 'Merge the files.', candidateRoot: '/repo', scratchDir: '/scratch', mechanical: 'M a.py' }

test('actorProtocol stays within 6000 characters and varies only as specified', () => {
  for (const mode of ['learn', 'frozen']) {
    for (const allowUnverified of [true, false]) {
      const text = R.actorProtocol({ mode, allowUnverified, memoryViewDir: '/v/memory' })
      assert.ok(text.length <= 6000, `${mode}/${allowUnverified}: ${text.length} chars`)
      assert.match(text, /submit/)
      assert.match(text, /wait_verdict/)
      assert.match(text, /the same Verifier context inspects every revision of this task, across turns/i)
      assert.match(text, /file edits and shell commands are paused/)
      assert.ok(text.includes('/v/memory'))
      assert.equal(/UNVERIFIED: the inspection could not confirm/.test(text), allowUnverified)
      assert.equal(/call learn/.test(text), mode === 'learn')
      assert.equal(/FROZEN/.test(text), mode === 'frozen')
      assert.ok(!text.endsWith('\n'))
    }
  }
  assert.throws(() => R.actorProtocol({ mode: 'other', memoryViewDir: '/v' }), PromptError)
  assert.throws(() => R.actorProtocol({ mode: 'learn' }), /memoryViewDir/)
})

test('the Verifier charter carries only harness material', () => {
  const text = R.verifierCharter({ ...base, handoff: 'SECRET ACTOR NARRATIVE', actorMemory: 'SECRET MEMORY', allowUnverified: true })
  assert.ok(!text.includes('SECRET'))
  assert.match(text, /^VERIFIER AGENT — STAGE: CANDIDATE_VERIFICATION\./)
  assert.match(text, /CANDIDATE ROOT: \/repo\n/)
  assert.match(text, /YOUR PRIVATE SCRATCH DIRECTORY: \/scratch \(\$VERIFIER_SCRATCH\)/)
  assert.match(text, /deliberately not disclosed/)
  // Leads must be formatLeads() blocks only: narrative is refused, never forwarded.
  assert.throws(() => R.verifierCharter({ ...base, leads: 'I am sure it works.\nCLAIM: x\nPROBE: y' }), /LEAD blocks only/)
  assert.throws(() => R.verifierCharter({ ...base, leads: `${LEADS}\n\nAnd my notes.` }), /LEAD blocks only/)
  assert.throws(() => R.verifierCharter({ ...base, leads: LEADS.replace('LEAD 1', 'LEAD 2') }), /LEAD blocks only/)
  const withLeads = R.verifierCharter({ ...base, generation: 2, leads: LEADS, allowUnverified: true })
  assert.ok(withLeads.includes(LEADS))
  assert.match(withLeads, /The harness did not execute these probes \(each is classified NOT_RUN\)/)
  assert.match(withLeads, /Only the exact reproducible leads requested by your prior UNVERIFIED report are disclosed above/)
  assert.ok(!/self-checks, conclusions, handoff narrative, private reasoning, and memory are deliberately/.test(withLeads))
})

test('isLeadBlocks accepts exactly formatLeads output', () => {
  assert.equal(R.isLeadBlocks(LEADS), true)
  assert.equal(R.isLeadBlocks(formatLeads([{ claim: 'a', probe: 'x\n\ny' }, { claim: 'b', probe: 'z' }])), true)
  assert.equal(R.isLeadBlocks(''), false)
  assert.equal(R.isLeadBlocks(`${LEADS}\n`), false)
  assert.equal(R.isLeadBlocks(`x\n${LEADS}`), false)
})

test('Verifier charter continuity, prior reports, decision contract and validation', () => {
  const g1 = R.verifierCharter({ ...base })
  assert.match(g1, /This is candidate generation 1\./)
  assert.match(g1, /Choose exactly one verdict as your system instructions define it/)
  assert.match(R.verifierCharter({ ...base, allowUnverified: false }), /return FAIL and state exactly what the evidence establishes/)
  assert.match(R.verifierCharter({ ...base, allowUnverified: false }), /VERDICT: PASS or VERDICT: FAIL\. Organize/)
  assert.match(R.verifierCharter({ ...base, allowUnverified: true }), /- UNVERIFIED when a material claim remains unresolved/)
  const other = R.verifierCharter({ ...base, generation: 3, handover: 'other-verifier', priorReports: ['r1', 'r2'] })
  assert.match(other, /You are a fresh Verifier context on a different model/)
  assert.match(other, /PUBLISHED REPORTS OF THE EARLIER VERIFIER CONTEXT[^\n]*\n--- report 1 ---\nr1\n--- report 2 ---\nr2\n---/)
  const self = R.verifierCharter({ ...base, generation: 2, priorReports: [{ generation: 1, text: '  report one ' }, ''] })
  assert.match(self, /--- generation 1 ---\nreport one\n--- report 2 ---\n\(report unavailable\)/)
  assert.match(R.verifierCharter({ ...base, mechanical: '  ' }), /---\n\(none captured\)\n---/)
  assert.match(R.verifierCharter({ ...base, changedSinceLast: 'MODIFIED: a.py' }), /CHANGED SINCE YOUR LAST INSPECTION/)
  assert.ok(!/CHANGED SINCE/.test(R.verifierCharter({ ...base, changedSinceLast: '' })))
  // A practice context already contained in the mechanical context is not repeated.
  const pc = R.verifierPracticeContext({ phase: 1 })
  const once = R.verifierCharter({ ...base, mechanical: `${pc}\n\nCREATED: x`, practiceContext: pc })
  assert.equal(once.split(pc).length, 2)
  assert.throws(() => R.verifierCharter({ ...base, generation: 0 }), /generation/)
  assert.throws(() => R.verifierCharter({ ...base, handover: 'peer' }), /handover/)
  assert.throws(() => R.verifierCharter({ ...base, task: ' ' }), /task/)
  assert.throws(() => R.verifierCharter({ ...base, candidateRoot: '' }), /candidateRoot/)
})

test('the Verifier mechanics paragraph claims only the isolation actually used', () => {
  const sandbox = R.verifierSystem({ location: 'live', sandbox: true, allowUnverified: false })
  const rollback = R.verifierSystem({ location: 'live', sandbox: false, allowUnverified: false })
  const replay = R.verifierSystem({ location: 'replay', sandbox: false, allowUnverified: false })
  assert.match(sandbox, /run inside an OS sandbox/)
  assert.ok(!/NOT sandboxed/.test(sandbox))
  for (const text of [rollback, replay]) {
    assert.match(text, /Your shell commands are NOT sandboxed: network access and other processes are NOT isolated/)
    assert.ok(!/inside an OS sandbox/.test(text))
    assert.match(text, /observe such services without sending mutating requests\. Establish the original candidate's properties before destructive experiments; a property created only by your own test is not candidate evidence\./)
  }
  assert.match(replay, /fresh copy of the captured candidate/)
  assert.match(rollback, /checkpointed the candidate's files/)
  assert.match(sandbox, /VERDICT: PASS or VERDICT: FAIL outside quotes/)
  assert.ok(!/UNVERIFIED/.test(sandbox))
  const unverified = R.verifierSystem({ location: 'live', sandbox: true, allowUnverified: true })
  assert.match(unverified, /VERDICT: PASS, VERDICT: FAIL, or VERDICT: UNVERIFIED outside quotes/)
  assert.match(unverified, /UNVERIFIED requests reproducible evidence from the same Actor Agent/)
  assert.match(unverified, /E1\. TRUTH CHANNELS/)
  assert.match(unverified, /mechanically hidden from your tools/)
  assert.throws(() => R.verifierSystem({ location: 'vm', sandbox: true }), PromptError)
})

test('a Verifier that follows its prompt publishes a parseable report', () => {
  // The prompt asks for exactly the line the parser accepts.
  const lines = R.verifierSystem({ location: 'live', sandbox: true, allowUnverified: true }).match(/VERDICT: [A-Z]+/g)
  for (const line of new Set(lines)) assert.ok(parseVerdict(`report\n${line}`, { allowUnverified: true }).ok, line)
})

test('Verifier continuation accepts the engine shapes', () => {
  assert.match(R.verifierContinuation('the harness resumed after a pause'), /: the harness resumed after a pause\. Continue/)
  assert.match(R.verifierContinuation({ detail: 'x.', allowUnverified: false }), /No PASS, FAIL, or correctness judgment/)
  assert.match(R.verifierContinuation({ detail: 'x', allowUnverified: true }), /No PASS, FAIL, UNVERIFIED, or correctness judgment/)
  assert.match(R.verifierContinuation(), /it did not contain exactly one standalone VERDICT line/)
  assert.match(R.verifierContinuation(), /No fixed retry count applies\.$/)
})

test('verbatim RSIAgent sentences survive the port (A6)', () => {
  const transport = R.transportContinuation({ role: 'ACTOR', detail: 'd', token: 'STATUS: SUBMIT' })
  assert.match(transport, /^ACTOR AGENT — SAME-CONTEXT TRANSPORT CONTINUATION\./)
  assert.match(transport, /This is not a correctness grade and does not change your role or decision\./)
  assert.match(transport, /No fixed retry count applies\.$/)
  assert.match(transport, /contains the standalone line STATUS: SUBMIT/)
  assert.match(R.transportContinuation({ role: 'curriculum', detail: 'd' }), /^CURRICULUM AGENT/)
  assert.throws(() => R.transportContinuation({ role: 'judge', detail: 'd' }), /role must be one of/)
  assert.match(R.unverified({ report: 'r' }), /Evidence the WORLD produces — a file you author about your own work proves nothing and will not count\./)
  assert.match(R.distillation({ outcome: 'FAIL', report: 'r', memoryDir: '/m', owner: 'engine' }),
    /A FAIL may still contain valuable evidence,\nbut must not be recorded as a verified success\./)
  assert.match(R.reconciliation({ memoryDir: '/m', owner: 'engine' }), /Do not merely append this episode while leaving contradicted older advice stated\nas fact\./)
  assert.match(R.engineSystem(), /THE METHOD — code as policy:\n1\. RECON FIRST, EXHAUSTIVELY\./)
  assert.match(R.engineSystem(), /EPISTEMIC CORE — how truth is established here[^\n]*\nE1\. TRUTH CHANNELS/)
  assert.match(R.engineSystem(), /YOUR FINAL MESSAGE IS YOUR HANDOFF/)
  assert.match(R.repeatWarning(), /IDENTICAL command/)
})

test('learning builders: outcomes, owners, confirmation codes and limits', () => {
  assert.throws(() => R.distillation({ outcome: 'UNVERIFIED', report: 'r', memoryDir: '/m', owner: 'engine' }), /PASS or FAIL/)
  assert.throws(() => R.distillation({ outcome: 'PASS', report: 'r', memoryDir: '/m', owner: 'actor' }), /confirmCode/)
  assert.throws(() => R.distillation({ outcome: 'PASS', report: 'r', memoryDir: '/m', owner: 'curriculum' }), /owner/)
  assert.throws(() => R.distillation({ outcome: 'PASS', report: 'r', memoryDir: '/m', limits: { maxFiles: 0 } }), /limits\.maxFiles/)
  const engine = R.distillation({ outcome: 'PASS', report: 'r', memoryDir: '/m' })
  assert.match(engine, /at most 400 files, 4194304 bytes in total, and\n65536 bytes per file/)
  assert.match(engine, /End your turn when the memory you choose to carry forward is ready\.$/)
  assert.ok(!/memory_commit/.test(engine))
  const actor = R.distillation({ outcome: 'FAIL', report: 'r', memoryDir: '/d', owner: 'actor', confirmCode: '0a1b2c', limits: { maxFiles: 10 } })
  assert.match(actor, /at most 10 files/)
  assert.match(actor, /call memory_commit with confirm "0a1b2c"\.$/)
  assert.match(R.reconciliation({ memoryDir: '/d', owner: 'actor', confirmCode: 'abcdef' }), /confirm "abcdef"; that call promotes the draft/)
  assert.throws(() => R.reconciliation({ memoryDir: '/d', owner: 'actor', confirmCode: 'ABCDEF' }), /confirmCode/)
  assert.match(R.diagnosis(), /remain available in\nyour context/)
  assert.match(R.diagnosis({ outcome: 'pass', report: ' rep ' }), /The terminal Verifier outcome is PASS\.[\s\S]*---\nrep\n---/)
  assert.match(R.diagnosis(), /End your turn with the diagnosis as your final message when it is ready\.$/)
  assert.match(R.limitCondense({ detail: 'too big.', memoryDir: '/m' }), /cannot be promoted: too big\. The memory store/)
  assert.match(R.conflict({ prevDir: '/p', draftDir: '/d' }), /preserved at \/p; \/d now holds the current memory/)
})

test('Actor openings: placeholders, memory preamble, runtime contract composition', () => {
  const contract = R.actorRuntimeContract({ projectRoot: '/w/p', memoryDir: '/w/m' })
  assert.ok(contract.startsWith('\n\nGENERIC RUNTIME OWNERSHIP BOUNDARY:\n'))
  assert.match(contract, /edits to your memory directory\nduring work are discarded/)
  const practice = R.practiceActorCharter({ instruction: 'Write <PROJECT_ROOT>/out.txt.', projectRoot: '/w/p', memoryDir: '/w/m' })
  assert.match(practice, /Write \/w\/p\/out\.txt\./)
  assert.match(practice, /\(no durable memory files yet\)/)
  assert.match(practice, /STATUS: SUBMIT on a line of its own/)
  assert.match(practice, /SUBMIT is neutral: it claims neither success nor failure/)
  const target = R.targetActorOpening({ target: 'Fix <PROJECT_ROOT>/a.py', projectRoot: '/w/t', memoryDir: '/w/m', inventory: { lines: ['  1  a.md'], omitted: 0 } })
  assert.ok(target.startsWith('[YOUR MEMORY'))
  assert.match(target, /Current durable-memory inventory \(1 files\):\n {2}1 {2}a\.md\n\nTASK:\nFix \/w\/t\/a\.py/)
  assert.ok(target.endsWith('promote memory.'))
  const frozen = R.targetActorOpening({ target: 'Fix it', projectRoot: '/w/t', memoryDir: '/w/m', empty: true, frozen: true })
  assert.ok(!/distillation|learn from it/.test(frozen))
  assert.match(frozen, /Durable memory is frozen/)
  assert.match(R.memoryPreamble({ memoryDir: '/m', inventory: { lines: ['… 2 more files'], omitted: 2 } }), /inventory \(2 files\):\n… 2 more files$/)
  assert.match(R.memoryPreamble({ memoryDir: '/m', inventory: { lines: ['  1  a'], omitted: 0, total: 9 } }), /\(9 files\)/)
  assert.match(R.memoryPreamble({ memoryDir: '/m' }), /empty \(0 files\)\.$/)
  assert.throws(() => R.memoryPreamble({}), /memoryDir/)
})

test('resume openings: handoff vs pivot, caps, recovery revisit, no preamble', () => {
  const args = { target: 'T <PROJECT_ROOT>', projectRoot: '/r', memoryDir: '/m' }
  const handoff = R.resumeOpening({ ...args, changed: true, worklog: 'log' })
  assert.match(handoff, /^NOTE: a previous attempt already worked on this task/)
  assert.match(handoff, /The previous attempt's work log:\nlog\n\n\[MEMORY RETRIEVAL OPPORTUNITY\] The conversation or environment channel has just recovered/)
  assert.match(handoff, /TASK:\nT \/r\n/)
  assert.ok(!handoff.includes('[YOUR MEMORY'))
  const unknown = R.resumeOpening({ ...args, worklog: '' })
  assert.match(unknown, /^NOTE: a previous attempt already worked/)
  assert.ok(!/work log/.test(unknown))
  const pivot = R.resumeOpening({ ...args, changed: false, worklog: 'w', review: 'r'.repeat(3000) })
  assert.match(pivot, /stalled WITHOUT changing any files/)
  assert.ok(pivot.includes(`self-review:\n${'r'.repeat(2500)}\n\nIts work log`))
  const long = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(30)}`).join('\n')
  const capped = R.resumeOpening({ ...args, changed: true, worklog: long })
  assert.match(capped, /line 0000/)
  assert.ok(!capped.includes('line 0999'))
  assert.match(capped, /\[\.\.\. WORK LOG truncated at the character cap/)
  const logPart = capped.slice(capped.indexOf("work log:\n") + 10, capped.indexOf('\n[... WORK LOG'))
  assert.ok(logPart.length <= 12000)
  const pivotCapped = R.resumeOpening({ ...args, changed: false, worklog: long })
  const pivotLog = pivotCapped.slice(pivotCapped.indexOf('remain true):\n') + 14, pivotCapped.indexOf('\n[... WORK LOG'))
  assert.ok(pivotLog.length <= 6000)
})

test('memory revisit and other appended fragments start with a blank line', () => {
  for (const event of ['verifier', 'fold', 'recovery', 'stagnation']) {
    const text = R.memoryRevisit(event, { memoryDir: '/m' })
    assert.ok(text.startsWith('\n\n[MEMORY RETRIEVAL OPPORTUNITY] '))
    assert.match(text, /available at \/m\./)
  }
  assert.match(R.memoryRevisit('fold'), /available at your memory directory\./)
  assert.throws(() => R.memoryRevisit('boredom', { memoryDir: '/m' }), PromptError)
  assert.ok(R.leadsRequest().startsWith('\n\nEVIDENCE LEADS: end your turn'))
  assert.ok(R.leadsRequest({ interactive: true }).startsWith('\n\nEVIDENCE LEADS: call submit with evidence_leads'))
  assert.ok(R.curriculumRuntimeContract({ cwd: '/c', authoringRoot: '/c/a', notesFile: '/c/n.md' }).startsWith('\n\nGENERIC RUNTIME'))
  assert.ok(R.phase1RecoveryNotice().startsWith('\n\nHARNESS RECOVERY NOTICE:\n'))
  assert.ok(R.disagreement({ report: 'r', memoryNonEmpty: true, memoryDir: '/m' }).endsWith('decide yourself what, if anything, to retrieve.'))
  assert.ok(!/MEMORY RETRIEVAL/.test(R.disagreement({ report: 'r', memoryDir: '/m' })))
})

test('recoveryNote embeds the original message verbatim at the end', () => {
  const message = 'line 1\n{{NOT_A_VAR}}\n$& end\n'
  const note = R.recoveryNote({ message })
  assert.ok(note.startsWith('HARNESS RECOVERY: the harness was interrupted'))
  assert.ok(note.endsWith(`--- MESSAGE ---\n${message}`))
  assert.throws(() => R.recoveryNote({}), /message/)
})

test('task messages, interactive task and task pin', () => {
  assert.equal(R.interactiveTask({ messages: [{ text: 'only', current: true }] }), 'only')
  assert.equal(R.interactiveTask({ messages: [] }), '(no user request was found in this session)')
  assert.equal(R.interactiveTask({ messages: [{ text: 'old', current: false }, { text: 'a', current: true }, { text: 'b', current: true }] }),
    '[earlier context, before this task began]\nold\n\n[user message 1 of 2]\na\n\n[user message 2 of 2, latest]\nb')
  assert.equal(R.taskPin({ messages: [{ text: 'goal', current: true }] }), 'TASK (verbatim, unchanged — this is the actual goal):\ngoal')
})

test('Curriculum builders: memory access variants, notes, defaults, outcomes', () => {
  const wave = R.waveCharter({ direction: 'd', authoringRoot: '/a', memoryDir: null })
  assert.ok(!/Actor-owned memory at/.test(wave))
  assert.match(wave, /The description is the allowed target distribution\./)
  assert.match(wave, /\(no earlier Phase-1 wave has completed\)/)
  assert.match(wave, /consolidated into memory one\nproject at a time, in the order you list them/)
  assert.match(R.waveCharter({ direction: 'd', targetConditioned: true, authoringRoot: '/a', memoryDir: '/m' }),
    /evidence and the current Actor-owned memory at \/m \(a read-only evidence copy\) to decide/)
  const none = R.deepCharter({ target: 't', memoryAccess: 'none', authoringRoot: '/a' })
  assert.match(none, /You have no memory copy\./)
  assert.match(none, /the Actor learning diagnosis, and every later practice outcome/)
  assert.match(none, /\(no projects have completed yet\)[\s\S]*\(no project outcome yet\)[\s\S]*\(empty — this is the first search turn\)/)
  assert.throws(() => R.deepCharter({ target: 't', authoringRoot: '/a' }), /memoryDir/)
  assert.throws(() => R.deepCharter({ target: 't', memoryAccess: 'all', authoringRoot: '/a', memoryDir: '/m' }), /memoryAccess/)
  const outcome = R.outcomeText({ instruction: 'i', verdict: 'fail', reports: ['a', 'b'], memoryChanges: { modified: ['z', 'a'], created: [], deleted: [] } })
  assert.match(outcome, /^PROJECT\n\nORIGINAL NATURAL-LANGUAGE PROJECT \(verbatim\):\ni\n\nTERMINAL OUTCOME: FAIL\n\nVERIFIER REPORT 1 \(verbatim\):\na\n\nVERIFIER REPORT 2 \(verbatim\):\nb\n\nMEMORY CHANGES:\n/)
  assert.ok(outcome.endsWith('{\n  "created": [],\n  "deleted": [],\n  "modified": [\n    "a",\n    "z"\n  ]\n}'))
  assert.throws(() => R.outcomeText({ instruction: 'i', verdict: 'MAYBE', reports: [] }), /verdict/)
  assert.match(R.waveOutcomes({ wave: 1, rationale: 'r', outcomes: ['a', 'b'] }), /^WAVE 1 CURRICULUM RATIONALE:\nr\n\na\n\n---\n\nb$/)
  assert.match(R.targetOutcomeText({ target: 't', verdict: 'PASS', report: 'r', diagnosis: '', lifecycle: true }),
    /LIFECYCLE TRANSITION:\nThe declared self-evolving protocol entered learning after the target Verifier Agent PASS\.[\s\S]*DIAGNOSIS \(verbatim\):\n\(none\)$/)
})

test('guidance: verdict header, learn hints, notes, running, infra, refusals, commits', () => {
  const pass = G.guidanceVerdict({ verdict: 'PASS', report: 'ok\nVERDICT: PASS', generation: 3, isolation: { mode: 'sandbox', reason: 'r' }, model: 'm' })
  assert.equal(pass.split('\n')[0], 'cc-rsi · Verifier: VERDICT: PASS (generation 3, isolation=sandbox, model=m)')
  assert.match(pass, /Next: call learn/)
  assert.ok(!/learn/.test(G.guidanceVerdict({ verdict: 'PASS', report: 'r', generation: 1, isolation: 'rollback', mode: 'frozen' }).split('\n').slice(1).join('\n')))
  const fail = G.guidanceVerdict({ verdict: 'fail', report: 'bad', generation: 1, isolation: 'rollback', model: 'm', restored: ['a'] })
  assert.match(fail, /then call submit again\./)
  assert.match(fail, /a FAIL still teaches/)
  assert.match(fail, /HARNESS NOTE: 1 path\(s\) changed during the inspection and were restored: a$/)
  const unv = G.guidanceVerdict({ verdict: 'UNVERIFIED', report: 'hmm', generation: 1, isolation: 'rollback', model: 'm' })
  assert.match(unv, /evidence_leads/)
  assert.ok(!/call learn/.test(unv))
  assert.match(G.guidanceVerdict({ verdict: 'PASS', report: 'r', generation: 1, isolation: 'rollback', staleDigestNote: 'custom stale' }), /\n\ncustom stale$/)
  assert.throws(() => G.guidanceVerdict({ verdict: 'MAYBE', report: 'r', generation: 1 }), PromptError)
  assert.throws(() => G.guidanceVerdict({ verdict: 'PASS', report: ' ', generation: 1 }), PromptError)
  assert.match(G.guidanceRunning({ jobId: 'j-1', generation: 2, elapsedSec: 41.6 }), /^VERIFICATION RUNNING \(job j-1, generation 2\): [^\n]* 42 s\. [\s\S]*wait_verdict/)
  assert.equal(G.guidanceInfra({ cls: 'timeout' }), 'INFRASTRUCTURE: the independent inspection could not reach a verdict (timeout). This is not a verdict about your work.')
  assert.equal(G.guidanceInfra({ cls: 'auth', remedy: 'Run cc-rsi doctor --live.', detail: 'd' }),
    'INFRASTRUCTURE: the independent inspection could not reach a verdict (auth). This is not a verdict about your work. Run cc-rsi doctor --live.\nDetail: d')
  for (const kind of G.REFUSAL_KINDS) assert.ok(G.guidanceRefusal(kind, { anything: 1 }).length > 10, kind)
  assert.equal(G.guidanceRefusal('not_attested'), 'cc-rsi cannot attest this call: its hooks are not active in this session (run cc-rsi doctor). No verification was started.')
  assert.equal(G.guidanceRefusal('subagent'), 'submit/learn are reserved for the main Actor conversation.')
  assert.throws(() => G.guidanceRefusal('nope'), PromptError)
  const learn = G.guidanceLearnStart({ outcome: 'PASS', report: 'r', draftDir: '/d', confirmCode: 'abc123' })
  assert.ok(learn.endsWith('\n\nCONFIRM CODE: abc123'))
  assert.match(learn, /durable memory at \/d/)
  assert.equal(G.guidanceCommitResult('promoted', { outcome: 'pass', created: ['a', 'b'], modified: [], deleted: ['c'], treeAfter: 'abcdef0123456789', files: 2 }),
    'Memory promoted (PASS experience). created: a, b; modified: -; deleted: c. Tree abcdef012345, 2 files.')
  assert.ok(G.guidanceCommitResult('reconcile', { draftDir: '/d', confirmCode: '123abc' }).endsWith('CONFIRM CODE: 123abc'))
  assert.throws(() => G.guidanceCommitResult('promoted', { outcome: 'PASS', treeAfter: 'x' }), /file count/)
  assert.throws(() => G.guidanceCommitResult('weird'), PromptError)
  for (const kind of G.COMMIT_KINDS) assert.ok(typeof kind === 'string')
})

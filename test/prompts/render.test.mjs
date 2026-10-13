// SPEC §8.1–§8.3 / §15.3 WP2: strict placeholders; goldens for every builder; forbidden-string
// scan; every template used; bundleSha stable; snapshot rendering.
//
// Goldens: test/prompts/golden/<builder>.txt holds every case of that builder, each preceded by
// a "===== <case> =====" line. Regenerate after a deliberate prompt change with
//   CC_RSI_UPDATE_GOLDENS=1 node --test test/prompts/render.test.mjs
// and review the diff by hand.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../_helpers/tmp.mjs'
import {
  PROMPT_NAMES, PromptError, bundleSha, loadTemplate, loadedTemplateNames, promptsDir, render, renderSection,
  setPromptsDir, snapshotPrompts, templateSections,
} from '../../lib/prompts/render.mjs'
import * as R from '../../lib/prompts/roles.mjs'
import * as G from '../../lib/prompts/guidance.mjs'
import { formatLeads } from '../../lib/protocol/leads.mjs'

const GOLDEN = fileURLToPath(new URL('./golden/', import.meta.url))
const UPDATE = process.env.CC_RSI_UPDATE_GOLDENS === '1'

// ---------------------------------------------------------------- fixed inputs

const H = '/srv/cc/home'
const W = `${H}/work/demo-0123456789ab/deep-20261013120000`
const VIEW = `${H}/projects/demo-0123456789ab/views/5e1c0a2b/memory`
const DRAFT = `${H}/projects/demo-0123456789ab/drafts/task-5e1c0a2b-3-g2`
const INVENTORY = {
  lines: ['  2140  notes/csv-quoting.md', '  611  tools/merge_csv.py', '… 3 more files'],
  omitted: 3,
}
const FAIL_REPORT = [
  '# Inspection of generation 1',
  'I ran `python3 merge.py a.csv b.csv` from the candidate root: the output drops the quoted comma row.',
  '',
  '```',
  '$ wc -l out.csv',
  '41 out.csv',
  '```',
  '',
  'VERDICT: FAIL',
].join('\n')
const PASS_REPORT = 'All four requirements hold; out.csv has 42 rows and the header is preserved.\n\nVERDICT: PASS'
const UNVERIFIED_REPORT = 'The deduplication rule could not be confirmed either way from the files alone.\nVERDICT: UNVERIFIED'
const LEADS = formatLeads([
  { claim: 'out.csv keeps the quoted comma row', probe: 'grep -c \'"a,b"\' out.csv | grep -qx 1 && echo PASS' },
  { claim: 'rows are sorted by id', probe: 'python3 - <<\'PY\'\nimport csv\nrows = list(csv.DictReader(open("out.csv")))\nprint("PASS" if rows == sorted(rows, key=lambda r: int(r["id"])) else "FAIL")\nPY' },
])
const TASK_MESSAGES = [
  { seq: 11, text: 'We use pandas here.', current: false },
  { seq: 12, text: 'Merge a.csv and b.csv into out.csv, sorted by id.', current: true },
  { seq: 14, text: 'Also keep the header row.', current: true },
]
const COMMIT = { outcome: 'PASS', created: ['notes/quoting.md'], modified: ['tools/merge_csv.py'], deleted: [], treeAfter: '4f1c2a9be07d55aa0011', files: 6 }

/** builder → [[case, () => string]] */
const CASES = {
  epistemic: [['default', () => R.epistemic()]],
  memoryPreamble: [
    ['populated', () => R.memoryPreamble({ memoryDir: VIEW, inventory: INVENTORY })],
    ['empty', () => R.memoryPreamble({ memoryDir: VIEW, inventory: { lines: [], omitted: 0 }, empty: true })],
    ['omitted-line-added', () => R.memoryPreamble({ memoryDir: VIEW, inventory: { lines: ['  10  a.md'], omitted: 2 } })],
  ],
  memoryRevisit: ['verifier', 'fold', 'recovery', 'stagnation'].map(event => [event, () => R.memoryRevisit(event, { memoryDir: VIEW })]),
  actorProtocol: [
    ['learn-unverified', () => R.actorProtocol({ mode: 'learn', allowUnverified: true, memoryViewDir: VIEW })],
    ['learn-pass-fail', () => R.actorProtocol({ mode: 'learn', allowUnverified: false, memoryViewDir: VIEW })],
    ['frozen', () => R.actorProtocol({ mode: 'frozen', allowUnverified: true, memoryViewDir: VIEW })],
  ],
  taskPin: [
    ['single', () => R.taskPin({ messages: [{ text: 'Fix the CSV merger in this repo.', current: true }] })],
    ['several', () => R.taskPin({ messages: TASK_MESSAGES })],
  ],
  engineSystem: [['default', () => R.engineSystem()]],
  actorRuntimeContract: [['default', () => R.actorRuntimeContract({ projectRoot: `${W}/projects/p001`, memoryDir: `${W}/actor-private/p001/memory` })]],
  practiceActorCharter: [
    ['with-memory', () => R.practiceActorCharter({
      instruction: 'In <PROJECT_ROOT>, merge in/a.csv and in/b.csv into out.csv sorted by id.',
      projectRoot: `${W}/projects/w001-csv-merge`, memoryDir: `${W}/actor-private/w001-csv-merge/memory`, inventory: INVENTORY,
    })],
    ['empty-memory', () => R.practiceActorCharter({
      instruction: `In ${W}/projects/p002, write a CSV validator.`,
      projectRoot: `${W}/projects/p002`, memoryDir: `${W}/actor-private/p002/memory`, inventory: { lines: [], omitted: 0 }, empty: true,
    })],
  ],
  targetActorOpening: [
    ['deep', () => R.targetActorOpening({ target: 'Make `make test` pass without changing tests/.', projectRoot: `${W}/projects/t001`, memoryDir: `${W}/actor-private/t001/memory`, inventory: INVENTORY, frozen: false })],
    ['deep-empty', () => R.targetActorOpening({ target: 'Make `make test` pass.', projectRoot: `${W}/projects/t001`, memoryDir: `${W}/actor-private/t001/memory`, empty: true })],
    ['frozen', () => R.targetActorOpening({ target: 'Make `make test` pass.', projectRoot: `${W}/projects/t001`, memoryDir: `${W}/actor-private/t001/memory`, inventory: INVENTORY, frozen: true })],
  ],
  resumeOpening: [
    ['handoff', () => R.resumeOpening({ changed: true, worklog: 'CURRENT STATE: parser half rewritten.\nNEXT: fix quoting.', target: 'Make `make test` pass.', projectRoot: `${W}/projects/t001`, memoryDir: `${W}/actor-private/t001/memory` })],
    ['handoff-no-log', () => R.resumeOpening({ worklog: '', target: 'Make `make test` pass.', projectRoot: `${W}/projects/t001`, memoryDir: `${W}/actor-private/t001/memory` })],
    ['pivot', () => R.resumeOpening({ changed: false, worklog: 'tried sed edits — failed because quoting.', review: '(1) sed edits (2) quoting (3) use the csv module', target: 'Make `make test` pass.', projectRoot: `${W}/projects/t001`, memoryDir: `${W}/actor-private/t001/memory` })],
    ['handoff-capped', () => R.resumeOpening({ changed: true, worklog: Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'), target: 'T', projectRoot: '/r', memoryDir: '/m' }).length.toString()],
  ],
  summarizerSystem: [['default', () => R.summarizerSystem()]],
  summarizerRequest: [
    ['messages', () => R.summarizerRequest({ currentLog: '', messages: [{ who: 'YOU', text: 'Bash: ls in/' }, { who: 'ENV', text: 'a.csv\nb.csv' }] })],
    ['with-log', () => R.summarizerRequest({ currentLog: 'CURRENT STATE: listing done.', messages: [{ who: 'you', text: 'Read in/a.csv' }] })],
  ],
  strategyReviewSystem: [['default', () => R.strategyReviewSystem()]],
  strategyReviewAsk: [
    ['string-tail', () => R.strategyReviewAsk({ worklog: 'tried X — failed because Y', tail: '[YOU]\nBash: make test\n\n[ENV]\n2 failed' })],
    ['message-tail', () => R.strategyReviewAsk({ worklog: '', tail: [{ who: 'YOU', text: 'Bash: make' }, { who: 'ENV', text: 'error' }] })],
  ],
  disagreement: [
    ['engine', () => R.disagreement({ report: FAIL_REPORT })],
    ['engine-memory', () => R.disagreement({ report: FAIL_REPORT, memoryDir: `${W}/actor-private/t001/memory`, memoryNonEmpty: true })],
    ['interactive', () => R.disagreement({ report: FAIL_REPORT, interactive: true })],
  ],
  unverified: [
    ['engine', () => R.unverified({ report: UNVERIFIED_REPORT })],
    ['interactive', () => R.unverified({ report: UNVERIFIED_REPORT, interactive: true })],
  ],
  leadsRequest: [
    ['engine', () => R.leadsRequest({ interactive: false })],
    ['interactive', () => R.leadsRequest({ interactive: true })],
  ],
  distillation: [
    ['engine-fail', () => R.distillation({ outcome: 'FAIL', report: FAIL_REPORT, memoryDir: `${W}/actor-private/p001/memory`, limits: { maxFiles: 400, maxTotalBytes: 4194304, maxFileBytes: 65536 }, owner: 'engine' })],
    ['actor-pass', () => R.distillation({ outcome: 'pass', report: PASS_REPORT, memoryDir: DRAFT, owner: 'actor', confirmCode: '7f3a9c' })],
  ],
  reconciliation: [
    ['engine', () => R.reconciliation({ memoryDir: `${W}/actor-private/p001/memory`, owner: 'engine' })],
    ['actor', () => R.reconciliation({ memoryDir: DRAFT, owner: 'actor', confirmCode: '0c1d2e' })],
  ],
  diagnosis: [
    ['in-context', () => R.diagnosis()],
    ['repeated', () => R.diagnosis({ outcome: 'FAIL', report: FAIL_REPORT })],
  ],
  conflict: [
    ['engine', () => R.conflict({ prevDir: `${W}/actor-private/p001/memory.prev`, draftDir: `${W}/actor-private/p001/memory`, owner: 'engine' })],
    ['actor', () => R.conflict({ prevDir: `${DRAFT}.prev`, draftDir: DRAFT, owner: 'actor', confirmCode: 'a1b2c3' })],
  ],
  limitCondense: [
    ['engine', () => R.limitCondense({ detail: "412 files > 400; 'notes/big.md' 70211 bytes > 65536.", memoryDir: `${W}/actor-private/p001/memory`, owner: 'engine' })],
    ['actor', () => R.limitCondense({ detail: '5000000 bytes > 4194304', memoryDir: DRAFT, owner: 'actor', confirmCode: 'ffee00' })],
  ],
  transportContinuation: [
    ['actor-token', () => R.transportContinuation({ role: 'ACTOR', detail: 'your final message had no standalone line "STATUS: SUBMIT" outside code fences', token: 'STATUS: SUBMIT' })],
    ['curriculum-token', () => R.transportContinuation({ role: 'CURRICULUM', detail: 'the PROJECT handoff does not name <PROJECT_ROOT>.', token: 'DECISION: …' })],
    ['actor-free', () => R.transportContinuation({ role: 'ACTOR', detail: 'the diagnosis was empty' })],
  ],
  stallContinuation: [
    ['actor-token', () => R.stallContinuation({ role: 'ACTOR', token: 'STATUS: SUBMIT' })],
    ['default', () => R.stallContinuation()],
  ],
  truncatedContinuation: [['default', () => R.truncatedContinuation()]],
  recoveryNote: [['message', () => R.recoveryNote({ message: 'ACTOR AGENT — NEW PROJECT.\n\n…the original message…\n' })]],
  repeatWarning: [['default', () => R.repeatWarning()]],
  verifierSystem: [
    ['live-sandbox-unverified', () => R.verifierSystem({ location: 'live', sandbox: true, allowUnverified: true })],
    ['live-rollback-unverified', () => R.verifierSystem({ location: 'live', sandbox: false, allowUnverified: true })],
    ['replay-sandbox-pass-fail', () => R.verifierSystem({ location: 'replay', sandbox: true, allowUnverified: false })],
    ['replay-unconfined-unverified', () => R.verifierSystem({ location: 'replay', sandbox: false, allowUnverified: true })],
  ],
  verifierCharter: [
    ['interactive-g1', () => R.verifierCharter({
      generation: 1, task: R.interactiveTask({ messages: TASK_MESSAGES }), candidateRoot: '/repo', scratchDir: `${H}/vscratch/6f1c`,
      mechanical: 'UNCOMMITTED CHANGES (git status --porcelain, 2):\n M merge.py\n?? out.csv', allowUnverified: true,
    })],
    ['interactive-g2-leads-changed', () => R.verifierCharter({
      generation: 2, task: 'Merge a.csv and b.csv.', candidateRoot: '/repo', scratchDir: `${H}/vscratch/6f1c`, mechanical: '',
      changedSinceLast: 'MODIFIED: merge.py', leads: LEADS, allowUnverified: true,
    })],
    ['fresh-self-prior-reports', () => R.verifierCharter({
      generation: 3, task: 'Merge a.csv and b.csv.', candidateRoot: '/repo', scratchDir: `${H}/vscratch/77aa`, mechanical: 'M merge.py',
      priorReports: [FAIL_REPORT, { generation: 2, text: UNVERIFIED_REPORT }], handover: 'self', allowUnverified: true,
    })],
    ['other-verifier', () => R.verifierCharter({
      generation: 2, task: 'Make `make test` pass.', candidateRoot: `${W}/projects/t001`, scratchDir: `${W}/verify-scratch/t001-v2`,
      mechanical: 'CREATED this run: fix.py', priorReports: [FAIL_REPORT], handover: 'other-verifier',
    })],
    ['practice-phase2', () => R.verifierCharter({
      generation: 1, task: `In ${W}/verify/p001/candidate, merge in/a.csv and in/b.csv.`, candidateRoot: `${W}/verify/p001/candidate`,
      scratchDir: `${W}/verify-scratch/p001-v1`, mechanical: `${R.verifierPracticeContext({ phase: 2, evidenceRound: false })}\n\nCREATED: out.csv`,
      originalFixturesDir: `${W}/verify/p001/original`, practiceContext: R.verifierPracticeContext({ phase: 2, evidenceRound: false }), allowUnverified: false,
    })],
  ],
  interactiveTask: [
    ['single', () => R.interactiveTask({ messages: [{ seq: 1, text: 'Add a --version flag.', current: true }] })],
    ['several', () => R.interactiveTask({ messages: TASK_MESSAGES })],
    ['none', () => R.interactiveTask({ messages: [] })],
  ],
  verifierPracticeContext: [
    ['phase1', () => R.verifierPracticeContext({ phase: 1 })],
    ['phase2', () => R.verifierPracticeContext({ phase: 2 })],
    ['phase2-evidence', () => R.verifierPracticeContext({ phase: 2, evidenceRound: true })],
  ],
  verifierContinuation: [
    ['unverified', () => R.verifierContinuation({ detail: 'your reply contained conflicting VERDICT lines (PASS, FAIL)', allowUnverified: true })],
    ['pass-fail', () => R.verifierContinuation({ detail: 'VERDICT: UNVERIFIED is not available here; use one of PASS or FAIL', allowUnverified: false })],
    ['bare-string', () => R.verifierContinuation('the harness resumed after a pause')],
  ],
  curriculumSystem: [['default', () => R.curriculumSystem()]],
  curriculumRuntimeContract: [['default', () => R.curriculumRuntimeContract({ cwd: `${W}/curriculum-private`, authoringRoot: `${W}/curriculum-private/practice/authoring`, notesFile: `${W}/curriculum-private/notes.md` })]],
  waveCharter: [
    ['distribution-first', () => R.waveCharter({ direction: 'Small text-processing command-line tools.', targetConditioned: false, priorWave: '', authoringRoot: `${W}/curriculum-private/authoring`, memoryDir: `${W}/curriculum-private/memory`, notes: '' })],
    ['target-conditioned', () => R.waveCharter({ direction: 'Make `make test` pass in a CSV library.', targetConditioned: true, priorWave: R.waveOutcomes({ wave: 1, rationale: 'probe quoting', outcomes: [R.outcomeText({ label: 'PROJECT 1.1 (csv-quote)', instruction: 'In <PROJECT_ROOT> fix quoting.', verdict: 'FAIL', reports: [FAIL_REPORT], memoryChanges: { created: ['notes/q.md'], deleted: [], modified: [], unchanged: [] } })] }), authoringRoot: `${W}/curriculum-private/authoring`, memoryDir: null, notes: 'H1: quoting is the gap.' })],
  ],
  waveContinuation: [['default', () => R.waveContinuation({ detail: 'the fixture tree for project "csv-1" is not replayable: it is empty', authoringRoot: `${W}/curriculum-private/authoring` })]],
  deepCharter: [
    ['read-only-first', () => R.deepCharter({ target: 'Make `make test` pass.', history: [], latestOutcome: '', notes: '', memoryAccess: 'read_only', authoringRoot: `${W}/curriculum-private/practice/authoring`, memoryDir: `${W}/curriculum-private/memory` })],
    ['none-with-history', () => R.deepCharter({ target: 'Make `make test` pass.', history: ['- Phase-2 target attempt 1: FAIL', '- Phase-2 practice project p001: PASS'], latestOutcome: R.targetOutcomeText({ target: 'Make `make test` pass.', verdict: 'FAIL', report: FAIL_REPORT, diagnosis: 'Quoting is the likely gap.', lifecycle: true }), notes: 'H1', memoryAccess: 'none', authoringRoot: `${W}/curriculum-private/practice/authoring` })],
  ],
  curriculumContinuation: [['default', () => R.curriculumContinuation({ detail: 'your reply had no standalone line "DECISION: …" outside code fences' })]],
  phase1RecoveryNotice: [['default', () => R.phase1RecoveryNotice()]],
  outcomeText: [
    ['phase1', () => R.outcomeText({ label: 'PROJECT 2.1 (csv-merge)', instruction: 'In <PROJECT_ROOT> merge a.csv and b.csv.', verdict: 'PASS', reports: [PASS_REPORT], memoryChanges: { created: ['notes/b.md', 'notes/a.md'], modified: [], deleted: ['old.md'], unchanged: ['tools/x.py'] } })],
    ['phase2', () => R.outcomeText({ label: 'PRACTICE PROJECT p001', instruction: 'In <PROJECT_ROOT> merge a.csv and b.csv.', verdict: 'FAIL', reports: [FAIL_REPORT], memoryChanges: { created: [], modified: ['notes/a.md'], deleted: [] }, diagnosis: 'The quoting rule is the gap.' })],
    ['phase2-evidence-rounds', () => R.outcomeText({ instruction: 'In <PROJECT_ROOT> sort rows.', verdict: 'PASS', reports: [UNVERIFIED_REPORT, PASS_REPORT], diagnosis: null })],
  ],
  waveOutcomes: [['default', () => R.waveOutcomes({ wave: 2, rationale: 'Contrast quoting with escaping.', outcomes: ['PROJECT 2.1 (a)\n\n…', 'PROJECT 2.2 (b)\n\n…'] })]],
  targetOutcomeText: [
    ['lifecycle', () => R.targetOutcomeText({ target: 'Make `make test` pass.', verdict: 'PASS', report: PASS_REPORT, diagnosis: 'The csv module approach generalizes.', lifecycle: true })],
    ['no-diagnosis', () => R.targetOutcomeText({ target: 'Make `make test` pass.', verdict: 'FAIL', report: FAIL_REPORT, diagnosis: '', lifecycle: false })],
  ],
  notesBlock: [['notes', () => R.notesBlock('H1: quoting.')], ['empty', () => R.notesBlock('')]],
  guidanceVerdict: [
    ['pass-learn', () => G.guidanceVerdict({ verdict: 'PASS', report: PASS_REPORT, generation: 1, isolation: { mode: 'sandbox', reason: 'bwrap' }, model: 'claude-sonnet-4-5', mode: 'learn' })],
    ['pass-frozen', () => G.guidanceVerdict({ verdict: 'PASS', report: PASS_REPORT, generation: 2, isolation: 'rollback', model: null, mode: 'frozen' })],
    ['fail-notes', () => G.guidanceVerdict({
      verdict: 'FAIL', report: FAIL_REPORT, generation: 2, isolation: 'rollback', model: 'opus', memoryNonEmpty: true, memoryDir: VIEW, mode: 'learn',
      restored: Array.from({ length: 22 }, (_, i) => `f${i}.txt`), displaced: ['a', 'b'], staleDigestNote: true,
    })],
    ['fail-detect-only-tamper', () => G.guidanceVerdict({ verdict: 'FAIL', report: FAIL_REPORT, generation: 1, isolation: 'rollback', model: 'opus', restored: ['big.bin'], detectOnly: true, tamperNote: true })],
    ['unverified', () => G.guidanceVerdict({ verdict: 'UNVERIFIED', report: UNVERIFIED_REPORT, generation: 1, isolation: 'rollback', model: 'opus', memoryNonEmpty: true, memoryDir: VIEW })],
  ],
  guidanceRunning: [['default', () => G.guidanceRunning({ jobId: 'j-20261013120000-a1b2c3', generation: 2, elapsedSec: 100.4 })]],
  guidanceInfra: [
    ['full', () => G.guidanceInfra({ cls: 'auth', detail: 'authentication_failed (401)', remedy: 'Log in again or check apiKeyHelper; run cc-rsi doctor --live in a terminal.' })],
    ['bare', () => G.guidanceInfra({ cls: 'job_died' })],
  ],
  guidanceRefusal: G.REFUSAL_KINDS.map(kind => [kind, () => G.guidanceRefusal(kind, { ignored: true })]),
  guidanceLearnStart: [['fail', () => G.guidanceLearnStart({ outcome: 'FAIL', report: FAIL_REPORT, draftDir: DRAFT, limits: { maxFiles: 400, maxTotalBytes: 4194304, maxFileBytes: 65536 }, confirmCode: '9a8b7c' })]],
  guidanceCommitResult: [
    ['reconcile', () => G.guidanceCommitResult('reconcile', { draftDir: DRAFT, confirmCode: '1a2b3c' })],
    ['promoted', () => G.guidanceCommitResult('promoted', COMMIT)],
    ['promoted-empty-lists', () => G.guidanceCommitResult('promoted', { ...COMMIT, outcome: 'fail', created: [], modified: [] })],
    ['limit', () => G.guidanceCommitResult('limit', { detail: '412 files > 400', draftDir: DRAFT, confirmCode: '4d5e6f' })],
    ['conflict', () => G.guidanceCommitResult('conflict', { prevDir: `${DRAFT}.prev`, draftDir: DRAFT, confirmCode: '777888' })],
    ...['already', 'quarantined', 'frozen', 'abandoned'].map(kind => [kind, () => G.guidanceCommitResult(kind)]),
  ],
}

/** Every builder of SPEC §8.2 (plus notesBlock) has golden cases. */
const SPEC_BUILDERS = [
  'epistemic', 'memoryPreamble', 'memoryRevisit', 'actorProtocol', 'taskPin', 'engineSystem', 'actorRuntimeContract',
  'practiceActorCharter', 'targetActorOpening', 'resumeOpening', 'summarizerSystem', 'summarizerRequest',
  'strategyReviewSystem', 'strategyReviewAsk', 'disagreement', 'unverified', 'leadsRequest', 'distillation',
  'reconciliation', 'diagnosis', 'conflict', 'limitCondense', 'transportContinuation', 'stallContinuation',
  'truncatedContinuation', 'recoveryNote', 'repeatWarning', 'verifierSystem', 'verifierCharter', 'interactiveTask',
  'verifierPracticeContext', 'verifierContinuation', 'curriculumSystem', 'curriculumRuntimeContract', 'waveCharter',
  'waveContinuation', 'deepCharter', 'curriculumContinuation', 'phase1RecoveryNotice', 'outcomeText', 'waveOutcomes',
  'targetOutcomeText', 'guidanceVerdict', 'guidanceRunning', 'guidanceInfra', 'guidanceRefusal', 'guidanceLearnStart',
  'guidanceCommitResult',
]

function renderAll() {
  const out = {}
  for (const [builder, cases] of Object.entries(CASES)) {
    out[builder] = cases.map(([name, fn]) => [name, fn()])
  }
  return out
}

function goldenText(cases) {
  return cases.map(([name, text]) => `===== ${name} =====\n${text}\n`).join('')
}

// ---------------------------------------------------------------- tests

test('every SPEC §8.2 builder is exported and has golden cases', () => {
  for (const builder of SPEC_BUILDERS) {
    assert.ok(builder in CASES, `no golden cases for ${builder}`)
    assert.equal(typeof (R[builder] ?? G[builder]), 'function', `${builder} is not exported`)
  }
})

test('every builder renders and matches its golden file', () => {
  setPromptsDir(null)
  const rendered = renderAll()
  for (const [builder, cases] of Object.entries(rendered)) {
    for (const [name, text] of cases) {
      assert.equal(typeof text, 'string', `${builder}/${name}`)
      assert.ok(text.length > 0, `${builder}/${name} is empty`)
    }
    const file = join(GOLDEN, `${builder}.txt`)
    const actual = goldenText(cases)
    if (UPDATE) {
      writeFileSync(file, actual)
      continue
    }
    let expected
    try {
      expected = readFileSync(file, 'utf8')
    } catch {
      assert.fail(`missing golden ${file}; run with CC_RSI_UPDATE_GOLDENS=1 and review it`)
    }
    assert.equal(actual, expected, `golden mismatch for ${builder}`)
  }
})

// Strings that must never reach a role or the Actor (SPEC §8.3 A1/A2/A4; §15.3 WP2).
const FORBIDDEN = [
  '/home/user', 'evolution_project', '~/.memory', '/host/frozen', 'OSWorld', '"program":', 'rsi_handoff', 'rsi_submit',
  'rsi_learn', 'rsi_memory', 'rsi_notes', 'PLAIN_JSON', 'max_iters', 'actor_handoff.md', 'phase1_wave.json',
  'project_next.md', 'learning_diagnosis.md', 'declare done', 'PLAN:', 'verifier-report',
]
const FORBIDDEN_RE = [/json action/i, /\bOverleaf\b/i, /\bdesktop\b/i, /\bVM\b/, /\bscreenshot/i, /\bGLM\b/, /\bK3\b/, /\bKimi\b/i, /\bQEMU\b/i]
// No prompt states a numeric budget or ceiling (A5). Allowlist of verbatim RSIAgent sentences that
// legitimately need the word next to a digit: currently none (every such sentence was reworded).
const BUDGET_RE = /\b(budget|ceiling)\b[^.\n]*\d/i
const BUDGET_ALLOWLIST = []

function scanForbidden(where, text) {
  for (const needle of FORBIDDEN) assert.ok(!text.includes(needle), `${where} contains forbidden "${needle}"`)
  for (const re of FORBIDDEN_RE) assert.ok(!re.test(text), `${where} matches forbidden ${re}`)
  const budget = BUDGET_RE.exec(text)
  if (budget) assert.ok(BUDGET_ALLOWLIST.some(allowed => budget[0].startsWith(allowed)), `${where} discloses a budget/ceiling: "${budget[0]}"`)
}

test('no rendered prompt or template contains forbidden strings or a numeric budget', () => {
  setPromptsDir(null)
  for (const [builder, cases] of Object.entries(renderAll())) {
    for (const [name, text] of cases) scanForbidden(`${builder}/${name}`, text)
  }
  for (const name of PROMPT_NAMES) scanForbidden(`prompts/${name}.md`, loadTemplate(name).text)
})

test('every file in prompts/ is referenced by some builder', () => {
  setPromptsDir(null)
  renderAll()
  assert.deepEqual(loadedTemplateNames(), [...PROMPT_NAMES])
})

test('PROMPT_NAMES is exactly the sorted contents of prompts/', () => {
  const files = readdirSync(promptsDir()).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
  assert.deepEqual([...PROMPT_NAMES], files)
  assert.deepEqual([...PROMPT_NAMES], [...PROMPT_NAMES].sort())
  assert.ok(Object.isFrozen(PROMPT_NAMES))
})

test('bundleSha is stable and equals the sha256 of each file', () => {
  setPromptsDir(null)
  const first = bundleSha()
  const second = bundleSha()
  assert.deepEqual(first, second)
  assert.deepEqual(Object.keys(first), [...PROMPT_NAMES])
  for (const name of PROMPT_NAMES) {
    const bytes = readFileSync(join(promptsDir(), `${name}.md`))
    assert.equal(first[name], createHash('sha256').update(bytes).digest('hex'))
  }
})

test('snapshotPrompts copies every template (0600 in 0700) and setPromptsDir renders from the snapshot', async () => {
  setPromptsDir(null)
  const original = R.repeatWarning()
  const dir = join(await tmpDir('cc-rsi-prompts-'), 'lineage', 'prompts')
  const shas = await snapshotPrompts(dir)
  assert.deepEqual(shas, bundleSha())
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  for (const name of PROMPT_NAMES) assert.equal(statSync(join(dir, `${name}.md`)).mode & 0o777, 0o600)
  writeFileSync(join(dir, 'repeat-warning.md'), 'SNAPSHOT WARNING\n')
  try {
    setPromptsDir(dir)
    assert.equal(R.repeatWarning(), 'SNAPSHOT WARNING')
    assert.notDeepEqual(bundleSha()['repeat-warning'], shas['repeat-warning'])
    // Everything else renders unchanged from the snapshot.
    assert.equal(R.engineSystem(), (setPromptsDir(null), R.engineSystem()))
  } finally {
    setPromptsDir(null)
  }
  assert.equal(R.repeatWarning(), original)
})

test('strict placeholders: missing, unused and non-string variables throw; values are verbatim', async () => {
  const dir = join(await tmpDir('cc-rsi-prompts-'), 'p')
  await snapshotPrompts(dir)
  writeFileSync(join(dir, 'task-pin.md'), 'A {{TASK}} B {{ not }} {{lower}} {{ OPEN\n')
  writeFileSync(join(dir, 'notes-block.md'), '## block\n\nX {{NOTES}} Y\n\n\n## empty\n  (empty)  \n## block2x\nlast')
  try {
    setPromptsDir(dir)
    assert.equal(render('task-pin', { TASK: 'v {{TASK}} $& $1' }), 'A v {{TASK}} $& $1 B {{ not }} {{lower}} {{ OPEN\n')
    assert.throws(() => render('task-pin', {}), PromptError)
    assert.throws(() => render('task-pin', {}), /missing variable\(s\) TASK/)
    assert.throws(() => render('task-pin', { TASK: 'x', TYPO: 'y' }), /passed but not used: TYPO/)
    assert.throws(() => render('task-pin', { TASK: undefined }), /must be a string/)
    assert.throws(() => render('task-pin', { TASK: null }), /must be a string/)
    assert.throws(() => render('task-pin', { TASK: {} }), /must be a string/)
    assert.equal(render('task-pin', { TASK: 7 }), 'A 7 B {{ not }} {{lower}} {{ OPEN\n')
    assert.throws(() => render('no-such-template'), PromptError)
    assert.throws(() => loadTemplate('../etc/passwd'), PromptError)
    assert.deepEqual(templateSections('notes-block'), ['block', 'empty', 'block2x'])
    assert.equal(renderSection('notes-block', 'block', { NOTES: 'n' }), 'X n Y')
    assert.equal(renderSection('notes-block', 'empty'), '  (empty)  ')
    assert.equal(renderSection('notes-block', 'block2x'), 'last')
    assert.throws(() => renderSection('notes-block', 'nope'), /has no section "nope"/)
    assert.throws(() => renderSection('notes-block', 'block'), /missing variable/)
  } finally {
    setPromptsDir(null)
  }
})

test('a template missing from the active directory is a PromptError, not a crash', async () => {
  const dir = await tmpDir('cc-rsi-prompts-empty-')
  try {
    setPromptsDir(dir)
    assert.throws(() => R.repeatWarning(), err => err instanceof PromptError && /cannot be read/.test(err.message))
  } finally {
    setPromptsDir(null)
  }
})

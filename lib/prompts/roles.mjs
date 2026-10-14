// Role prompt builders (SPEC §8.2). Every builder is a thin composition of prompts/*.md
// templates; callers MUST use these instead of `render`. All builders return strings without a
// trailing newline. Fragments that RSIAgent appends to a preceding message start with a blank line
// ("\n\n"), exactly like their RSIAgent originals (`_actor_runtime_contract`,
// `_curriculum_runtime_contract`, `_memory_revisit`), so `a + b` composition reads correctly.
//
// Sources (SPEC §8.3): RSIAgent texts as dsh-rsi neutralised them (dsh-rsi src/roles/*.ts), with
// rules A1–A6: no JSON-program transport (native Claude Code tools are the action channel), guest
// paths replaced by placeholders, handoff files replaced by the role's final message, no benchmark
// nouns, no disclosed budgets or ceilings, and benchmark-independent RSIAgent sentences verbatim.

import { sortUtf8 } from '../core/digest.mjs'
import { LEADS_REQUEST_FORMAT } from '../protocol/leads.mjs'
import { isSyntaxDetail } from '../protocol/tokens.mjs'
import { PROJECT_ROOT_TOKEN } from '../protocol/wave.mjs'
import { PromptError, render, renderSection } from './render.mjs'

/** Default store limits (SPEC §14.2 `memory.maxFiles / maxTotalBytes / maxFileBytes`). */
export const DEFAULT_MEMORY_LIMITS = Object.freeze({ maxFiles: 400, maxTotalBytes: 4194304, maxFileBytes: 65536 })

const NO_REQUEST = '(no user request was found in this session)'
const MORE_LINE = /^\s*(?:…|\.\.\.)\s*\d+\s+more\b/

// ---------------------------------------------------------------- helpers

/** Renders a whole template without the file's own trailing newline. */
function t(name, vars = {}) {
  const text = render(name, vars)
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

const sec = renderSection

function str(value, what) {
  if (typeof value !== 'string') throw new PromptError(`${what} must be a string`)
  return value
}

function nonEmpty(value, what) {
  const text = str(value, what).trim()
  if (text === '') throw new PromptError(`${what} must not be empty`)
  return text
}

/** A path argument: a non-empty string, used verbatim. */
function path(value, what) {
  if (typeof value !== 'string' || value.trim() === '') throw new PromptError(`${what} must be a non-empty path`)
  return value
}

/** Drops one trailing period so a detail fits the "…: {{DETAIL}}." sentence shape. */
function detailText(detail, fallback) {
  const text = typeof detail === 'string' && detail.trim() !== '' ? detail.trim() : fallback
  return text.endsWith('.') && !text.endsWith('..') ? text.slice(0, -1) : text
}

function owner(value) {
  const who = value ?? 'engine'
  if (who !== 'engine' && who !== 'actor') throw new PromptError(`owner must be "engine" or "actor" (got ${JSON.stringify(value)})`)
  return who
}

function confirm(code) {
  if (typeof code !== 'string' || !/^[0-9a-f]{6}$/.test(code)) throw new PromptError('confirmCode must be 6 lowercase hex characters')
  return code
}

function terminalOutcome(outcome) {
  const value = String(outcome ?? '').trim().toUpperCase()
  // RSIAgent charter.py:1168-1170: only PASS or FAIL ever reaches learning.
  if (value !== 'PASS' && value !== 'FAIL') throw new PromptError(`terminal outcome must be PASS or FAIL (got ${JSON.stringify(outcome)})`)
  return value
}

function verdictValue(verdict) {
  const value = String(verdict ?? '').trim().toUpperCase()
  if (!['PASS', 'FAIL', 'UNVERIFIED'].includes(value)) throw new PromptError(`verdict must be PASS, FAIL or UNVERIFIED (got ${JSON.stringify(verdict)})`)
  return value
}

function limitVars(limits) {
  const merged = { ...DEFAULT_MEMORY_LIMITS, ...(limits && typeof limits === 'object' ? limits : {}) }
  for (const key of ['maxFiles', 'maxTotalBytes', 'maxFileBytes']) {
    if (!Number.isInteger(merged[key]) || merged[key] <= 0) throw new PromptError(`limits.${key} must be a positive integer`)
  }
  return { MAX_FILES: merged.maxFiles, MAX_TOTAL_BYTES: merged.maxTotalBytes, MAX_FILE_BYTES: merged.maxFileBytes }
}

/** Replaces the Curriculum's `<PROJECT_ROOT>` placeholder with the real root (dsh actor.ts:108). */
function withRoot(text, projectRoot) {
  return text.split(PROJECT_ROOT_TOKEN).join(projectRoot)
}

/** The inventory listing lines, with a "… N more files" line when entries were omitted. */
function inventoryListing(inventory) {
  const lines = Array.isArray(inventory?.lines) ? inventory.lines.map(line => String(line)) : []
  const omitted = Number.isInteger(inventory?.omitted) && inventory.omitted > 0 ? inventory.omitted : 0
  if (omitted > 0 && !lines.some(line => MORE_LINE.test(line))) lines.push(`… ${omitted} more files`)
  const listed = lines.filter(line => !MORE_LINE.test(line)).length
  const total = Number.isInteger(inventory?.total) && inventory.total >= 0 ? inventory.total : listed + omitted
  return { lines, total }
}

/**
 * Cuts a work log to `cap` characters, keeping the TOP (the summarizer orders the most
 * decision-relevant content first) at a line boundary, with RSIAgent's truncation marker
 * (core/loop.py:66-68 `_cap_worklog`).
 */
function capWorklog(text, cap) {
  const log = String(text ?? '').trim()
  if (log.length <= cap) return log
  const cut = log.lastIndexOf('\n', cap)
  return `${log.slice(0, cut > 0 ? cut : cap).trimEnd()}\n${sec('resume-handoff', 'truncated')}`
}

/** dsh index.ts:540-548 authoritative-task labels, plus the cc-rsi earlier-context label. */
function formatTaskMessages(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter(m => m && typeof m.text === 'string')
  if (list.length === 0) return NO_REQUEST
  if (list.length === 1 && list[0].current !== false) return list[0].text
  const total = list.filter(m => m.current !== false).length
  let index = 0
  return list.map(m => {
    if (m.current === false) return `[earlier context, before this task began]\n${m.text}`
    index++
    return `[user message ${index} of ${total}${index === total ? ', latest' : ''}]\n${m.text}`
  }).join('\n\n')
}

// ---------------------------------------------------------------- shared

/** RSIAgent core/actor.py:19 EPISTEMIC_CORE as dsh-rsi roles/epistemic.ts rewrote it (E1–E6). */
export function epistemic() {
  return t('epistemic')
}

/**
 * RSIAgent `memory_preamble` (explore/charter.py:10-36): names and sizes only, no file body, no
 * privileged index file. `inventory` = `formatInventory()` output `{ lines, omitted }` (an optional
 * `total` overrides the file count). `empty` selects the empty-memory variant.
 */
export function memoryPreamble({ memoryDir, inventory, empty } = {}) {
  const dir = path(memoryDir, 'memoryPreamble: memoryDir')
  const { lines, total } = inventoryListing(inventory)
  // An inventory with no line at all is empty whatever `empty` says (never "(0 files):" + nothing).
  if (empty === true || lines.length === 0) return t('memory-preamble-empty', { MEMORY_DIR: dir })
  return t('memory-preamble', { MEMORY_DIR: dir, FILE_COUNT: total, LISTING: lines.join('\n') })
}

const REVISIT_EVENTS = ['verifier', 'fold', 'recovery', 'stagnation']

/**
 * RSIAgent `_memory_revisit` (core/loop.py:231-250): a retrieval opportunity at a lifecycle
 * boundary that never names, ranks or reads a file. Starts with a blank line, like the original.
 */
export function memoryRevisit(event, { memoryDir } = {}) {
  if (!REVISIT_EVENTS.includes(event)) throw new PromptError(`memoryRevisit: unknown event ${JSON.stringify(event)}`)
  const dir = typeof memoryDir === 'string' && memoryDir.trim() !== '' ? memoryDir : 'your memory directory'
  return `\n\n${t(`memory-revisit-${event}`, { MEMORY_DIR: dir })}`
}

// ---------------------------------------------------------------- interactive

/** SessionStart context for the main-session Actor (dsh roles/actor.ts actorProtocol, 3 renderings). */
export function actorProtocol({ mode = 'learn', allowUnverified = true, memoryViewDir } = {}) {
  if (mode !== 'learn' && mode !== 'frozen') throw new PromptError(`actorProtocol: mode must be "learn" or "frozen" (got ${JSON.stringify(mode)})`)
  return t('actor-protocol', {
    EPISTEMIC: epistemic(),
    UNVERIFIED_CLAUSE: allowUnverified ? `\n${t('actor-protocol-unverified')}` : '',
    MEMORY_DIR: path(memoryViewDir, 'actorProtocol: memoryViewDir'),
    MODE_SECTION: t(mode === 'frozen' ? 'actor-protocol-frozen' : 'actor-protocol-learn'),
  })
}

/** RSIAgent task pin above the work log (core/loop.py:970); `messages` = `[{ text, current }]`. */
export function taskPin({ messages } = {}) {
  return t('task-pin', { TASK: formatTaskMessages(messages) })
}

// ---------------------------------------------------------------- engine Actor

/**
 * Lineage Actor and Curriculum system append (RSIAgent core/actor.py:76 `_SYSTEM_TEMPLATE` with
 * `_DISCIPLINE_LINE` :226 and the native look bullet :55; dsh engineActorSystem), without the
 * JSON action protocol (A1): the role acts through its tools and its final message is its handoff.
 */
export function engineSystem() {
  return t('engine-system', { EPISTEMIC: epistemic() })
}

/**
 * Where an engine Actor puts disposable artifacts: its private scratch directory when the harness
 * gives it one (`scratchDir`, readable and writable by its file tools), else a temporary directory
 * that only its shell commands are known to reach (its file tools are confined to the project
 * root and the memory directory).
 */
function scratchPhrase(scratchDir, what) {
  if (scratchDir === undefined || scratchDir === null) return sec('actor-scratch', 'shell')
  return sec('actor-scratch', 'private', { SCRATCH_DIR: path(scratchDir, `${what}: scratchDir`) })
}

/**
 * RSIAgent `_actor_runtime_contract` (explore/practice_loop.py:484-498); starts with a blank line.
 * `scratchDir` (optional) is the Actor's private scratch directory, named instead of /tmp.
 */
export function actorRuntimeContract({ projectRoot, memoryDir, scratchDir } = {}) {
  return `\n\n${t('actor-runtime-contract', {
    PROJECT_ROOT: path(projectRoot, 'actorRuntimeContract: projectRoot'),
    SCRATCH: scratchPhrase(scratchDir, 'actorRuntimeContract'),
    MEMORY_DIR: path(memoryDir, 'actorRuntimeContract: memoryDir'),
  })}`
}

/** The learning-free runtime boundary of a Phase-3 (frozen) Actor; starts with a blank line. */
function frozenRuntimeBoundary(projectRoot, scratchDir, what) {
  return `\n\n${t('frozen-runtime-boundary', { PROJECT_ROOT: projectRoot, SCRATCH: scratchPhrase(scratchDir, what) })}`
}

/**
 * First message of a fresh practice Actor (RSIAgent `self_evolving_actor_charter`,
 * explore/charter.py:590; dsh practiceActorCharter). The caller appends `actorRuntimeContract`.
 */
export function practiceActorCharter({ instruction, projectRoot, memoryDir, inventory, empty } = {}) {
  const root = path(projectRoot, 'practiceActorCharter: projectRoot')
  const { lines } = inventoryListing(inventory)
  const listing = empty === true || lines.length === 0 ? '(no durable memory files yet)' : lines.join('\n')
  return t('practice-actor-charter', {
    MEMORY_DIR: path(memoryDir, 'practiceActorCharter: memoryDir'),
    LISTING: listing,
    PROJECT_ROOT: root,
    INSTRUCTION: withRoot(nonEmpty(instruction, 'practiceActorCharter: instruction'), root),
  })
}

/**
 * Target attempt opening: `memory_preamble(listing)` + the opening (RSIAgent phase2.py:928-943
 * composition; protocol-target-attempt.md §1a/§1b) with the handoff rule of
 * `self_evolving_target_actor_charter` (charter.py:643) and the runtime contract. `frozen`
 * selects the Phase-3 opening (protocol-frozen-mode.md §1a) and its learning-free runtime
 * boundary. `scratchDir` (optional) is the Actor's private scratch directory.
 */
export function targetActorOpening({ target, projectRoot, memoryDir, inventory, empty, frozen = false, scratchDir } = {}) {
  const root = path(projectRoot, 'targetActorOpening: projectRoot')
  const dir = path(memoryDir, 'targetActorOpening: memoryDir')
  const vars = { TARGET: withRoot(nonEmpty(target, 'targetActorOpening: target'), root), PROJECT_ROOT: root }
  const preamble = memoryPreamble({ memoryDir: dir, inventory, empty })
  if (frozen) return `${preamble}\n\n${t('frozen-actor-opening', vars)}${frozenRuntimeBoundary(root, scratchDir, 'targetActorOpening')}`
  return `${preamble}\n\n${t('target-actor-opening', vars)}${actorRuntimeContract({ projectRoot: root, memoryDir: dir, scratchDir })}`
}

/**
 * Fresh-context resume after a stalled target attempt (RSIAgent `run_with_resume`): the work-log
 * handoff when the root changed or the change is unknown (core/actor.py:285 `handoff_message`,
 * log capped at 12000 characters), else the strategy pivot (:318 `pivot_handoff_message`, review
 * capped at 2500 and log at 6000); then `_memory_revisit('recovery')` (core/loop.py:1753) and the
 * opening without the memory preamble. `frozen` (a Phase-3 attempt) keeps the frozen opening's
 * handoff (a FAIL comes back to this context for repair) and its learning-free runtime boundary
 * instead of the runtime contract, which promises a memory-distillation phase.
 */
export function resumeOpening({ changed, worklog, review, target, projectRoot, memoryDir, frozen = false, scratchDir } = {}) {
  const root = path(projectRoot, 'resumeOpening: projectRoot')
  const dir = path(memoryDir, 'resumeOpening: memoryDir')
  const parts = []
  if (changed === false) {
    parts.push(sec('resume-pivot', 'note'))
    const selfReview = String(review ?? '').trim().slice(0, 2500).trim()
    if (selfReview !== '') parts.push(sec('resume-pivot', 'review', { REVIEW: selfReview }))
    const log = capWorklog(worklog, 6000)
    if (log !== '') parts.push(sec('resume-pivot', 'worklog', { WORKLOG: log }))
  } else {
    parts.push(sec('resume-handoff', 'note'))
    const log = capWorklog(worklog, 12000)
    if (log !== '') parts.push(sec('resume-handoff', 'worklog', { WORKLOG: log }))
  }
  const opening = sec('resume-appendix', 'main', {
    TARGET: withRoot(nonEmpty(target, 'resumeOpening: target'), root),
    PROJECT_ROOT: root,
    HANDOFF: sec('resume-appendix', frozen === true ? 'handoff-frozen' : 'handoff'),
  })
  const boundary = frozen === true
    ? frozenRuntimeBoundary(root, scratchDir, 'resumeOpening')
    : actorRuntimeContract({ projectRoot: root, memoryDir: dir, scratchDir })
  return `${parts.join('\n\n')}${memoryRevisit('recovery', { memoryDir: dir })}\n\n${opening}${boundary}`
}

/** RSIAgent SUMMARIZER_SYSTEM (core/actor.py:240). */
export function summarizerSystem() {
  return t('summarizer-system')
}

function turnLines(messages, perMessageCap = Infinity) {
  return (Array.isArray(messages) ? messages : []).map((message, i) => {
    const who = String(message?.who ?? '').toUpperCase()
    if (who !== 'YOU' && who !== 'ENV') throw new PromptError(`message ${i + 1}: who must be "YOU" or "ENV"`)
    const text = String(message?.text ?? '')
    return `[${who}]\n${Number.isFinite(perMessageCap) ? text.slice(0, perMessageCap) : text}`
  }).join('\n\n')
}

/** RSIAgent fold request (core/loop.py:87-91); the caller pre-cuts each message (SPEC §12.10). */
export function summarizerRequest({ currentLog, messages } = {}) {
  const log = String(currentLog ?? '').trim()
  return t('summarizer-request', {
    CURRENT_LOG: log === '' ? '(empty)' : log,
    TURNS: turnLines(messages),
  })
}

/** RSIAgent STRATEGY_REVIEW_SYSTEM (core/actor.py:297). */
export function strategyReviewSystem() {
  return t('strategy-review-system')
}

/**
 * RSIAgent `strategy_review_ask` (core/actor.py:302): worklog[:8000], tail[:6000]; a message
 * array tail is rendered `[YOU]`/`[ENV]` with each message cut to 1500 characters.
 */
export function strategyReviewAsk({ worklog, tail } = {}) {
  const tailText = Array.isArray(tail) ? turnLines(tail, 1500) : String(tail ?? '')
  const log = String(worklog ?? '').slice(0, 8000).trim()
  const end = tailText.slice(0, 6000).trim()
  return t('strategy-review-ask', { WORKLOG: log === '' ? '(empty)' : log, TAIL: end === '' ? '(none)' : end })
}

/**
 * Feedback after a Verifier FAIL (RSIAgent core/verifier.py:1684 `disagreement_message`; dsh
 * disagreementMessage), without an items punch list, plus `_memory_revisit('verifier')` when the
 * memory is non-empty. The default ending asks for a new STATUS: SUBMIT handoff (engine, Phase-3
 * same-Actor repair); `interactive: true` (a cc-rsi optional parameter) asks for submit again.
 */
export function disagreement({ report, memoryDir, memoryNonEmpty = false, interactive = false } = {}) {
  const text = t('disagreement', {
    REPORT: nonEmpty(report, 'disagreement: report'),
    TAIL: t(interactive ? 'disagreement-tail-interactive' : 'disagreement-tail-engine'),
  })
  return memoryNonEmpty ? `${text}${memoryRevisit('verifier', { memoryDir })}` : text
}

/**
 * Feedback after a Verifier UNVERIFIED (RSIAgent core/verifier.py:1701 `unverified_message`,
 * evidence_request=True). "a file you author about your own work proves nothing" is verbatim.
 */
export function unverified({ report, memoryDir, memoryNonEmpty = false, interactive = false } = {}) {
  const text = t('unverified', {
    REPORT: nonEmpty(report, 'unverified: report'),
    TAIL: t(interactive ? 'unverified-tail-interactive' : 'unverified-tail-engine'),
  })
  return memoryNonEmpty ? `${text}${memoryRevisit('verifier', { memoryDir })}` : text
}

/**
 * The evidence-lead request after UNVERIFIED (dsh leadsRequest; RSIAgent done-check leads,
 * actor-done-protocol.md §5). Engine: CLAIM/PROBE lines plus STATUS: SUBMIT; interactive: the
 * `evidence_leads` argument of submit. Starts with a blank line.
 */
export function leadsRequest({ interactive = false } = {}) {
  return interactive
    ? `\n\n${t('leads-request-interactive')}`
    : `\n\n${t('leads-request-engine', { FORMAT: LEADS_REQUEST_FORMAT })}`
}

function reconciliationTail(who, memoryDir, confirmCode) {
  return who === 'actor'
    ? t('reconciliation-tail-actor', { MEMORY_DIR: memoryDir, CONFIRM_CODE: confirm(confirmCode) })
    : t('reconciliation-tail-engine')
}

/**
 * Learning step 1 (RSIAgent `self_evolving_actor_memory_distillation_msg`, explore/charter.py:1164;
 * dsh distillationMessage with its limits paragraph). `owner` 'engine' ends the turn; 'actor'
 * (interactive) edits the draft directory and calls memory_commit with the confirmation code.
 */
export function distillation({ outcome, report, memoryDir, limits, owner: who, confirmCode } = {}) {
  const value = terminalOutcome(outcome)
  const dir = path(memoryDir, 'distillation: memoryDir')
  const role = owner(who)
  return sec('distillation', 'main', {
    OUTCOME: value,
    OUTCOME_MEANING: sec('distillation', value === 'PASS' ? 'pass' : 'fail'),
    REPORT: nonEmpty(report, 'distillation: report'),
    MEMORY_DIR: dir,
    ...limitVars(limits),
    TAIL: role === 'actor'
      ? t('distillation-tail-actor', { MEMORY_DIR: dir, CONFIRM_CODE: confirm(confirmCode) })
      : t('distillation-tail-engine'),
  })
}

/** Learning step 2 (RSIAgent `self_evolving_actor_memory_reconciliation_msg`, charter.py:1205). */
export function reconciliation({ memoryDir, owner: who, confirmCode } = {}) {
  const dir = path(memoryDir, 'reconciliation: memoryDir')
  return t('reconciliation', { MEMORY_DIR: dir, TAIL: reconciliationTail(owner(who), dir, confirmCode) })
}

/**
 * Phase-2 learning step 3 (RSIAgent `self_evolving_actor_learning_diagnosis_msg`,
 * charter.py:1232): the diagnosis is the final message, not a file. With the optional
 * `{ outcome, report }` the report is repeated verbatim as in RSIAgent; without them the text
 * points at the report already in the same context.
 */
export function diagnosis({ outcome, report } = {}) {
  const head = outcome !== undefined && typeof report === 'string' && report.trim() !== ''
    ? sec('diagnosis', 'repeated', { OUTCOME: terminalOutcome(outcome), REPORT: report.trim() })
    : sec('diagnosis', 'in-context')
  return `${head}\n\n${sec('diagnosis', 'body')}`
}

/** Commit conflict after `rebaseDraft` (PR §4.9): the previous draft is preserved beside the new one. */
export function conflict({ prevDir, draftDir, owner: who, confirmCode } = {}) {
  const dir = path(draftDir, 'conflict: draftDir')
  return t('conflict', {
    PREV_DIR: path(prevDir, 'conflict: prevDir'),
    DRAFT_DIR: dir,
    TAIL: reconciliationTail(owner(who), dir, confirmCode),
  })
}

/** MemoryLimitError → the same Actor condenses the draft (dsh steps.ts limits continuation). */
export function limitCondense({ detail, memoryDir, owner: who, confirmCode, limits } = {}) {
  const dir = path(memoryDir, 'limitCondense: memoryDir')
  return t('limit-condense', {
    DETAIL: detailText(detail, 'the draft exceeds the memory store limits'),
    ...limitVars(limits),
    MEMORY_DIR: dir,
    TAIL: reconciliationTail(owner(who), dir, confirmCode),
  })
}

const ROLES = ['ACTOR', 'CURRICULUM', 'VERIFIER']

function roleName(role) {
  const value = String(role ?? 'ACTOR').toUpperCase()
  if (!ROLES.includes(value)) throw new PromptError(`role must be one of ${ROLES.join(', ')} (got ${JSON.stringify(role)})`)
  return value
}

/**
 * RSIAgent `_continuation_after_transport` (explore/practice_loop.py:501-507; dsh
 * transportContinuation): a handoff arrived but cannot be used. "This is not a correctness grade
 * … No fixed retry count applies." is verbatim. Without a `token` the role is asked for its
 * complete final message (e.g. a learning diagnosis).
 */
export function transportContinuation({ role, detail, token } = {}) {
  const vars = { ROLE: roleName(role), DETAIL: detailText(detail, 'the handoff could not be used') }
  if (typeof token === 'string' && token.trim() !== '') return sec('continuation-transport', 'token', { ...vars, TOKEN: token.trim() })
  return sec('continuation-transport', 'free', vars)
}

/** RSIAgent `_continue_after_stall` (practice_loop.py:510-519) for a liveness override. */
export function stallContinuation({ role, token } = {}) {
  const vars = { ROLE: roleName(role) }
  if (typeof token === 'string' && token.trim() !== '') return sec('continuation-stall', 'token', { ...vars, TOKEN: token.trim() })
  return sec('continuation-stall', 'free', vars)
}

/** dsh truncatedContinuation: a max_tokens turn end. */
export function truncatedContinuation() {
  return t('continuation-truncated')
}

/**
 * Recovery note for a re-sent message (PR §5.2; R1/F4): embeds the original message verbatim so a
 * context that never received it can still act on it.
 */
export function recoveryNote({ message } = {}) {
  return t('continuation-recovery', { MESSAGE: str(message, 'recoveryNote: message') })
}

/** RSIAgent REPEAT_WARNING (core/actor.py:267), "program" → "command". */
export function repeatWarning() {
  return t('repeat-warning')
}

// ---------------------------------------------------------------- Verifier

function verdictLines(allowUnverified) {
  if (allowUnverified === true) return 'VERDICT: PASS, VERDICT: FAIL, or VERDICT: UNVERIFIED'
  if (allowUnverified === false) return 'VERDICT: PASS or VERDICT: FAIL'
  return 'VERDICT: PASS, VERDICT: FAIL, or (only when your instructions allow it) VERDICT: UNVERIFIED'
}

const CHECKPOINTS = ['full', 'listed', 'detect']

/**
 * The mechanics paragraph of a Verifier inspection, from the ACTUAL isolation and restore
 * coverage: a replay inspects a fresh copy; a live inspection is restored from a checkpoint that
 * covers the whole tree ('full', the engine's copy of the project root), only the files git lists
 * ('listed', the interactive checkpoint), or nothing ('detect', a detect-only checkpoint).
 */
function mechanics(location, sandbox, checkpoint) {
  if (location === 'replay') return t(sandbox ? 'verifier-mechanics-replay-sandbox' : 'verifier-mechanics-replay-unconfined')
  if (sandbox) return sec('verifier-mechanics-live-sandbox', 'main', { CHECKPOINT: sec('verifier-mechanics-live-sandbox', `checkpoint-${checkpoint}`) })
  return sec('verifier-mechanics-live-rollback', 'main', {
    CHECKPOINT: sec('verifier-mechanics-live-rollback', `checkpoint-${checkpoint}`),
    // The interactive checkpoint ('listed') voids a PASS whose inspection left a pre-existing file
    // changed (r2-interactive-1), so that Verifier is told to keep those files byte-identical.
    EXPERIMENTS: sec('verifier-mechanics-live-rollback', checkpoint === 'detect' ? 'experiments-detect' : checkpoint === 'listed' ? 'experiments-listed' : 'experiments-rollback'),
  })
}

/**
 * Verifier system append (RSIAgent AGENTIC_VERIFIER_SYSTEM, core/verifier_runtime.py:27-60, with
 * the allow_unverified rewrite :111-143 and the private-paths suffix core/verifier.py:993-997;
 * dsh verifierSystem). The mechanics paragraph is rendered from the ACTUAL isolation (SPEC
 * §10.11): live = the real workspace under checkpoint/restore, replay = a fresh copy of a capture.
 * `checkpoint` (live only) is what the restore covers: 'full' (the whole candidate tree), 'listed'
 * (the files git tracks or would add; the default, so an unspecified live checkpoint never claims
 * more than the interactive checkpoint restores) or 'detect' (nothing is restored);
 * `detectOnly: true` is the same as `checkpoint: 'detect'`.
 */
export function verifierSystem({ location, sandbox, allowUnverified = false, checkpoint, detectOnly = false } = {}) {
  if (location !== 'live' && location !== 'replay') throw new PromptError(`verifierSystem: location must be "live" or "replay" (got ${JSON.stringify(location)})`)
  const coverage = detectOnly === true ? 'detect' : (checkpoint ?? 'listed')
  if (!CHECKPOINTS.includes(coverage)) throw new PromptError(`verifierSystem: checkpoint must be one of ${CHECKPOINTS.join(', ')} (got ${JSON.stringify(checkpoint)})`)
  const allow = allowUnverified === true
  return sec('verifier-system', 'main', {
    VERDICT_LINES: verdictLines(allow),
    MECHANICS: mechanics(location, sandbox === true, coverage),
    PRIVATE: t('verifier-private'),
    EPISTEMIC: epistemic(),
    DECISION_RULE: allow ? t('verifier-unverified-clause') : sec('verifier-system', 'decision-pass-fail'),
  })
}

const LEAD_BLOCK = /LEAD (\d+)\nActor-stated claim: [^\n]*\nExact reproducible probe proposed by Actor:\n--- BEGIN PROBE ---\n[\s\S]*?\n--- END PROBE ---\nHarness execution classification: (?:NOT_RUN|PASS|FAIL)/y

/**
 * True when `text` is nothing but `formatLeads` LEAD blocks joined by blank lines. The Verifier
 * must stay blind to the Actor's narrative: only these blocks may reach it (SPEC §7.3, J1-3).
 */
export function isLeadBlocks(text) {
  const source = String(text ?? '')
  let position = 0
  let expected = 1
  while (position < source.length) {
    LEAD_BLOCK.lastIndex = position
    const match = LEAD_BLOCK.exec(source)
    if (!match || Number(match[1]) !== expected) return false
    position = LEAD_BLOCK.lastIndex
    expected++
    if (position === source.length) return true
    if (!source.startsWith('\n\n', position)) return false
    position += 2
  }
  return false
}

function priorReportBlocks(reports) {
  return reports.map((report, i) => {
    const entry = typeof report === 'string' ? { text: report } : report ?? {}
    const text = String(entry.text ?? '').trim() || '(report unavailable)'
    const label = Number.isInteger(entry.generation) ? `generation ${entry.generation}` : `report ${i + 1}`
    return `--- ${label} ---\n${text}`
  }).join('\n')
}

/**
 * One inspection's message (RSIAgent `agent_harness_verifier_charter`, explore/charter.py:803-1031,
 * continuity :986-997, leads :922-944; dsh verifierCharter structure; PN §3.3 CHANGED SINCE YOUR
 * LAST INSPECTION). It carries only harness material: the authoritative task, the mechanical
 * context, the Verifier's own prior reports, the original fixtures path and formatted LEAD
 * blocks — never Actor reasoning, handoff narrative or memory. `allowUnverified` (an optional
 * cc-rsi parameter) selects RSIAgent's decision contract; when omitted the contract defers to the
 * system prompt. `priorReports` entries are strings or `{ generation, text }`.
 */
export function verifierCharter({
  generation, task, candidateRoot, scratchDir, mechanical, changedSinceLast, leads, priorReports, handover,
  originalFixturesDir, practiceContext, allowUnverified, changedByEarlierContext = false,
} = {}) {
  if (!Number.isInteger(generation) || generation < 1) throw new PromptError('verifierCharter: generation must be a positive integer')
  if (handover !== undefined && handover !== null && handover !== 'self' && handover !== 'other-verifier') {
    throw new PromptError(`verifierCharter: handover must be "self", "other-verifier" or null (got ${JSON.stringify(handover)})`)
  }
  const other = handover === 'other-verifier'
  const reports = Array.isArray(priorReports) ? priorReports : []
  const priorBlock = reports.length === 0
    ? ''
    : `\n\n${t(other ? 'verifier-charter-handover-reports' : 'verifier-charter-prior-reports', {
      REPORTS: priorReportBlocks(reports),
    })}`
  const mechanicalText = typeof mechanical === 'string' ? mechanical.trim() : ''
  const leadsText = typeof leads === 'string' ? leads.trim() : ''
  if (leadsText !== '' && !isLeadBlocks(leadsText)) {
    throw new PromptError('verifierCharter: leads must be formatLeads() LEAD blocks only; Actor narrative never reaches the Verifier')
  }
  const extras = []
  const changed = typeof changedSinceLast === 'string' ? changedSinceLast.trim() : ''
  // A context that did not perform the previous inspection (fresh, retired, restarted) is never told
  // it inspected before (r2-interactive-9).
  if (changed !== '') extras.push(sec('verifier-charter-changed', changedByEarlierContext === true ? 'earlier' : 'own', { CHANGED: changed }))
  const practice = typeof practiceContext === 'string' ? practiceContext.trim() : ''
  if (practice !== '' && !mechanicalText.includes(practice)) {
    extras.push(sec('verifier-charter', 'practice-context', { PRACTICE_CONTEXT: practice }))
  }
  if (typeof originalFixturesDir === 'string' && originalFixturesDir.trim() !== '') {
    extras.push(t('verifier-charter-original-fixtures', { ORIGINAL_FIXTURES_DIR: originalFixturesDir }))
  }
  if (leadsText !== '') extras.push(sec('verifier-charter-leads', 'block', { LEADS: leadsText }))
  const contract = allowUnverified === true ? 'decision-unverified' : allowUnverified === false ? 'decision-pass-fail' : 'decision-generic'
  return sec('verifier-charter', 'main', {
    // RSIAgent explore/charter.py:827-831: "FAIL or UNVERIFIED" only when UNVERIFIED exists here.
    CONTINUITY: other
      ? t('verifier-charter-continuity-other', { GENERATION: generation })
      : t('verifier-charter-continuity', { GENERATION: generation, CONTINUITY_EVENT: allowUnverified === false ? 'FAIL' : 'FAIL or UNVERIFIED' }),
    PRIOR_REPORTS: priorBlock,
    TASK: nonEmpty(task, 'verifierCharter: task'),
    CANDIDATE_ROOT: path(candidateRoot, 'verifierCharter: candidateRoot'),
    SCRATCH_DIR: path(scratchDir, 'verifierCharter: scratchDir'),
    MECHANICAL: mechanicalText === '' ? sec('verifier-charter', 'no-mechanical') : mechanicalText,
    EXTRA_CONTEXT: extras.length === 0 ? '' : `\n\n${extras.join('\n\n')}`,
    PRIVACY: leadsText !== '' ? sec('verifier-charter-leads', 'privacy') : sec('verifier-charter', 'privacy'),
    DECISION_CONTRACT: sec('verifier-charter', contract),
    VERDICT_LINES: verdictLines(allowUnverified),
  })
}

/**
 * The authoritative task for the interactive Verifier: the user's own recent messages, verbatim
 * (dsh index.ts:540-548 labels `[user message i of n, latest]`; earlier requests before the task
 * opened are labelled `[earlier context, before this task began]`).
 */
export function interactiveTask({ messages } = {}) {
  return formatTaskMessages(messages)
}

/**
 * Practice Verifier mechanical context (RSIAgent phase1_wave.py:411-414 (phase 1),
 * target_learning.py:437-442 (phase 2), practice_evidence_recovery.py:80-83 (evidence round)).
 */
export function verifierPracticeContext({ phase, evidenceRound = false } = {}) {
  if (phase !== 1 && phase !== 2) throw new PromptError(`verifierPracticeContext: phase must be 1 or 2 (got ${JSON.stringify(phase)})`)
  const base = t(`verifier-practice-context-${phase}`)
  return evidenceRound ? `${base} ${t('verifier-practice-context-evidence')}` : base
}

/**
 * Same-context Verifier transport recovery (RSIAgent core/verifier.py:784-838
 * `_agentic_recovery_prompt` + AGENTIC_VERIFIER_PREMATURE_DONE; dsh verifierTransportContinuation).
 * Accepts the options object or a bare detail string (the engine's `continuation(detail)` shape).
 * A detail that says the reply carried its VERDICT line in an unusable form (`isSyntaxDetail`)
 * selects RSIAgent's syntax-only correction (core/verifier_runtime.py:428-436 "Correct only the
 * report-channel syntax and publish again") instead of asking for a next investigation step.
 */
export function verifierContinuation(arg = {}) {
  const { detail, allowUnverified } = typeof arg === 'string' ? { detail: arg } : (arg ?? {})
  return sec('verifier-continuation', isSyntaxDetail(detail) ? 'syntax' : 'transport', {
    VERDICT_WORDS: allowUnverified === false ? 'PASS, FAIL' : 'PASS, FAIL, UNVERIFIED',
    DETAIL: detailText(detail, 'it did not contain exactly one standalone VERDICT line'),
    VERDICT_LINES: verdictLines(allowUnverified),
  })
}

// ---------------------------------------------------------------- Curriculum

/** Persistent Curriculum identity (dsh curriculumSystem; RSIAgent charter role text), A1. */
export function curriculumSystem() {
  return t('curriculum-system')
}

/** RSIAgent `_curriculum_runtime_contract` (explore/practice_loop.py:460-481); starts with a blank line. */
export function curriculumRuntimeContract({ cwd, authoringRoot, notesFile } = {}) {
  return `\n\n${t('curriculum-runtime-contract', {
    AUTHORING_ROOT: path(authoringRoot, 'curriculumRuntimeContract: authoringRoot'),
    CWD: path(cwd, 'curriculumRuntimeContract: cwd'),
    NOTES_FILE: path(notesFile, 'curriculumRuntimeContract: notesFile'),
  })}`
}

/** dsh notesBlock: the Curriculum's private notes as last saved. */
export function notesBlock(notes) {
  const text = String(notes ?? '').trim()
  return sec('notes-block', 'block', { NOTES: text === '' ? sec('notes-block', 'empty') : text })
}

/**
 * Phase-1 wave charter (RSIAgent `phase1_wave_curriculum_charter`, explore/charter.py:1265-1352,
 * with the SATURATED criteria :313-323 as dsh merged them; dsh waveCharter). The JSON envelope goes
 * in a fenced block of the final message.
 */
export function waveCharter({ direction, targetConditioned = false, priorWave, authoringRoot, memoryDir, notes } = {}) {
  const prior = String(priorWave ?? '').trim()
  return sec('wave-charter', 'main', {
    DIRECTION: nonEmpty(direction, 'waveCharter: direction'),
    SCOPE_NOTE: targetConditioned ? sec('wave-charter', 'target-conditioned') : t('wave-charter-distribution'),
    MEMORY_CLAUSE: typeof memoryDir === 'string' && memoryDir.trim() !== '' ? sec('wave-charter', 'memory', { MEMORY_DIR: memoryDir }) : '',
    PRIOR_WAVE: prior === '' ? t('wave-charter-first') : prior,
    NOTES_BLOCK: notesBlock(notes),
    AUTHORING_ROOT: path(authoringRoot, 'waveCharter: authoringRoot'),
  })
}

/** RSIAgent `_curriculum_continuation` (explore/phase1_wave.py:171-182): draft fixtures are kept. */
export function waveContinuation({ detail, authoringRoot } = {}) {
  return t('wave-continuation', {
    DETAIL: detailText(detail, 'the wave handoff could not be used'),
    AUTHORING_ROOT: path(authoringRoot, 'waveContinuation: authoringRoot'),
  })
}

/**
 * Phase-2 Curriculum charter (RSIAgent `self_evolving_curriculum_charter(phase2_outcome=True)`,
 * explore/charter.py:242-587: A = read_only, B = the `none` ablation diff, C = empty defaults;
 * dsh deepCharter + DEEP_DECISIONS). `history` may be a string or an array of lines.
 */
export function deepCharter({ target, history, latestOutcome, notes, memoryAccess = 'read_only', authoringRoot, memoryDir } = {}) {
  if (memoryAccess !== 'read_only' && memoryAccess !== 'none') {
    throw new PromptError(`deepCharter: memoryAccess must be "read_only" or "none" (got ${JSON.stringify(memoryAccess)})`)
  }
  const historyText = (Array.isArray(history) ? history.join('\n') : String(history ?? '')).trim()
  const latest = String(latestOutcome ?? '').trim()
  const none = memoryAccess === 'none'
  return sec('deep-charter', 'main', {
    TARGET: nonEmpty(target, 'deepCharter: target'),
    EVIDENCE_SENTENCE: none ? sec('deep-charter-memory-none', 'evidence') : sec('deep-charter', 'evidence-read-only'),
    HISTORY: historyText === '' ? sec('deep-charter-defaults', 'history') : historyText,
    LATEST_OUTCOME: latest === '' ? sec('deep-charter-defaults', 'latest') : latest,
    NOTES_BLOCK: notesBlock(notes),
    MEMORY_CONTRACT: none
      ? sec('deep-charter-memory-none', 'memory')
      : sec('deep-charter', 'memory-read-only', { MEMORY_DIR: path(memoryDir, 'deepCharter: memoryDir') }),
    AUTHORING_ROOT: path(authoringRoot, 'deepCharter: authoringRoot'),
  })
}

/** Deep decision transport (RSIAgent practice_loop.py:501; dsh curriculumTransportContinuation). */
export function curriculumContinuation({ detail } = {}) {
  return t('curriculum-continuation', { DETAIL: detailText(detail, 'the decision handoff could not be used') })
}

/**
 * Phase-1 Curriculum recovery notice; starts with a blank line. `contextLost` (the default, the
 * only cc-rsi use: a lost transcript restarted at a completed wave boundary in a NEW context)
 * says the earlier conversation is gone and points at the prior outcomes and notes;
 * `contextLost: false` is RSIAgent's completed-boundary notice for a context that persisted
 * (practice_loop.py:1355-1364).
 */
export function phase1RecoveryNotice({ contextLost = true } = {}) {
  return `\n\n${sec('phase1-recovery-notice', contextLost === false ? 'completed-boundary' : 'context-lost')}`
}

function changesJson(record) {
  const changes = {}
  for (const key of ['created', 'deleted', 'modified', 'unchanged']) {
    if (Array.isArray(record?.[key])) changes[key] = sortUtf8(record[key].map(String))
  }
  // RSIAgent phase1_wave.py:784-786: json.dumps(changes, ensure_ascii=False, indent=2, sort_keys=True).
  return JSON.stringify(changes, null, 2)
}

/**
 * The black-box outcome shown to the Curriculum: only the project, the verdict and the Verifier's
 * own evidence (RSIAgent practice_loop.py:1002-1017 `_outcome_text`), plus, in Phase 1, the MEMORY
 * CHANGES file names (phase1_wave.py:491-504, 782-803) and, in Phase 2, the Actor's learning
 * diagnosis (target_learning.py:152-160). Passing `diagnosis` (even null) selects the Phase-2
 * shape, which never lists memory files (RSIAgent's Phase-2 `_outcome_text` has none), so the
 * `memoryAccess: 'none'` ablation cannot learn the Actor's memory file names from it;
 * `memoryChanges` is ignored there. `label` (optional) names the project, e.g. "PROJECT 2.1 (csv-merge)".
 */
export function outcomeText(args = {}) {
  const { instruction, verdict, reports, memoryChanges, label } = args
  const phase2 = Object.prototype.hasOwnProperty.call(args, 'diagnosis')
  const list = (Array.isArray(reports) ? reports : []).map(r => String(r ?? '').trim())
  const blocks = phase2 && list.length === 1
    ? [sec('outcome', 'report-single', { REPORT: list[0] })]
    : list.map((report, i) => sec('outcome', 'report', { INDEX: i + 1, REPORT: report }))
  const vars = {
    LABEL: typeof label === 'string' && label.trim() !== '' ? label.trim() : (phase2 ? 'PRACTICE PROJECT' : 'PROJECT'),
    INSTRUCTION: nonEmpty(instruction, 'outcomeText: instruction'),
    VERDICT: verdictValue(verdict),
    REPORTS: blocks.length === 0 ? '' : `\n\n${blocks.join('\n\n')}`,
  }
  if (!phase2) {
    const changes = memoryChanges ? `\n\n${sec('outcome', 'memory-changes', { CHANGES: changesJson(memoryChanges) })}` : ''
    return sec('outcome', 'phase1', { ...vars, MEMORY_CHANGES: changes })
  }
  const diag = String(args.diagnosis ?? '').trim()
  return sec('outcome', 'phase2', { ...vars, DIAGNOSIS: diag === '' ? sec('outcome', 'no-diagnosis') : diag })
}

/** RSIAgent PREVIOUS_WAVE_OUTCOMES (phase1_wave.py:783-803): rationale + outcomes split by "---". */
export function waveOutcomes({ wave, rationale, outcomes } = {}) {
  if (!Number.isInteger(wave) || wave < 1) throw new PromptError('waveOutcomes: wave must be a positive integer')
  return t('wave-outcomes', {
    WAVE: wave,
    RATIONALE: nonEmpty(rationale, 'waveOutcomes: rationale'),
    OUTCOMES: (Array.isArray(outcomes) ? outcomes : []).map(o => String(o).trim()).join('\n\n---\n\n'),
  })
}

/**
 * The first latest-outcome after a target verdict (RSIAgent unified_evolution.py:485-499), with the
 * LIFECYCLE TRANSITION block when `lifecycle`.
 */
export function targetOutcomeText({ target, verdict, report, diagnosis, lifecycle = false } = {}) {
  const value = verdictValue(verdict)
  const diag = String(diagnosis ?? '').trim()
  return t('target-outcome', {
    TARGET: nonEmpty(target, 'targetOutcomeText: target'),
    REPORT: nonEmpty(report, 'targetOutcomeText: report'),
    LIFECYCLE: lifecycle ? `\n\n${t('lifecycle-transition', { VERDICT: value })}` : '',
    DIAGNOSIS: diag === '' ? sec('outcome', 'no-diagnosis') : diag,
  })
}

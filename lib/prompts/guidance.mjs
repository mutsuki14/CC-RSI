// Interactive MCP result texts (SPEC §8.2 guidance.mjs; WP5 calls these). Port of the dsh-rsi
// rsi_submit / rsi_learn / rsi_memory_commit results (src/index.ts:560-791) with the cc-rsi tool
// names (submit, wait_verdict, learn, memory_commit), the verdict header line of SPEC §8.3, the
// INFRASTRUCTURE wording of PF §4.2, and confirmation codes (PR §4.4).

import { PromptError, render, renderSection } from './render.mjs'
import {
  conflict, disagreement, distillation, leadsRequest, limitCondense, reconciliation, unverified,
} from './roles.mjs'

const sec = renderSection

function t(name, vars = {}) {
  const text = render(name, vars)
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

const MAX_LISTED_PATHS = 20

/** dsh index.ts:657-661: at most 20 paths, then ", …". */
function pathList(paths) {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ')
  return paths.length > MAX_LISTED_PATHS ? `${shown}, …` : shown
}

function note(value, section) {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  return value === true ? sec('guidance-harness-note', section) : null
}

function harnessNotes({ restored, displaced, detectOnly, staleDigestNote, tamperNote }) {
  const notes = []
  const changed = Array.isArray(restored) ? restored.map(String) : []
  if (changed.length > 0) {
    notes.push(sec('guidance-harness-note', detectOnly ? 'detect-only' : 'restored', { COUNT: changed.length, PATHS: pathList(changed) }))
  }
  const moved = Array.isArray(displaced) ? displaced.length : Number.isInteger(displaced) ? displaced : 0
  if (moved > 0) notes.push(sec('guidance-harness-note', 'displaced', { COUNT: moved }))
  const stale = note(staleDigestNote, 'stale')
  if (stale !== null) notes.push(stale)
  const tamper = note(tamperNote, 'tamper')
  if (tamper !== null) notes.push(tamper)
  return notes
}

/**
 * The `submit` / `wait_verdict` result for a delivered verdict. The first line is always
 * `cc-rsi · Verifier: VERDICT: <V> (generation <g>, isolation=<mode>, model=<m>)`, followed by the
 * Verifier's verbatim report inside RSIAgent's feedback wrapper (PASS: the report; FAIL:
 * `disagreement_message` + memory revisit; UNVERIFIED: `unverified_message` + the evidence-lead
 * request), learn hints in learn mode, and HARNESS NOTE lines.
 * `isolation` is the mode string or `{ mode, reason }`; `restored` lists the changed paths;
 * `displaced` is a list or a count; the two notes are `true` (standard text) or a string.
 */
export function guidanceVerdict({
  verdict, report, generation, isolation, model, memoryNonEmpty = false, memoryDir, mode = 'learn',
  restored, displaced, detectOnly = false, staleDigestNote, tamperNote,
} = {}) {
  const value = String(verdict ?? '').toUpperCase()
  if (!['PASS', 'FAIL', 'UNVERIFIED'].includes(value)) throw new PromptError(`guidanceVerdict: unknown verdict ${JSON.stringify(verdict)}`)
  if (!Number.isInteger(generation) || generation < 1) throw new PromptError('guidanceVerdict: generation must be a positive integer')
  if (typeof report !== 'string' || report.trim() === '') throw new PromptError('guidanceVerdict: report must be a non-empty string')
  const isolationMode = isolation && typeof isolation === 'object' ? isolation.mode : isolation
  const header = sec('guidance-pass', 'header', {
    VERDICT: value,
    GENERATION: generation,
    ISOLATION: typeof isolationMode === 'string' && isolationMode !== '' ? isolationMode : 'unknown',
    MODEL: typeof model === 'string' && model !== '' ? model : 'inherit',
  })
  const learning = mode !== 'frozen' && tamperNote !== true
  let body
  if (value === 'PASS') {
    body = sec('guidance-pass', 'pass', { REPORT: report.trim() })
    if (learning) body += `\n${sec('guidance-pass', 'learn')}`
  } else if (value === 'FAIL') {
    body = disagreement({ report, memoryDir, memoryNonEmpty, interactive: true })
    if (learning) body += `\n\n${t('guidance-fail-tail')}`
  } else {
    body = `${unverified({ report, memoryDir, memoryNonEmpty, interactive: true })}${leadsRequest({ interactive: true })}\n\n${t('guidance-unverified-tail')}`
  }
  return [header, body, ...harnessNotes({ restored, displaced, detectOnly, staleDigestNote, tamperNote })].join('\n\n')
}

/** The bounded-wait result while the job is still inspecting (the rewake hook matches its prefix). */
export function guidanceRunning({ jobId, generation, elapsedSec } = {}) {
  if (typeof jobId !== 'string' || jobId === '') throw new PromptError('guidanceRunning: jobId must be a non-empty string')
  if (!Number.isInteger(generation) || generation < 1) throw new PromptError('guidanceRunning: generation must be a positive integer')
  const elapsed = Number.isFinite(elapsedSec) ? Math.max(0, Math.round(elapsedSec)) : 0
  return t('guidance-running', { JOB_ID: jobId, GENERATION: generation, ELAPSED: elapsed })
}

/** Infra is never a verdict (SPEC §2 boundary 3): `INFRASTRUCTURE: … (<class>). This is not a verdict …`. */
export function guidanceInfra({ cls, detail, remedy } = {}) {
  if (typeof cls !== 'string' || cls === '') throw new PromptError('guidanceInfra: cls must be a non-empty string')
  let text = sec('guidance-infra', 'main', { CLS: cls })
  if (typeof remedy === 'string' && remedy.trim() !== '') text += ` ${remedy.trim()}`
  if (typeof detail === 'string' && detail.trim() !== '') text += `\n${sec('guidance-infra', 'detail', { DETAIL: detail.trim() })}`
  return text
}

export const REFUSAL_KINDS = Object.freeze([
  'not_attested', 'subagent', 'role', 'learning_open', 'frozen', 'sealed', 'no_terminal_verdict', 'stale_verdict',
  'already_learned', 'quarantined', 'tamper', 'bad_confirm', 'no_learning', 'unverified_not_learnable',
])

/**
 * A refusal text (`isError` results). `args` is accepted for forward compatibility: the refusal
 * texts carry no variables, so it is ignored.
 */
export function guidanceRefusal(kind, _args = {}) {
  if (!REFUSAL_KINDS.includes(kind)) throw new PromptError(`guidanceRefusal: unknown kind ${JSON.stringify(kind)}`)
  return sec('guidance-refusals', kind)
}

function codeLine(confirmCode) {
  return sec('guidance-commit', 'code', { CONFIRM_CODE: confirmCode })
}

/** The `learn` result: distillation for the interactive Actor plus its confirmation code line. */
export function guidanceLearnStart({ outcome, report, draftDir, limits, confirmCode } = {}) {
  const text = distillation({ outcome, report, memoryDir: draftDir, limits, owner: 'actor', confirmCode })
  return `${text}\n\n${codeLine(confirmCode)}`
}

export const COMMIT_KINDS = Object.freeze(['reconcile', 'promoted', 'already', 'limit', 'conflict', 'quarantined', 'frozen', 'abandoned'])

function names(list) {
  return Array.isArray(list) && list.length > 0 ? list.map(String).join(', ') : '-'
}

/**
 * The `memory_commit` result by outcome kind:
 *   reconcile  { draftDir, confirmCode }                      → reconciliation + code line
 *   promoted   { outcome, created, modified, deleted, treeAfter, files }
 *   limit      { detail, draftDir, confirmCode, limits? }     → condense + code line
 *   conflict   { prevDir, draftDir, confirmCode }             → conflict + code line
 *   already | quarantined | frozen | abandoned                → fixed texts
 */
export function guidanceCommitResult(kind, args = {}) {
  const a = args ?? {}
  switch (kind) {
    case 'reconcile':
      return `${reconciliation({ memoryDir: a.draftDir, owner: 'actor', confirmCode: a.confirmCode })}\n\n${codeLine(a.confirmCode)}`
    case 'limit':
      return `${limitCondense({ detail: a.detail, memoryDir: a.draftDir, owner: 'actor', confirmCode: a.confirmCode, limits: a.limits })}\n\n${codeLine(a.confirmCode)}`
    case 'conflict':
      return `${conflict({ prevDir: a.prevDir, draftDir: a.draftDir, owner: 'actor', confirmCode: a.confirmCode })}\n\n${codeLine(a.confirmCode)}`
    case 'promoted': {
      const outcome = String(a.outcome ?? '').toUpperCase()
      if (outcome !== 'PASS' && outcome !== 'FAIL') throw new PromptError('guidanceCommitResult: promoted needs outcome PASS or FAIL')
      const tree = typeof a.treeAfter === 'string' ? a.treeAfter.slice(0, 12) : ''
      if (tree === '') throw new PromptError('guidanceCommitResult: promoted needs treeAfter')
      if (!Number.isInteger(a.files) || a.files < 0) throw new PromptError('guidanceCommitResult: promoted needs a file count')
      return sec('guidance-commit', 'promoted', {
        OUTCOME: outcome, CREATED: names(a.created), MODIFIED: names(a.modified), DELETED: names(a.deleted), TREE: tree, FILES: a.files,
      })
    }
    case 'already':
    case 'quarantined':
    case 'frozen':
    case 'abandoned':
      return sec('guidance-commit', kind)
    default:
      throw new PromptError(`guidanceCommitResult: unknown kind ${JSON.stringify(kind)}`)
  }
}

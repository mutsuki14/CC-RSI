// Worklog synthesis for a stalled target attempt's fresh-context resume (SPEC §12.10; RSIAgent
// core/loop.py `_synthesize_worklog`, `_strategy_review`, `_fold_input`, `_digest_lines`;
// dsh-rsi resumeHandoffMessage/resumePivotMessage worklog).
//
// The messages are rebuilt from the stalled Actor context's own invocation logs (the harness
// message of each invocation, the Actor's text and tool calls, and the tool results), the last 60
// kept, each cut to its first 1500 + last 2500 characters. One summarizer call (a fresh,
// tool-less, non-persistent context) folds them into a WORK LOG; the strategy review is the same
// mechanism with RSIAgent's STRATEGY_REVIEW system. Infra or empty output falls back to the dsh
// digest of handoffs and Verifier reports, and never pauses the lineage.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonl } from '../core/jsonl.mjs'
import { safeName } from '../core/paths.mjs'
import { strategyReviewAsk, summarizerRequest } from '../prompts/roles.mjs'
import { InterruptedError, isInfraError } from '../runtime/errors.mjs'
import { EngineContext, specFor } from './roles.mjs'

const MAX_MESSAGES = 60
const TAIL_MESSAGES = 6
const TAIL_CHARS = 1500
const REVIEW_CAP = 2500

/** RSIAgent `_fold_input` (core/loop.py:71-77): head + tail with the middle elided. */
export function foldInput(content, head = 1500, tail = 2500) {
  const s = String(content ?? '')
  if (s.length <= head + tail) return s
  return `${s.slice(0, head)}\n…[trace middle elided]…\n${s.slice(-tail)}`
}

/**
 * dsh fallback work log: handoffs and Verifier reports joined by blank lines; when over `cap`
 * characters the NEWEST entries are kept at an entry boundary, with a truncation marker on top.
 */
export function digestWorklog(entries, cap = 12000) {
  const list = (Array.isArray(entries) ? entries : []).map(e => String(e ?? '').trim()).filter(e => e !== '')
  const joined = list.join('\n\n')
  if (joined.length <= cap) return joined
  const marker = '[… earlier work-log entries dropped at the character cap; the project root still holds ground truth]'
  const kept = []
  let size = marker.length
  for (let i = list.length - 1; i >= 0; i--) {
    const add = list[i].length + 2
    if (size + add > cap) {
      if (kept.length === 0) kept.unshift(list[i].slice(-(cap - marker.length - 2)))
      break
    }
    kept.unshift(list[i])
    size += add
  }
  return [marker, ...kept].join('\n\n')
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n')
  }
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

/**
 * Rebuilds `[{who: 'YOU'|'ENV', text}]` from a role context's invocation logs: each invocation's
 * harness message (prompt.md) and tool results are [ENV]; the role's own text and tool calls are
 * [YOU] (RSIAgent `'YOU' if role == 'assistant' else 'ENV'`).
 */
export async function messagesFromLogs(logDir) {
  let names = []
  try {
    names = (await readdir(logDir)).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    const dir = join(logDir, String(n))
    try {
      out.push({ who: 'ENV', text: await readFile(join(dir, 'prompt.md'), 'utf8') })
    } catch {
      // A missing prompt: the invocation never started.
    }
    for (const event of await readJsonl(join(dir, 'stream.jsonl'))) {
      if (!event || typeof event !== 'object' || event.parent_tool_use_id) continue
      const content = event.message?.content
      if (event.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') out.push({ who: 'YOU', text: block.text })
          else if (block?.type === 'tool_use') out.push({ who: 'YOU', text: `tool call ${block.name}: ${JSON.stringify(block.input ?? {})}` })
        }
      } else if (event.type === 'user' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') out.push({ who: 'ENV', text: `${block.is_error ? 'tool error' : 'tool result'}: ${textOfContent(block.content)}` })
        }
      }
    }
  }
  return out
}

function summarizerContext(j, key, run, { review }) {
  const layout = run.layout
  return new EngineContext(j, key, async (phase, { sandboxOff } = {}) => specFor({
    role: 'summarizer',
    phase: null,
    key,
    review,
    cwd: layout.summarizer,
    W: layout.W,
    home: run.home,
    pluginRoot: run.pluginRoot,
    config: run.config,
    model: run.models.summarizer ?? null,
    isolation: run.isolation,
    logDir: join(run.lineageDir, 'ctx', safeName(key)),
    env: run.env,
    sandboxOff,
  }), { model: run.models.summarizer ?? null, role: 'summarizer', run, trackCost: false })
}

/**
 * One summarizer-shaped call recorded as op `${K}` → `{text, fallback, costUsd}`; infra or empty
 * output → '' (the caller falls back to the digest). The cost is counted from the recorded result,
 * so a replay counts it too.
 */
async function summarize(j, K, run, { review, message }) {
  const r = await j.op(K, 'summarize', { review: review === true }, async () => {
    const ctx = summarizerContext(j, `${K}/ctx`, run, { review })
    try {
      await ctx.open()
      const reply = await ctx.send(`${K}/m1`, message)
      return { text: String(reply?.text ?? '').trim(), fallback: false, costUsd: Number.isFinite(reply?.costUsdDelta) ? reply.costUsdDelta : 0 }
    } catch (error) {
      if (error instanceof InterruptedError) throw error
      if (!isInfraError(error)) throw error
      run.logger?.warn?.('worklog synthesis fell back to the digest', { op: K, cls: error.cls, detail: error.detail })
      return { text: '', fallback: true, cls: error.cls, costUsd: 0 }
    }
  })
  run.addCost?.(r.costUsd)
  return r
}

/**
 * The messages of a stalled Actor context, read inside op `${K}/messages` (a filesystem observation
 * that steers the resume): `{ messages: last 60 folded, tail: last 6 cut to 1500 chars }`.
 */
export async function worklogMessages(j, K, { actorCtxLogDir } = {}) {
  return j.op(`${K}/messages`, 'worklog-messages', { logDir: actorCtxLogDir }, async () => {
    const all = await messagesFromLogs(actorCtxLogDir)
    return {
      messages: all.slice(-MAX_MESSAGES).map(m => ({ who: m.who, text: foldInput(m.text) })),
      tail: all.slice(-TAIL_MESSAGES).map(m => ({ who: m.who, text: String(m.text).slice(0, TAIL_CHARS) })),
    }
  })
}

/**
 * The work log handed to a fresh resumed Actor (SPEC §12.10): op `${K}/messages`, then one
 * summarizer call recorded as op `${K}/summarize`; an empty or failed synthesis (or
 * exploration.synthesizeWorklog off) is the digest fallback. Returns the work-log text.
 */
export async function synthesizeWorklog(j, K, { actorCtxLogDir, digest = [], config, run } = {}) {
  const enabled = (config ?? run.config)?.exploration?.synthesizeWorklog !== false
  let text = ''
  if (enabled) {
    const collected = await worklogMessages(j, K, { actorCtxLogDir })
    if (collected.messages.length > 0) {
      const r = await summarize(j, `${K}/summarize`, run, { review: false, message: summarizerRequest({ currentLog: '', messages: collected.messages }) })
      text = r.text
    }
  }
  return text === '' ? digestWorklog(digest) : text
}

/** One bounded strategy self-review over the stalled attempt's log and final turns (≤ 2500 chars). */
export async function strategyReview(j, K, { worklogText, tail = [], config, run } = {}) {
  if ((config ?? run.config)?.exploration?.synthesizeWorklog === false) return ''
  const r = await summarize(j, `${K}/summarize`, run, { review: true, message: strategyReviewAsk({ worklog: worklogText, tail }) })
  return String(r.text ?? '').slice(0, REVIEW_CAP).trim()
}

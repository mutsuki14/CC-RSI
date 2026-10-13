// Verbatim user-request capture and the Verifier's authoritative task (SPEC §11.8).
//
// RSIAgent hands the Verifier the immutable task instruction; the interactive extension uses the
// user's own recent messages, verbatim (dsh-rsi src/index.ts:540-548 `authoritativeTask`, labels
// `[user message i of n, latest]`). Synthetic turns (task notifications, cross-session messages,
// slash commands) are never requests (claude-code-experiments.md g7: UserPromptSubmit also fires
// for `<task-notification>` turns).

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { appendJsonl, readJsonl } from '../core/jsonl.mjs'

/** Prompt prefixes Claude Code uses for turns the user did not type (SPEC §11.8 `prompt` row). */
export const SYNTHETIC_PREFIXES = Object.freeze([
  '<task-notification>', '<cross-session-message', '<scheduled-task', '<local-command-', '<command-name>', '<command-message>',
])

const SLASH_COMMAND = /^\/[A-Za-z0-9_:.-]+(\s|$)/

/** Total characters of task messages forwarded to the Verifier (SPEC §11.8). */
export const TASK_MESSAGES_MAX_CHARS = 60000

/** Whether a UserPromptSubmit prompt is synthetic (not a user request). Empty prompts are synthetic. */
export function isSynthetic(prompt) {
  if (typeof prompt !== 'string') return true
  const text = prompt.trimStart()
  if (text === '') return true
  if (SYNTHETIC_PREFIXES.some(prefix => text.startsWith(prefix))) return true
  return SLASH_COMMAND.test(text)
}

function validRequest(record) {
  return record && typeof record === 'object' && Number.isInteger(record.seq) && record.seq > 0 && typeof record.text === 'string'
}

/** Every captured request `[{ seq, ts, promptId, text }]`, ascending by seq (torn lines skipped). */
export async function readRequests(sl) {
  const records = (await readJsonl(sl.requests)).filter(validRequest)
  return records.sort((a, b) => a.seq - b.seq)
}

const TAIL_BYTES = 256 * 1024

/**
 * The highest request seq recorded in `requests.jsonl` (0 when none). Reads only the file's tail
 * unless no complete record is found there.
 */
export async function lastRequestSeq(sl) {
  let fd
  try {
    fd = openSync(sl.requests, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 0
    throw error
  }
  try {
    const { size } = fstatSync(fd)
    if (size === 0) return 0
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    if (length < size) lines.shift() // the first line may be cut
    let max = 0
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (validRequest(record) && record.seq > max) max = record.seq
      } catch {
        // a torn line is not a record
      }
    }
    if (max > 0 || length === size) return max
  } finally {
    closeSync(fd)
  }
  const all = await readRequests(sl)
  return all.length > 0 ? all[all.length - 1].seq : 0
}

/**
 * Appends one verbatim request: `{seq, ts, promptId, text}` with seq = previous max + 1.
 * Callers serialize appends (the prompt hook appends under the session lock). Returns `{ seq }`.
 */
export async function appendRequest(sl, { promptId = null, text } = {}) {
  if (typeof text !== 'string') throw new TypeError('appendRequest: text must be a string')
  const seq = (await lastRequestSeq(sl)) + 1
  await appendJsonl(sl.requests, { seq, ts: new Date().toISOString(), promptId: typeof promptId === 'string' ? promptId : null, text })
  return { seq }
}

function marker(n) {
  return `[… ${n} chars truncated]`
}

/** Keeps the head of `text` within `budget` characters (marker included). */
function cut(text, budget) {
  if (text.length <= budget) return text
  let keep = Math.max(0, budget - marker(text.length).length - 1)
  // Never split a surrogate pair.
  if (keep > 0 && /[\uD800-\uDBFF]/.test(text[keep - 1])) keep--
  return keep === 0 ? marker(text.length) : `${text.slice(0, keep)}\n${marker(text.length - keep)}`
}

/**
 * The Verifier's task messages (SPEC §11.8): the last `n` requests with `seq >= firstRequestSeq`
 * (`current: true`); when fewer than `n` exist, the preceding requests fill up to `n`
 * (`current: false`, rendered as "[earlier context, before this task began]"). Oldest first. The
 * total stays within 60000 characters: older messages are cut first, each cut ending with an
 * explicit "[… N chars truncated]" marker.
 */
export function taskMessagesFor(requests, firstRequestSeq, n) {
  const list = (Array.isArray(requests) ? requests : []).filter(validRequest).sort((a, b) => a.seq - b.seq)
  const count = Number.isInteger(n) && n > 0 ? n : 3
  const first = Number.isInteger(firstRequestSeq) ? firstRequestSeq : 1
  const current = list.filter(r => r.seq >= first).slice(-count)
  const earlier = current.length < count ? list.filter(r => r.seq < first).slice(-(count - current.length)) : []
  const chosen = [
    ...earlier.map(r => ({ seq: r.seq, text: r.text, current: false })),
    ...current.map(r => ({ seq: r.seq, text: r.text, current: true })),
  ]
  // Newest first gets the budget: the latest request is the one the candidate must satisfy.
  let remaining = TASK_MESSAGES_MAX_CHARS
  for (let i = chosen.length - 1; i >= 0; i--) {
    const text = chosen[i].text
    const kept = remaining <= 0 ? marker(text.length) : cut(text, remaining)
    chosen[i].text = kept
    remaining -= kept.length
  }
  return chosen
}

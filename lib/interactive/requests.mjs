// Verbatim user-request capture and the Verifier's authoritative task (SPEC §11.8).
//
// RSIAgent hands the Verifier the immutable task instruction; the interactive extension uses the
// user's own recent messages, verbatim (dsh-rsi src/index.ts:540-548 `authoritativeTask`, labels
// `[user message i of n, latest]`). Synthetic turns (task notifications, cross-session messages,
// slash commands) are never requests (claude-code-experiments.md g7: UserPromptSubmit also fires
// for `<task-notification>` turns).
//
// Claude Code 2.1.296 names who authored a prompt in the UserPromptSubmit `source` field: `user`
// (the interactive composer) and `sdk` (`-p` / Agent SDK) are the user; `system` (peer/channel
// messages, task notifications, auto-continuation), `loop_wakeup` (/loop), `schedule_wakeup`
// (CronCreate/routines) and `poll_event` are machine-injected. A prompt the model scheduled for
// itself must never become the Verifier's authoritative task (security-1): when the field is
// present it is trusted (only `user`/`sdk` count); without it, Claude Code's exact machine wrappers
// and the scheduled-prompt ledger decide. The ledger holds the prompts of this session's successful
// CronCreate/ScheduleWakeup/RemoteTrigger calls (PostToolUse), by digest; a one-shot entry is
// consumed when it fires, and entries of deleted or expired crons are dropped (r2-overblock-3, -5).
// A task list (the Stop payload's `session_crons`, which holds only in-memory session tasks, or
// `<project>/.claude/scheduled_tasks.json` for durable ones) expires an entry only after it once
// listed it: a task no list shows can still fire, so its entry lives until CronDelete or the TTL
// (r3-guard-hooks-1).

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { appendJsonl, readJsonl } from '../core/jsonl.mjs'

/**
 * Prompt prefixes of turns Claude Code generates itself (SPEC §11.8 `prompt` row): synthetic
 * whatever the payload `source` says (a user does not start a request with these exact tags).
 */
export const SYNTHETIC_PREFIXES = Object.freeze([
  '<task-notification>', '<cross-session-message', '<scheduled-task', '<local-command-', '<command-name>', '<command-message>',
])

/**
 * Machine wrappers recognized only when the payload carries no `source` (2.1.296), and only in their
 * full shape, so a user prompt that starts with `<channel>` (RSS) or mentions such a tag is still a
 * request (r2-overblock-5): teammate messages, channel events, /loop sentinels.
 */
export const MACHINE_WRAPPERS = Object.freeze([
  /^<teammate-message\s+teammate_id="[^"]+"[^>]*>[\s\S]*<\/teammate-message>\s*$/,
  /^<channel\s+source="[^"]*"[^>]*>[\s\S]*<\/channel>\s*$/,
  /^<<autonomous-loop(-dynamic)?>>[ \t]*(\r?\n|$)/,
])

/** UserPromptSubmit `source` values of prompts the user authored (anything else is machine-injected). */
export const USER_SOURCES = Object.freeze(['user', 'sdk'])

/** Tools whose `prompt` input is later submitted to this session as a turn (the scheduled-prompt ledger). */
export const SCHEDULE_TOOLS = Object.freeze(['CronCreate', 'ScheduleWakeup', 'RemoteTrigger'])

const SLASH_COMMAND = /^\/[A-Za-z0-9_:.-]+(\s|$)/

/** Total characters of task messages forwarded to the Verifier (SPEC §11.8). */
export const TASK_MESSAGES_MAX_CHARS = 60000

/**
 * Whether a UserPromptSubmit prompt is synthetic (not a user request). Empty prompts are synthetic.
 * `source` is the payload's `source` field: when present it is trusted (only `user` and `sdk` can be
 * requests, and of those only Claude Code's own command wrappers and slash commands are not);
 * without it, the full machine wrappers count too.
 */
export function isSynthetic(prompt, { source } = {}) {
  if (typeof prompt !== 'string') return true
  const sourced = typeof source === 'string' && source !== ''
  if (sourced && !USER_SOURCES.includes(source)) return true
  const text = prompt.trimStart()
  if (text === '') return true
  if (SYNTHETIC_PREFIXES.some(prefix => text.startsWith(prefix))) return true
  if (!sourced && MACHINE_WRAPPERS.some(re => re.test(text))) return true
  return SLASH_COMMAND.test(text)
}

/** `<session dir>/scheduled.jsonl`: the ledger of prompts this session scheduled for itself. */
export function scheduledLedgerPath(sl) {
  return join(sl.dir, 'scheduled.jsonl')
}

/** sha256 of a prompt as the ledger keys it (surrounding whitespace ignored). */
export function promptDigest(text) {
  return createHash('sha256').update(String(text).trim(), 'utf8').digest('hex')
}

// The Stop payload lists scheduled prompts cut at 1000 characters with a "… [+N chars]" marker, so
// long prompts are matched by the digest of their head.
const HEAD_CHARS = 900
const CUT_MARKER = /… \[\+\d+ chars\]$/
/** Claude Code deletes recurring tasks 7 days after creation; one day more covers a final late run. */
export const LEDGER_TTL_MS = 8 * 24 * 3600 * 1000

function headDigest(text) {
  return createHash('sha256').update(String(text).trim().slice(0, HEAD_CHARS), 'utf8').digest('hex')
}

/**
 * Records a prompt a successful scheduling tool call (SCHEDULE_TOOLS, at PostToolUse) will submit
 * later: `{ kind: 'scheduled', key, tool, sha256, headSha, recurring, durable, cronId }`. An entry
 * whose `recurring` is false is consumed by its first match; a `durable` one (a CronCreate task kept
 * in `.claude/scheduled_tasks.json`) is judged against that file, never against `session_crons`.
 */
export async function recordScheduledPrompt(sl, { tool, prompt, recurring = null, durable = false, cronId = null } = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return false
  await appendJsonl(scheduledLedgerPath(sl), {
    v: 2,
    kind: 'scheduled',
    key: randomBytes(8).toString('hex'),
    ts: new Date().toISOString(),
    tool: typeof tool === 'string' ? tool : null,
    sha256: promptDigest(prompt),
    headSha: headDigest(prompt),
    recurring: typeof recurring === 'boolean' ? recurring : null,
    durable: durable === true,
    cronId: typeof cronId === 'string' && cronId !== '' ? cronId : null,
  })
  return true
}

/**
 * The live ledger entries: scheduled, neither consumed nor expired, and younger than LEDGER_TTL_MS;
 * `listed` is true once a task list showed the entry's task. Records written before the ledger had
 * kinds count as recurring entries.
 */
export async function scheduledEntries(sl, { now = Date.now() } = {}) {
  const records = await readJsonl(scheduledLedgerPath(sl)).catch(() => [])
  const live = new Map()
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    if (r.kind === 'consumed' || r.kind === 'expired') {
      for (const key of Array.isArray(r.keys) ? r.keys : []) live.delete(key)
      continue
    }
    if (r.kind === 'listed') {
      for (const key of Array.isArray(r.keys) ? r.keys : []) if (live.has(key)) live.get(key).listed = true
      continue
    }
    if (typeof r.sha256 !== 'string') continue
    const key = typeof r.key === 'string' ? r.key : `legacy:${r.ts}:${r.sha256}`
    live.set(key, { ...r, key, listed: false })
  }
  return [...live.values()].filter(e => !(Date.parse(e.ts ?? '') < now - LEDGER_TTL_MS))
}

/** Whether `prompt` matches a live ledger entry (without consuming it). */
export async function isScheduledPrompt(sl, prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return false
  const digest = promptDigest(prompt)
  return (await scheduledEntries(sl)).some(e => e.sha256 === digest)
}

/**
 * The live ledger entry `prompt` matches, or null. A one-shot entry (ScheduleWakeup, a non-recurring
 * CronCreate, RemoteTrigger) is consumed: the same text typed later is a request again.
 */
export async function takeScheduledPrompt(sl, prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return null
  const digest = promptDigest(prompt)
  const entries = (await scheduledEntries(sl)).filter(e => e.sha256 === digest)
  if (entries.length === 0) return null
  const recurring = entries.find(e => e.recurring !== false)
  if (recurring) return recurring
  await appendJsonl(scheduledLedgerPath(sl), { v: 2, kind: 'consumed', ts: new Date().toISOString(), keys: [entries[0].key] })
  return entries[0]
}

/** A matcher for the entries a task list (`[{ id, prompt }]`; prompts may be cut) shows. */
function listMatcher(tasks) {
  const full = new Set()
  const heads = new Set()
  const ids = new Set()
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    if (typeof task.id === 'string') ids.add(task.id)
    if (typeof task.prompt !== 'string') continue
    const cut = CUT_MARKER.test(task.prompt)
    const text = task.prompt.replace(CUT_MARKER, '')
    if (!cut) full.add(promptDigest(text))
    heads.add(headDigest(text))
  }
  return e => full.has(e.sha256) || (typeof e.headSha === 'string' && heads.has(e.headSha)) || (typeof e.cronId === 'string' && ids.has(e.cronId))
}

/**
 * Drops ledger entries that can no longer fire: those of a deleted cron (`cronId`, CronDelete) and
 * those a task list showed earlier and no longer shows. `active` is the Stop payload's
 * `session_crons` (in-memory session tasks, wakeups included) and judges non-durable entries;
 * `durableActive` is the task list of `.claude/scheduled_tasks.json` (null when it could not be
 * read) and judges durable ones. An entry its list never showed is not expired by it: its task can
 * still fire (r3-guard-hooks-1). Entries a list shows for the first time are marked `listed`.
 * Returns the number of entries dropped.
 */
export async function expireScheduled(sl, { cronId = null, active = null, durableActive = null } = {}) {
  const entries = await scheduledEntries(sl)
  if (entries.length === 0) return 0
  const gone = new Set()
  if (typeof cronId === 'string' && cronId !== '') for (const e of entries) if (e.cronId === cronId) gone.add(e)
  const sessionShows = Array.isArray(active) ? listMatcher(active) : null
  const fileShows = Array.isArray(durableActive) ? listMatcher(durableActive) : null
  const listed = []
  for (const e of entries) {
    if (gone.has(e)) continue
    const shows = e.durable === true ? fileShows : sessionShows
    if (!shows) continue
    if (shows(e)) {
      if (!e.listed) listed.push(e.key)
    } else if (e.listed) {
      gone.add(e)
    }
  }
  if (listed.length > 0) await appendJsonl(scheduledLedgerPath(sl), { v: 2, kind: 'listed', ts: new Date().toISOString(), keys: listed })
  if (gone.size === 0) return 0
  await appendJsonl(scheduledLedgerPath(sl), { v: 2, kind: 'expired', ts: new Date().toISOString(), keys: [...gone].map(e => e.key) })
  return gone.size
}

function validRequest(record) {
  return record && typeof record === 'object' && Number.isInteger(record.seq) && record.seq > 0 && typeof record.text === 'string'
}

/** Every captured request `[{ seq, ts, promptId, source, text }]`, ascending by seq (torn lines skipped). */
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
 * Appends one verbatim request: `{seq, ts, promptId, source, text}` with seq = previous max + 1
 * (`source` is the payload's `source` field, or null). Callers serialize appends (the prompt hook
 * appends under the session lock). Returns `{ seq }`.
 */
export async function appendRequest(sl, { promptId = null, source = null, text } = {}) {
  if (typeof text !== 'string') throw new TypeError('appendRequest: text must be a string')
  const seq = (await lastRequestSeq(sl)) + 1
  await appendJsonl(sl.requests, {
    seq, ts: new Date().toISOString(), promptId: typeof promptId === 'string' ? promptId : null, source: typeof source === 'string' ? source : null, text,
  })
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

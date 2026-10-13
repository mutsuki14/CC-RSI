// Identifiers (SPEC §5.3). Timestamps embedded in ids are UTC, like every cc-rsi timestamp (§0).

import { randomBytes, randomUUID } from 'node:crypto'

/** Lineage and other user-visible ids: lowercase, digits, '_' and '-', 1–64 chars. */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** A random RFC 4122 v4 uuid (role session ids). */
export function uuid() {
  return randomUUID()
}

/** `YYYYMMDDhhmmss` in UTC. */
export function compactStamp(now = new Date()) {
  const p2 = n => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}`
    + `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}`
}

/** Verification job id: `j-YYYYMMDDhhmmss-` + 6 lowercase hex. */
export function newJobId(now = new Date()) {
  return `j-${compactStamp(now)}-${randomBytes(3).toString('hex')}`
}

/** Default lineage id: `${phase}-YYYYMMDDhhmmss`. */
export function defaultLineageId(phase, now = new Date()) {
  return `${phase}-${compactStamp(now)}`
}

/** Sealed evaluation run id: `r-YYYYMMDDhhmmss` (SPEC §13.4 step 4). */
export function newRunId(now = new Date()) {
  return `r-${compactStamp(now)}`
}

/** Whether `id` is a valid lineage/user id (ID_RE). */
export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

/** A 6-character lowercase hex confirmation code (interactive learning steps). */
export function confirmCode() {
  return randomBytes(3).toString('hex')
}

/** Zero-pads a counter to at least 3 digits (`w001`, `t002`). */
export function pad3(n) {
  return String(n).padStart(3, '0')
}

/** Episode id of an interactive task inspection: `task-${sid.slice(0,8)}-${taskSeq}-g${gen}`. */
export function interactiveEpisode(sid, taskSeq, gen) {
  return `task-${String(sid).slice(0, 8)}-${taskSeq}-g${gen}`
}

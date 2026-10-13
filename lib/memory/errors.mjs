// MemoryError family (SPEC §6.3). Messages follow dsh-rsi src/memory/store.ts:54-78; the
// quarantine message is deliberately neutral (RSIAgent silent audit: the reason never reaches
// an agent).

import { CcRsiError } from '../core/errors.mjs'

export class MemoryError extends CcRsiError {}

/** The store is frozen (Phase-3 reuse): drafts can be neither opened nor committed. */
export class MemoryFrozenError extends MemoryError {
  constructor(details = {}) {
    super('memory_frozen', 'memory is frozen: test-time reuse never updates durable memory', details)
  }
}

/** A sealed evaluation has run; learning stays closed until `cc-rsi memory unfreeze --after-sealed`. */
export class MemorySealedError extends MemoryError {
  constructor(details = {}) {
    super('memory_sealed', 'memory is sealed: a sealed evaluation has used it, so learning is closed '
      + '(a human can reopen it with "cc-rsi memory unfreeze --after-sealed")', details)
  }
}

/** The draft's base is no longer canonical (dsh MemoryConflictError). */
export class MemoryConflictError extends MemoryError {
  constructor({ baseHash, currentHash, episode } = {}) {
    super('memory_conflict', 'durable memory changed after this draft was opened; reopen the learning phase against the current memory',
      { baseHash, currentHash, episode })
    this.baseHash = baseHash
    this.currentHash = currentHash
  }
}

/** The draft exceeds the memory limits; `detail` is human text such as "412 files > 400; 'notes/big.md' 70211 bytes > 65536". */
export class MemoryLimitError extends MemoryError {
  constructor({ detail, episode } = {}) {
    super('memory_limit', `memory exceeds its limits: ${detail}`, { detail, episode })
    this.detail = detail
  }
}

/** The silent audit refused the learning phase. The message never carries the reason. */
export class MemoryQuarantineError extends MemoryError {
  constructor(details = {}) {
    super('memory_quarantined', 'this learning phase could not be promoted; durable memory is unchanged', details)
  }
}

/** Canonical memory changed outside a commit (SPEC §6.6). */
export class MemoryTamperError extends MemoryError {
  constructor({ expected, actual } = {}) {
    super('memory_tamper', `canonical memory changed outside a commit (expected tree ${expected}, found ${actual}); `
      + 'a human can accept it with "cc-rsi memory verify --accept-external" or roll back with "cc-rsi memory restore <N>"',
    { expected, actual })
    this.expected = expected
    this.actual = actual
  }
}

/** The frozen tree no longer matches its recorded digest. */
export class MemoryFrozenTamperError extends MemoryError {
  constructor({ expected, actual } = {}) {
    super('memory_frozen_tamper', `frozen memory was mutated (expected ${expected}, found ${actual})`, { expected, actual })
    this.expected = expected
    this.actual = actual
  }
}

/** No draft is open for the episode. */
export class MemoryDraftMissingError extends MemoryError {
  constructor({ episode } = {}) {
    super('memory_draft_missing', `no memory draft is open for episode ${episode}`, { episode })
    this.episode = episode
  }
}

/** An unsafe name (or a symlink / special file) in a memory tree. */
export class UnsafeMemoryPathError extends MemoryError {
  constructor({ path, reason } = {}) {
    super('unsafe_memory_path', `unsafe memory path${reason ? ` (${reason})` : ''}: ${JSON.stringify(path)}`, { path, reason })
    this.path = path
  }
}

/** Not canonical JSON data / an invalid tree-hash mapping (RSIAgent memory_hash.py MemoryStateError). */
export class MemoryStateError extends MemoryError {
  constructor(message = 'invalid memory state', details = {}) {
    super('memory_state', message, details)
  }
}

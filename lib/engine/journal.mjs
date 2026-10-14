// Memoized op journal (SPEC §12.1; proposal-robust §5.2, with the J2-5 determinism rule).
//
// The engine is straight-line async code ported from dsh-rsi src/engine/lineage.ts. Every side
// effect and every filesystem or store observation that steers control flow runs inside
// `j.op(key, kind, args, fn)`:
//  - a key with a `done` record returns the recorded result (after checking kind and argsSha);
//  - a key with only a `start` record re-runs `fn` in recovering mode;
//  - an unknown key appends `start`, runs `fn`, appends `done`.
// Resuming after a crash, a stop or an infra pause therefore runs the same code path as the
// first run, and the engine branches only on recorded results. dsh-rsi lineages were not
// resumable at all (dsh gap 6); RSIAgent resumes with operator-authored recovery plans.
//
// ops.jsonl records (fsync per line, torn-tail tolerant):
//   {seq, key, kind, argsSha, shapeSha?, status:'start'|'done', ts, result?, blob?}
//   {seq, key, kind:'override', status:'override', ts, data}          (written only by `explore resume`)
// Results larger than 4 KiB live in blobs/<sha256>.json and the record carries the blob id.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ensureDir, writeFileAtomic } from '../core/atomic.mjs'
import { canonicalJson, sha256Hex } from '../core/digest.mjs'
import { appendJsonl, readJsonl } from '../core/jsonl.mjs'
import { InfraError } from '../runtime/errors.mjs'

/** Results whose JSON exceeds this many characters are stored as blobs (SPEC §12.1). */
export const BLOB_THRESHOLD = 4096

/** The key of a DRIFT_ACCEPTED record (`drift:<n>`): replay tolerates drifted records older than it (r2-engine-2). */
const DRIFT_KEY = /^drift:\d+$/

/**
 * The journal no longer matches the code path being replayed (a recorded op with a different
 * kind or arguments). Infra: the lineage pauses instead of guessing (SPEC §12.1).
 */
export class ReplayDivergence extends InfraError {
  constructor(detail, extra = {}) {
    super('replay_divergence', detail, extra)
  }
}

/** JSON round trip, so a first-run result and its replay are the same value (undefined → null). */
function plain(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

/**
 * Parses a fault specification for crash testing: `{ atSeq, mode: 'throw'|'kill', when: 'before'|'after' }`
 * or the string form `"<seq>:<throw|kill>[:after]"` (the daemon reads it from CC_RSI_ENGINE_FAULT;
 * createLineage strips every CC_RSI_* variable, so normal launches never carry one).
 */
export function parseFault(value) {
  if (!value) return null
  if (typeof value === 'object') {
    const atSeq = Number(value.atSeq)
    if (!Number.isInteger(atSeq) || atSeq < 1) return null
    return { atSeq, mode: value.mode === 'kill' ? 'kill' : 'throw', when: value.when === 'after' ? 'after' : 'before' }
  }
  const m = /^(\d+):(throw|kill)(?::(before|after))?$/.exec(String(value).trim())
  if (!m) return null
  return { atSeq: Number(m[1]), mode: m[2], when: m[3] ?? 'before' }
}

/** Kills this process and its process group at once (crash-matrix SIGKILL; never used in-process). */
function killSelf() {
  try {
    process.kill(-process.pid, 'SIGKILL')
  } catch {
    // Not a process-group leader.
  }
  process.kill(process.pid, 'SIGKILL')
}

export class OpJournal {
  #dir
  #path
  #blobs
  #events
  #lineage
  #starts = new Map()
  #dones = new Map()
  #overrides = new Map()
  #order = []
  #seq = 0
  #chain = Promise.resolve()
  #running = new Set()
  #blobCache = new Map()
  #fault = null
  #onEvent = null
  #fence = null
  /** The seq of the last DRIFT_ACCEPTED op record (`drift:<n>`, written by `explore resume --accept-drift`), or 0. */
  #driftSeq = 0

  /**
   * Opens `<lineageDir>/ops.jsonl` (torn-tail tolerant) and builds the index.
   * Options (cc-rsi additions): `lineage` (id written into events; default the dir name),
   * `fault` (crash testing, see parseFault), `onEvent(event)` (called after each protocol event).
   */
  static async open(lineageDir, options = {}) {
    const journal = new OpJournal(lineageDir, options)
    await journal.#load()
    return journal
  }

  constructor(lineageDir, { lineage, fault, onEvent, fence } = {}) {
    this.#dir = lineageDir
    this.#path = join(lineageDir, 'ops.jsonl')
    this.#blobs = join(lineageDir, 'blobs')
    this.#events = join(lineageDir, 'events.jsonl')
    this.#lineage = typeof lineage === 'string' && lineage !== '' ? lineage : basename(lineageDir)
    this.#fault = parseFault(fault)
    this.#onEvent = typeof onEvent === 'function' ? onEvent : null
    this.#fence = typeof fence === 'function' ? fence : null
  }

  async #load() {
    await ensureDir(this.#dir)
    for (const record of await readJsonl(this.#path)) {
      if (!record || typeof record !== 'object' || typeof record.key !== 'string') continue
      if (Number.isInteger(record.seq) && record.seq > this.#seq) this.#seq = record.seq
      if (DRIFT_KEY.test(record.key) && Number.isInteger(record.seq) && record.seq > this.#driftSeq) this.#driftSeq = record.seq
      if (record.status === 'start') {
        if (!this.#starts.has(record.key) && !this.#dones.has(record.key)) this.#order.push(record.key)
        if (!this.#starts.has(record.key)) this.#starts.set(record.key, record)
      } else if (record.status === 'done') {
        if (!this.#starts.has(record.key) && !this.#dones.has(record.key)) this.#order.push(record.key)
        if (!this.#dones.has(record.key)) this.#dones.set(record.key, record)
      } else if (record.status === 'override') {
        if (!this.#overrides.has(record.key)) this.#overrides.set(record.key, record.data ?? {})
      }
    }
  }

  /** The lineage directory. */
  get dir() {
    return this.#dir
  }

  /** The highest record seq written so far. */
  get seq() {
    return this.#seq
  }

  /** Number of op keys with a record (start or done). */
  get size() {
    return this.#order.length
  }

  isDone(key) {
    return this.#dones.has(key)
  }

  hasStart(key) {
    return this.#starts.has(key) || this.#dones.has(key)
  }

  /** The recorded result of a done op (undefined when not done). Blob results are read and re-hashed. */
  result(key) {
    const record = this.#dones.get(key)
    if (!record) return undefined
    if (typeof record.blob === 'string' && record.blob !== '') return this.#readBlob(record.blob, key)
    return record.result === undefined ? null : plain(record.result)
  }

  #readBlob(id, key) {
    if (this.#blobCache.has(id)) return plain(this.#blobCache.get(id))
    let text
    try {
      text = readFileSync(join(this.#blobs, `${id}.json`), 'utf8')
    } catch (error) {
      throw new InfraError('journal_corrupt', `the recorded result of op ${key} (blob ${id}) is missing: ${error?.code ?? error}`, { opKey: key })
    }
    if (sha256Hex(text) !== id) throw new InfraError('journal_corrupt', `the recorded result of op ${key} (blob ${id}) was altered`, { opKey: key })
    const value = JSON.parse(text)
    this.#blobCache.set(id, value)
    return plain(value)
  }

  /** Every op key that starts with `prefix` and has a record, in first-seen order. */
  keysWithPrefix(prefix) {
    return this.#order.filter(key => key.startsWith(prefix))
  }

  hasOverride(key) {
    return this.#overrides.has(key)
  }

  /** Records an operator override for `key` (used only by `explore resume`). Idempotent. */
  async addOverride(key, data = {}) {
    if (this.#overrides.has(key)) return
    this.#overrides.set(key, plain(data) ?? {})
    await this.#append({ key, kind: 'override', status: 'override', data: plain(data) ?? {} })
  }

  /** Serialized, fsync'd append with the crash-test fault hook. */
  #append(fields) {
    const run = this.#chain.then(async () => {
      const seq = this.#seq + 1
      const fault = this.#fault
      if (fault && fault.atSeq === seq && fault.when === 'before') {
        this.#fault = null
        if (fault.mode === 'kill') {
          killSelf()
          await new Promise(() => {})
        }
        throw new Error(`injected fault before op record ${seq}`)
      }
      // Fencing (memory-crash-9): an engine whose lease was taken over never appends again.
      if (this.#fence) await this.#fence()
      const record = { seq, ...fields, ts: new Date().toISOString() }
      await appendJsonl(this.#path, record)
      this.#seq = seq
      // A drift record written by this instance (the engine-start backfill) takes effect at once.
      if (DRIFT_KEY.test(fields.key)) this.#driftSeq = seq
      if (fault && fault.atSeq === seq && fault.when === 'after') {
        this.#fault = null
        if (fault.mode === 'kill') {
          killSelf()
          await new Promise(() => {})
        }
        throw new Error(`injected fault after op record ${seq}`)
      }
      return record
    })
    this.#chain = run.catch(() => undefined)
    return run
  }

  /**
   * Runs `fn({ recovering, key })` at most once to completion for `key` (SPEC §12.1 `op`):
   * a done key returns its recorded result (ReplayDivergence when kind or argsSha differ); a
   * started key re-runs `fn` with `recovering: true`; a new key records start, runs `fn`, records
   * done. A throwing `fn` leaves no done record; an InfraError without an op key gets this key.
   * The result must be JSON data; the returned value is its JSON round trip.
   *
   * `tolerate` (r2-engine-2): `{ shapeSha, onDrift(info) }` for ops whose arguments hold text the
   * plugin renders (a send's message digest). A record written before the last accepted drift with
   * the same kind and shape (`shapeSha`, or a record from before shapes were kept) but other
   * arguments is not a divergence: the plugin's templates changed, not the code path. A done record
   * returns its recorded result; a started one re-runs `fn` (recovering) with the new arguments.
   * `onDrift` is told either way.
   */
  async op(key, kind, args, fn, { tolerate } = {}) {
    if (typeof key !== 'string' || key === '') throw new TypeError('OpJournal.op: key must be a non-empty string')
    const argsSha = sha256Hex(canonicalJson(args ?? null))
    const shapeSha = typeof tolerate?.shapeSha === 'string' ? tolerate.shapeSha : null
    const drifted = record => shapeSha !== null && record.kind === kind && Number.isInteger(record.seq) && record.seq < this.#driftSeq
      && (record.shapeSha === undefined || record.shapeSha === shapeSha)
    const tellDrift = (record, status) => {
      try { tolerate?.onDrift?.({ key, kind, status, recordedArgsSha: record.argsSha, argsSha }) } catch { /* reporting only */ }
    }
    const done = this.#dones.get(key)
    if (done) {
      if (done.kind !== kind || done.argsSha !== argsSha) {
        if (drifted(done)) {
          tellDrift(done, 'done')
          return this.result(key)
        }
        throw new ReplayDivergence(`op ${key} was recorded as ${done.kind} with other arguments than the replayed ${kind}`, {
          opKey: key, recordedKind: done.kind, kind,
        })
      }
      return this.result(key)
    }
    if (this.#running.has(key)) throw new Error(`OpJournal: op ${key} is already running (keys must never run concurrently)`)
    this.#running.add(key)
    try {
      const started = this.#starts.get(key)
      if (started && (started.kind !== kind || started.argsSha !== argsSha)) {
        if (!drifted(started)) {
          throw new ReplayDivergence(`op ${key} was started as ${started.kind} with other arguments than the replayed ${kind}`, {
            opKey: key, recordedKind: started.kind, kind,
          })
        }
        tellDrift(started, 'start')
      }
      const recovering = started !== undefined
      if (!recovering) {
        const record = await this.#append({ key, kind, argsSha, status: 'start', ...(shapeSha !== null ? { shapeSha } : {}) })
        this.#starts.set(key, record)
        this.#order.push(key)
      }
      let value
      try {
        value = plain(await fn({ recovering, key }))
      } catch (error) {
        if (error instanceof InfraError && error.extra && error.extra.opKey === undefined) error.extra.opKey = key
        throw error
      }
      const json = JSON.stringify(value)
      const fields = { key, kind, argsSha, status: 'done', ...(shapeSha !== null ? { shapeSha } : {}) }
      if (json.length > BLOB_THRESHOLD) {
        const id = sha256Hex(json)
        await writeFileAtomic(join(this.#blobs, `${id}.json`), json)
        this.#blobCache.set(id, value)
        fields.blob = id
      } else {
        fields.result = value
      }
      const record = await this.#append(fields)
      this.#dones.set(key, record)
      return plain(value)
    } finally {
      this.#running.delete(key)
    }
  }

  /**
   * A protocol event, written at most once per key (SPEC §12.1 rule 6):
   * `op(key, 'event', {type}, () => append {ts, type, lineage, ...data, op: key})`. A recovering
   * event op first checks events.jsonl, so a crash between the append and the done record never
   * duplicates the event.
   */
  async event(key, type, data = {}) {
    return this.op(key, 'event', { type }, async ({ recovering }) => {
      if (recovering) {
        const prior = (await readJsonl(this.#events)).find(e => e && e.op === key)
        if (prior) return { type }
      }
      const event = { ts: new Date().toISOString(), type, lineage: this.#lineage, ...plain(data), op: key }
      await appendJsonl(this.#events, event)
      if (this.#onEvent) {
        try {
          await this.#onEvent(event)
        } catch {
          // State bookkeeping never fails a protocol event.
        }
      }
      return { type }
    })
  }

  /** Waits for pending appends. */
  async flush() {
    await this.#chain
  }
}

// File logger (SPEC §5.3): synchronous JSONL appends, never throws, never writes stdout
// (stdout belongs to hook JSON and MCP JSON-RPC).

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function serializable(data) {
  if (data instanceof Error) return { name: data.name, message: data.message, code: data.code, stack: data.stack }
  return data
}

/**
 * Returns `{ info, warn, error }`, each `(msg, data?)`, appending
 * `{ts, level, component, pid, msg, data?}` lines to `file`. A falsy `file` gives a no-op
 * logger. Failures (unwritable file, unserializable data) are swallowed.
 */
export function createLogger(file, component) {
  let dirReady = false
  const write = (level, msg, data) => {
    if (!file) return
    try {
      const record = { ts: new Date().toISOString(), level, component, pid: process.pid, msg: String(msg) }
      if (data !== undefined) record.data = serializable(data)
      let line
      try {
        line = JSON.stringify(record, (key, value) => (value instanceof Error ? serializable(value) : typeof value === 'bigint' ? String(value) : value))
      } catch {
        line = JSON.stringify({ ...record, data: '[unserializable]' })
      }
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        dirReady = true
      }
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
    } catch {
      // Logging must never break the caller.
    }
  }
  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  }
}

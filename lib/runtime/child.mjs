// Spawning `claude` (SPEC §10.2 "Spawn"). This is the ONLY module that starts a claude process
// (SPEC §3 import boundaries); everything else goes through `runInvocation` or `captureClaude`.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { writeFileAtomic } from '../core/atomic.mjs'
import { killGracefully, runCapture } from '../core/proc.mjs'

const STDERR_TAIL = 64 * 1024
const CLOSE_GRACE_MS = 2000

/**
 * Runs `<bin> <args>` and captures its output (for `--version` / `--help`). Never rejects:
 * see lib/core/proc.mjs `runCapture`. `env` defaults to process.env.
 */
export async function captureClaude(bin, args, { env, cwd, timeoutMs = 15000 } = {}) {
  return runCapture(bin, args, { env: env ?? process.env, cwd, timeoutMs })
}

/**
 * One role invocation: `spawn(bin, argv, {cwd, env, stdio:['pipe','pipe','pipe'], detached:false})`,
 * the message written to stdin and closed, stdout split into lines (also streamed to
 * `<dir>/stream.jsonl` unless `keepStream` is false), the last 64 KiB of stderr kept (and written
 * to `<dir>/stderr.txt`). A wall-clock watchdog of `timeoutSec` and the abort `signal` stop the
 * child with SIGINT → `graceMs` → SIGTERM → `graceMs` → SIGKILL (headless.md "Stop a run").
 *
 * Resolves `{ exitCode, signal, killedBy: 'watchdog'|'stop'|null, spawnError, stderr, lines, pid,
 * startedAt, finishedAt, durationMs }`. Never rejects for process failures.
 */
export async function runInvocation({ bin, argv, cwd, env, stdin = '', timeoutSec = 0, signal, dir, graceMs = 10000, keepStream = true, onSpawn } = {}) {
  const startedAt = new Date()
  const base = { exitCode: null, signal: null, killedBy: null, spawnError: null, stderr: '', lines: [], pid: null }
  if (signal?.aborted) {
    const finishedAt = new Date()
    return { ...base, killedBy: 'stop', startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: 0 }
  }
  let streamFile = null
  if (dir && keepStream) {
    streamFile = createWriteStream(join(dir, 'stream.jsonl'), { flags: 'w', mode: 0o600 })
    streamFile.on('error', () => undefined)
  }
  const lines = []
  const decoder = new StringDecoder('utf8') // a multi-byte character may be split across chunks
  let partial = ''
  let stderrBuf = Buffer.alloc(0)
  let killedBy = null
  let spawnError = null
  let child
  try {
    child = spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: false })
  } catch (error) {
    spawnError = error
  }

  const outcome = await new Promise(resolvePromise => {
    if (spawnError) {
      resolvePromise({ code: null, sig: null })
      return
    }
    let exited = null
    let closed = false
    let settled = false
    let closeTimer = null
    let watchdog = null
    const settle = () => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      if (closeTimer) clearTimeout(closeTimer)
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise(exited ?? { code: null, sig: null })
    }
    const stop = reason => {
      if (killedBy === null) killedBy = reason
      if (Number.isInteger(child.pid)) killGracefully(child.pid, { graceMs }).catch(() => undefined)
    }
    const onAbort = () => stop('stop')
    child.stdout.on('data', chunk => {
      if (streamFile) streamFile.write(chunk)
      partial += decoder.write(chunk)
      let nl
      while ((nl = partial.indexOf('\n')) >= 0) {
        lines.push(partial.slice(0, nl))
        partial = partial.slice(nl + 1)
      }
    })
    child.stderr.on('data', chunk => {
      stderrBuf = Buffer.concat([stderrBuf, chunk])
      if (stderrBuf.length > STDERR_TAIL) stderrBuf = stderrBuf.subarray(stderrBuf.length - STDERR_TAIL)
    })
    child.on('error', error => {
      // Only a failure to start is a spawn error; later 'error' events (a failed kill) are ignored.
      if (!Number.isInteger(child.pid)) {
        spawnError = spawnError ?? error
        exited = { code: null, sig: null }
        settle()
      }
    })
    child.on('exit', (code, sig) => {
      exited = { code, sig }
      if (closed) settle()
      else {
        // Grandchildren may keep the pipes open; do not wait for them forever.
        closeTimer = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          settle()
        }, CLOSE_GRACE_MS)
      }
    })
    child.on('close', (code, sig) => {
      closed = true
      if (exited === null) exited = { code, sig }
      settle()
    })
    if (Number.isInteger(child.pid)) onSpawn?.(child.pid)
    if (timeoutSec > 0) {
      watchdog = setTimeout(() => stop('watchdog'), timeoutSec * 1000)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdin.on('error', () => undefined) // EPIPE when the child exits without reading stdin
    child.stdin.end(stdin)
  })

  partial += decoder.end()
  if (partial !== '') lines.push(partial)
  if (streamFile) await new Promise(r => streamFile.end(r))
  const stderr = stderrBuf.toString('utf8')
  if (dir) await writeFileAtomic(join(dir, 'stderr.txt'), stderr).catch(() => undefined)
  const finishedAt = new Date()
  return {
    exitCode: outcome.code,
    signal: outcome.sig,
    killedBy,
    spawnError,
    stderr,
    lines,
    pid: child?.pid ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  }
}

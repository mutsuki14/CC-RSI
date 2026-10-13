// Process helpers (SPEC §0 "Processes", §5.5).

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { CcRsiError } from './errors.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Whether `pid` names a live process: `kill(pid, 0)` succeeds, or fails with EPERM (alive, not ours). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Whether the process group led by `pgid` still has a member. */
function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Spawns a detached process-group leader with stdio redirected to `logFile` (appended,
 * mode 0600) and unref's it, so it outlives the caller (SPEC §0 "Processes"). Returns its pid.
 * Throws CcRsiError('spawn_failed') when the OS refuses to start it.
 */
export function spawnDetached(cmd, args, { cwd, env, logFile } = {}) {
  let fd = 'ignore'
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
    fd = openSync(logFile, 'a', 0o600)
  }
  try {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] })
    // An asynchronous spawn error must never crash the parent.
    child.on('error', () => undefined)
    if (!Number.isInteger(child.pid)) throw new CcRsiError('spawn_failed', `could not start ${cmd}`, { cmd, args })
    child.unref()
    return child.pid
  } finally {
    if (typeof fd === 'number') {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Polls until `alive()` is false or `ms` elapses. True when it went away. */
async function waitGone(alive, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    if (!alive()) return true
    if (Date.now() >= deadline) return !alive()
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())))
  }
}

/**
 * Stops a process (or, with `group`, its whole process group `-pid`): SIGINT → wait
 * `graceMs` → SIGTERM → wait `graceMs` → SIGKILL (headless.md "Stop a run with SIGTERM").
 * Returns 'gone' when it was not running, 'exited' when it stopped after SIGINT or SIGTERM,
 * and 'killed' when SIGKILL was needed.
 */
export async function killGracefully(pid, { graceMs = 10000, group = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone'
  // A pid that is not a group leader has no group: fall back to the process itself.
  const alive = group ? () => groupAlive(pid) || pidAlive(pid) : () => pidAlive(pid)
  if (!alive()) return 'gone'
  const sendTo = (target, signal) => {
    try {
      process.kill(target, signal)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
      throw error
    }
  }
  const send = signal => (group && sendTo(-pid, signal)) || sendTo(pid, signal)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    if (!send(signal)) return 'exited'
    if (await waitGone(alive, graceMs)) return 'exited'
  }
  if (!send('SIGKILL')) return 'exited'
  await waitGone(alive, 5000)
  return 'killed'
}

/**
 * Runs `cmd args` and captures its output as UTF-8 text. Never rejects for process failures:
 * a spawn error yields `code: null` with `error` set to the errno code (e.g. 'ENOENT') and the
 * message in `stderr`. A timeout sends SIGTERM, then SIGKILL after 2 s, and sets `timedOut`.
 * Output beyond `maxBuffer` bytes per stream is dropped and `truncated` is set.
 * Resolves `{ code, signal, stdout, stderr, timedOut, truncated?, error? }`.
 */
export function runCapture(cmd, args = [], { cwd, env, timeoutMs = 15000, maxBuffer = 32 * 2 ** 20, input } = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false, error: error?.code ?? 'spawn_failed' })
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let spawnError = null
    let settled = false
    let killTimer = null
    const collect = (chunks, add) => chunk => {
      const room = maxBuffer - add(0)
      if (room <= 0) {
        truncated = true
        return
      }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (piece.length < chunk.length) truncated = true
      chunks.push(piece)
      add(piece.length)
    }
    child.stdout.on('data', collect(out, n => (outBytes += n)))
    child.stderr.on('data', collect(err, n => (errBytes += n)))
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }, 2000)
        killTimer.unref?.()
      }, timeoutMs)
      : null
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const result = {
        code: spawnError ? null : code,
        signal: signal ?? null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + (spawnError ? String(spawnError.message ?? spawnError) : ''),
        timedOut,
      }
      if (truncated) result.truncated = true
      if (spawnError) result.error = spawnError.code ?? 'spawn_failed'
      resolve(result)
    }
    child.on('error', error => {
      spawnError = error
      // 'close' does not always follow a spawn failure.
      setImmediate(() => finish(null, null))
    })
    child.on('close', (code, signal) => finish(code, signal))
    if (input !== undefined) {
      child.stdin.on('error', () => undefined) // EPIPE when the child exits without reading
      child.stdin.end(input)
    }
  })
}

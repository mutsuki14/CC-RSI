// Sealed evaluation (SPEC §13.4; dsh-rsi src/host/sealed.ts + the RSIAgent grading lifecycle,
// core/grading.py `run_until_success` / `GradingBlocked` and benchmarks/osworld/pipeline.py
// `_ensure_no_later_phase`).
//
// The official evaluator runs only after a lineage has ended, from a terminal, outside every model
// context, on frozen memory, against a private copy of the final candidate. Its output never enters a
// prompt, memory or later learning (trust boundary 4):
//  - refused when CLAUDECODE or CC_RSI_ROLE is set (any Claude Code subprocess or role child);
//  - records live under `<home>/projects/<key>/sealed/`, which every role has hidden and the main
//    session guard denies to the Actor's file tools;
//  - the score is printed only to a TTY; `cc-rsi status` shows counts only;
//  - afterwards the store carries the sealed marker, which closes learning until a human runs
//    `cc-rsi memory unfreeze --after-sealed` (RSIAgent: no later phase after Phase 3).

import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readJson, readJsonSafe, writeFileAtomic, writeJsonAtomic } from '../core/atomic.mjs'
import { loadConfig } from '../core/config.mjs'
import { sha256Hex } from '../core/digest.mjs'
import { CcRsiError, HumanOnlyError, RoleContextError } from '../core/errors.mjs'
import { isValidId, newRunId } from '../core/ids.mjs'
import { LeaseLock } from '../core/lock.mjs'
import { isUnderLexical, lineageLayout, projectKey, projectLayout } from '../core/paths.mjs'
import { MemoryStore } from '../memory/store.mjs'
import { childEnv } from '../runtime/env.mjs'
import { copyTree, removeTree } from '../workspace/copy.mjs'
import { treeFingerprint } from '../workspace/fingerprint.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TAIL_CHARS = 4000
const STDOUT_CAP = 16 * 2 ** 20
const STDERR_CAP = 2 ** 20
const KILL_GRACE_MS = 5000

/** BASE_SET variables childEnv adds for role children; an evaluator is not a role child. */
const ROLE_ONLY_ENV = ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'DISABLE_AUTOUPDATER']

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/** A refusal of the sealed evaluation (CLI exit 3). */
function refuse(message, details = {}) {
  const error = new CcRsiError('eval_refused', `sealed evaluation refused: ${message}`, details)
  error.exitCode = 3
  return error
}

/** Sealed evaluation is terminal-only: never inside Claude Code or a role child (SPEC §13.4 step 1). */
function refuseInModelContext(env, label) {
  if (typeof env?.CC_RSI_ROLE === 'string' && env.CC_RSI_ROLE !== '') throw new RoleContextError()
  if (typeof env?.CLAUDECODE === 'string' && env.CLAUDECODE !== '') throw new HumanOnlyError(label)
}

function tail(text, chars = TAIL_CHARS) {
  return text.length <= chars ? text : `…${text.slice(-chars)}`
}

/**
 * The score of an evaluator's stdout: its last non-empty line parsed as a JSON number or
 * `{"score": n}` (dsh sealed.ts parseScore). Null when absent or not a finite number.
 */
export function parseScore(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const last = lines[lines.length - 1]
  if (last === undefined) return null
  try {
    const value = JSON.parse(last)
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.score === 'number' && Number.isFinite(value.score)) return value.score
  } catch {
    // A last line that is not JSON carries no machine-readable score.
  }
  return null
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Runs the evaluator once as its own process group (so a timeout or an interruption also stops its
 * children, and nothing it started outlives the attempt). Resolves
 * `{ code, signal, stdout, stderr, timedOut, interrupted, durationMs }`; never rejects.
 */
function runEvaluator(argv, { cwd, env, timeoutMs, abort }) {
  return new Promise(resolvePromise => {
    const started = Date.now()
    const out = []
    const err = []
    let timedOut = false
    let interrupted = false
    let settled = false
    let exitInfo = null
    let child
    const finish = (code, signal, extraErr = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(closeTimer)
      abort?.removeEventListener?.('abort', onAbort)
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + extraErr,
        timedOut,
        interrupted,
        durationMs: Date.now() - started,
      })
    }
    let killTimer = null
    let closeTimer = null
    const stopGroup = () => {
      if (!child || !Number.isInteger(child.pid)) return
      killGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopGroup()
    }, Math.max(1, timeoutMs))
    const onAbort = () => {
      interrupted = true
      stopGroup()
    }
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish(null, null, String(error?.message ?? error))
      return
    }
    if (abort?.aborted) onAbort()
    else abort?.addEventListener?.('abort', onAbort, { once: true })
    // Keeps the newest output within `cap` bytes (the score is the last stdout line).
    const collect = (chunks, cap) => {
      let total = 0
      return chunk => {
        chunks.push(chunk)
        total += chunk.length
        while (total > cap && chunks.length > 1) total -= chunks.shift().length
      }
    }
    child.stdout.on('data', collect(out, STDOUT_CAP))
    child.stderr.on('data', collect(err, STDERR_CAP))
    child.on('error', error => {
      finish(null, null, String(error?.message ?? error))
    })
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      // Nothing the evaluator started may outlive it (it ran as its own process group).
      killGroup(child.pid, 'SIGKILL')
      closeTimer = setTimeout(() => finish(code, signal), 2000)
      closeTimer.unref?.()
    })
    child.on('close', (code, signal) => {
      const info = exitInfo ?? { code, signal }
      finish(info.code, info.signal)
    })
  })
}

/** Locates the lineage and the facts the evaluation needs; every refusal of SPEC §13.4 step 1-2. */
async function locate({ home, projectRoot, lineageId }) {
  if (!isValidId(lineageId)) throw refuse(`invalid lineage id ${JSON.stringify(lineageId)}`)
  const loaded = loadConfig({ home, projectRoot })
  const config = loaded.config
  const storeDir = typeof config.memory?.dir === 'string' && config.memory.dir !== '' ? config.memory.dir : undefined
  const pl = projectLayout(home, projectKey(projectRoot), { storeDir })
  const layout = lineageLayout(pl, lineageId)
  const lineage = await readJsonSafe(layout.lineageJson, null)
  if (!lineage || typeof lineage !== 'object') throw refuse(`no lineage ${lineageId} in project ${projectRoot}`)
  const result = await readJsonSafe(layout.result, null)
  if (!result || typeof result !== 'object') throw refuse(`lineage ${lineageId} has not ended (no result.json)`)
  const phase = result.phase ?? lineage.phase
  if (phase !== 'deep' && phase !== 'frozen') throw refuse(`lineage ${lineageId} is a ${phase} lineage; only deep and frozen lineages have a final candidate`)
  if (typeof result.candidate_digest !== 'string' || result.candidate_digest === '') throw refuse(`lineage ${lineageId} recorded no candidate_digest`)
  const lease = await LeaseLock.inspect(layout.engineLock).catch(() => null)
  if (lease && lease.holder && !lease.stale) throw refuse(`the engine of lineage ${lineageId} is running (pid ${lease.holder.pid})`)
  return { config, pl, layout, lineage, result, storeRoot: typeof lineage.storeRoot === 'string' && lineage.storeRoot !== '' ? lineage.storeRoot : pl.store }
}

function storeOptions(config, pl) {
  const memory = config?.memory ?? {}
  return {
    limits: { maxFiles: memory.maxFiles ?? 400, maxTotalBytes: memory.maxTotalBytes ?? 4194304, maxFileBytes: memory.maxFileBytes ?? 65536 },
    keepHistory: memory.keepHistory !== false,
    sealedTextFiles: Array.isArray(config?.audit?.sealedTextFiles) ? config.audit.sealedTextFiles : [],
    shingleWords: Number.isInteger(config?.audit?.shingleWords) ? config.audit.shingleWords : 8,
    sessionsDir: pl.sessions,
    lineagesDir: pl.lineages,
  }
}

/** A `--json-out` path must not be anywhere a model context reads (the project, role work trees, the candidate copy). */
function checkJsonOut(jsonOut, { home, projectRoot, runRoot }) {
  if (jsonOut === undefined || jsonOut === null || jsonOut === '') return null
  const target = resolve(String(jsonOut))
  const forbidden = [
    [projectRoot, 'the project (the main Actor session works there)'],
    [join(home, 'work'), 'the role work trees'],
    [runRoot, 'the sealed run directories'],
  ]
  for (const [dir, what] of forbidden) {
    if (dir && isUnderLexical(target, dir)) throw refuse(`--json-out ${target} lies inside ${what}; write it outside every model-visible directory`)
  }
  return target
}

async function uniqueRunDir(base, runId) {
  for (let k = 1; k < 1000; k++) {
    const id = k === 1 ? runId : `${runId}-${k}`
    const dir = join(base, id)
    try {
      await mkdir(base, { recursive: true, mode: 0o700 })
      await mkdir(dir, { mode: 0o700 })
      return { runId: id, runDir: dir }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new CcRsiError('eval_run_dir', `no free run directory under ${base}`)
}

async function freshCandidate(source, dest) {
  if (await exists(dest)) await removeTree(dest)
  await copyTree(source, dest, { verbatimSymlinks: true, preserveMode: true })
}

function writeOut(stdout, text) {
  stdout.write(`${text}\n`)
}

/**
 * Runs the sealed evaluation of a finished deep or frozen lineage (SPEC §13.4) and resolves to
 * `{ status: 'scored'|'blocked', runId, frozenIntact }`. Additive options: `env` (default
 * process.env), `retryDelayMs` (pause between attempts, default 1000), `signal` (interrupts the
 * evaluator; default SIGINT/SIGTERM of this process).
 */
export async function runSealedEvaluation({ home, projectRoot, lineageId, retries, jsonOut, stdout = process.stdout, env = process.env, retryDelayMs = 1000, signal } = {}) {
  refuseInModelContext(env, 'eval run')
  home = resolve(String(home))
  projectRoot = resolve(String(projectRoot))
  const { config, pl, layout, lineage, result, storeRoot } = await locate({ home, projectRoot, lineageId })
  const evaluation = config.evaluation ?? {}
  const argv = Array.isArray(evaluation.command) ? evaluation.command.map(String) : []
  if (argv.length === 0 || argv[0] === '') {
    throw refuse('evaluation.command is not configured; set it as an argv array in ~/.cc-rsi/config.json (it is global-only)')
  }
  const runRoot = join(pl.sealed, lineageId)
  const jsonOutPath = checkJsonOut(jsonOut, { home, projectRoot, runRoot })
  const maxRetries = Number.isInteger(retries) && retries >= 0 ? retries : (Number.isInteger(evaluation.retries) ? evaluation.retries : 2)
  const identicalLimit = Number.isInteger(evaluation.identicalErrorLimit) && evaluation.identicalErrorLimit > 0 ? evaluation.identicalErrorLimit : 3
  const timeoutMs = Math.max(1, Number(evaluation.timeoutSec ?? 900)) * 1000

  // 2. The source is the private final-candidate copy, checked against the digest recorded at the end.
  const source = join(layout.priv, 'final-candidate', 'tree')
  const sourceInfo = await lstat(source).catch(() => null)
  if (!sourceInfo || !sourceInfo.isDirectory()) throw refuse(`the final candidate of ${lineageId} is missing (${source})`)
  if ((await treeFingerprint(source)) !== result.candidate_digest) {
    throw refuse('the final candidate changed after the lineage ended')
  }

  // 3. Frozen memory: freeze when needed (a tampered tree is never frozen), then check it.
  const store = await MemoryStore.open(storeRoot, storeOptions(config, pl))
  let outcome
  try {
    if (!(await store.frozen())) await store.freeze({ by: 'eval' })
    await store.assertFrozenIntact()
    const memoryTreeBefore = await store.treeHash()

    // 4. The run directory, the candidate copy and the task file.
    const { runId, runDir } = await uniqueRunDir(runRoot, newRunId())
    const candidate = join(runDir, 'candidate')
    const taskFile = join(runDir, 'task.md')
    await freshCandidate(source, candidate)
    await writeFileAtomic(taskFile, typeof lineage.target?.text === 'string' ? lineage.target.text : '')

    // 5. The evaluator: allowlisted env without CC_RSI_* or Claude Code session variables.
    const unset = Object.fromEntries(ROLE_ONLY_ENV.map(name => [name, null]))
    const evalEnv = childEnv({
      parentEnv: env,
      role: undefined,
      set: { ...unset, RSI_CANDIDATE_ROOT: candidate, RSI_TASK_FILE: taskFile },
      passthrough: config.children?.envPassthrough ?? [],
      pluginRoot: PLUGIN_ROOT,
      home,
    })
    const controller = new AbortController()
    const onSignal = () => controller.abort()
    const external = signal ?? null
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onSignal, { once: true })
    } else {
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
    }
    const attempts = []
    let status = 'blocked'
    let score = null
    let blockedReason = null
    try {
      let previous = null
      let identical = 0
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          if (retryDelayMs > 0) await sleep(retryDelayMs)
          // Every attempt measures the same candidate (an earlier attempt may have changed its copy).
          await freshCandidate(source, candidate)
        }
        const r = await runEvaluator(argv, { cwd: candidate, env: evalEnv, timeoutMs, abort: controller.signal })
        const stdoutTail = tail(r.stdout)
        const stderrTail = tail(r.stderr)
        attempts.push({ exit_code: r.code, timed_out: r.timedOut, stdout_tail: stdoutTail, stderr_tail: stderrTail, duration_ms: r.durationMs })
        if (r.interrupted) throw new CcRsiError('eval_interrupted', 'the sealed evaluation was interrupted; nothing was recorded (memory stays frozen)')
        if (r.code === 0 && !r.timedOut) {
          const parsed = parseScore(r.stdout)
          if (parsed === null) {
            blockedReason = 'the evaluator exited 0 but its last stdout line is not a JSON number or {"score": n}'
          } else {
            status = 'scored'
            score = parsed
          }
          break
        }
        // RSIAgent GradingBlocked: the same error repeated identicalErrorLimit times in a row stops early.
        const key = sha256Hex(stderrTail)
        identical = key === previous ? identical + 1 : 1
        previous = key
        if (identical >= identicalLimit) {
          blockedReason = `the same evaluator error repeated ${identical} times`
          break
        }
        if (attempt === maxRetries) blockedReason = `the evaluator failed ${attempts.length} time(s) (retries exhausted)`
      }
    } finally {
      if (external) external.removeEventListener('abort', onSignal)
      else {
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
      }
    }

    // 6. Re-hash, check the freeze, then seal (learning is closed until unfreeze --after-sealed).
    let memoryTreeAfter
    try {
      memoryTreeAfter = await store.treeHash()
    } catch (error) {
      memoryTreeAfter = `invalid (${error?.message ?? error})`
    }
    let frozenIntact = true
    try {
      await store.assertFrozenIntact()
    } catch {
      frozenIntact = false
    }
    frozenIntact = frozenIntact && memoryTreeAfter === memoryTreeBefore
    await store.markSealed({ lineage: lineageId, runId })

    // 7. Records (snake_case, RSIAgent keys) — under hidden <home> paths only.
    const record = {
      schema_version: 1,
      lineage: lineageId,
      run_id: runId,
      status,
      score: status === 'scored' ? score : null,
      attempts,
      candidate_digest: result.candidate_digest,
      memory_tree_before: memoryTreeBefore,
      memory_tree_after: memoryTreeAfter,
      frozen_intact: frozenIntact,
      official_evaluator_feedback_entered_agent: false,
      ts: new Date().toISOString(),
    }
    if (blockedReason) record.blocked_reason = blockedReason
    await writeJsonAtomic(join(runDir, 'evaluation.json'), record)
    const sealedPath = join(layout.dir, 'sealed.json')
    const prior = await readJsonSafe(sealedPath, null)
    const runs = Array.isArray(prior?.runs) ? prior.runs.filter(r => typeof r === 'string') : []
    if (!runs.includes(runId)) runs.push(runId)
    await writeJsonAtomic(sealedPath, { runs })
    if (jsonOutPath) await writeJsonAtomic(jsonOutPath, record)
    outcome = { status, runId, frozenIntact, score, blockedReason }
  } finally {
    await store.close()
  }

  // 8. The score reaches a terminal only.
  writeOut(stdout, `sealed evaluation ${outcome.runId} of ${lineageId}: ${outcome.status}${outcome.blockedReason ? ` (${outcome.blockedReason})` : ''}`)
  if (stdout.isTTY === true) {
    if (outcome.status === 'scored') writeOut(stdout, `score: ${outcome.score}`)
  } else {
    writeOut(stdout, `evaluation recorded (score withheld: stdout is not a terminal); view it with "cc-rsi eval show ${lineageId}" in a terminal`)
  }
  if (jsonOutPath) writeOut(stdout, `evaluation summary written to ${jsonOutPath}`)
  if (!outcome.frozenIntact) writeOut(stdout, 'WARNING: memory changed during the evaluation (frozen tree not intact); this result is not trustworthy')
  return { status: outcome.status, runId: outcome.runId, frozenIntact: outcome.frozenIntact }
}

/**
 * Prints a recorded sealed evaluation (SPEC §13.4): status, attempts and integrity always; the score
 * only when `stdout.isTTY`. `runId` defaults to the latest run. Additive option: `env`.
 */
export async function showEvaluation({ home, projectRoot, lineageId, runId, stdout = process.stdout, env = process.env } = {}) {
  refuseInModelContext(env, 'eval show')
  home = resolve(String(home))
  projectRoot = resolve(String(projectRoot))
  if (!isValidId(lineageId)) throw refuse(`invalid lineage id ${JSON.stringify(lineageId)}`)
  const pl = projectLayout(home, projectKey(projectRoot))
  const runRoot = join(pl.sealed, lineageId)
  const runs = []
  for (const name of (await readdir(runRoot).catch(() => [])).sort()) {
    if (await exists(join(runRoot, name, 'evaluation.json'))) runs.push(name)
  }
  if (runs.length === 0) throw refuse(`no sealed evaluation of lineage ${lineageId} is recorded`)
  const chosen = runId ?? runs[runs.length - 1]
  if (!runs.includes(chosen)) throw refuse(`no sealed evaluation run ${chosen} of lineage ${lineageId} (runs: ${runs.join(', ')})`)
  const record = await readJson(join(runRoot, chosen, 'evaluation.json'), null)
  writeOut(stdout, `sealed evaluation ${chosen} of ${lineageId}: ${record.status}${record.blocked_reason ? ` (${record.blocked_reason})` : ''}`)
  writeOut(stdout, `attempts: ${Array.isArray(record.attempts) ? record.attempts.length : 0}; frozen memory intact: ${record.frozen_intact ? 'yes' : 'NO'}; candidate ${String(record.candidate_digest).slice(0, 12)}; memory ${String(record.memory_tree_before).slice(0, 12)}; ${record.ts}`)
  if (stdout.isTTY === true) {
    writeOut(stdout, record.status === 'scored' ? `score: ${record.score}` : 'score: none (blocked)')
  } else {
    writeOut(stdout, 'score withheld: stdout is not a terminal; run this command in a terminal')
  }
  if (runs.length > 1) writeOut(stdout, `runs: ${runs.join(', ')}`)
}

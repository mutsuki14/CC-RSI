// Test harness for the interactive mode (WP5): a temp project + CC_RSI_HOME + fake claude, the
// real hooks (spawned through hooks/hook.mjs) and the real MCP server over stdio.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globalLayout, projectKey, projectLayout, sessionLayout } from '../../lib/core/paths.mjs'
import { killGracefully } from '../../lib/core/proc.mjs'
import { fakeClaude, scenarioPath, writeScript } from '../_helpers/fake.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { gitRepo, tmpHome } from '../_helpers/tmp.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const HOOK = join(ROOT, 'hooks', 'hook.mjs')
export const SERVER = join(ROOT, 'mcp', 'server.mjs')
export const TOOL_PREFIX = 'mcp__plugin_cc-rsi_rsi__'

/** Environment variables of the surrounding Claude Code session that must not leak into tests. */
const OUTER = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE',
  'CLAUDE_PLUGIN_OPTION_VERIFIER_MODEL', 'CLAUDE_PLUGIN_OPTION_STOP_POLICY', 'CLAUDE_PLUGIN_OPTION_SANDBOX', 'CC_RSI_OPT_VERIFIER_MODEL',
  'CC_RSI_OPT_STOP_POLICY', 'CC_RSI_OPT_SANDBOX', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS', 'CC_RSI_PLUGIN_ROOT']

/** A clean env: the test home, no outer Claude Code session variables. */
export function cleanEnv(base) {
  const env = { ...base }
  for (const key of OUTER) delete env[key]
  return env
}

/**
 * A git project with `files`, a temp home (with `config` as `<home>/config.json`), and the fake
 * claude (`scenario`, default scripted.mjs driven by `script`). Returns
 * `{ home, repo, fake, env, sid, write(rel, text), read(rel) }`.
 */
export async function setupProject({ files = { 'README.md': '# demo\n', 'src/app.txt': 'version 1\n' }, config = {}, script, scenario } = {}) {
  const { home, env: homeEnv } = await tmpHome()
  const repo = await gitRepo(files)
  const fake = await fakeClaude({ scenario: scenario ?? scenarioPath('scripted'), home })
  if (script) writeScript(fake, script)
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  // Hermetic: a temp CLAUDE_CONFIG_DIR (the real ~/.claude settings and transcripts never reach a test).
  // The Verifier model is a saved plugin option: the hooks (CLAUDE_PLUGIN_OPTION_*) and the MCP server
  // (CC_RSI_OPT_*) both see it; the server applies what the hooks recorded (r3-interactive-5).
  const env = {
    ...cleanEnv(fake.env), CLAUDE_PROJECT_DIR: repo, CC_RSI_HOME: home, CLAUDE_CONFIG_DIR: homeEnv.CLAUDE_CONFIG_DIR,
    CC_RSI_OPT_VERIFIER_MODEL: 'test-verifier-model', CLAUDE_PLUGIN_OPTION_VERIFIER_MODEL: 'test-verifier-model',
  }
  return {
    home,
    repo,
    fake,
    env,
    sid: randomUUID(),
    write: (rel, text) => writeFileSync(join(repo, rel), text),
    read: rel => readFileSync(join(repo, rel), 'utf8'),
  }
}

/** `{ pl, sl, g }` of a test project (the repo is a git top level, so projectRoot = repo). */
export function layouts(p, sid = p.sid) {
  const pl = projectLayout(p.home, projectKey(p.repo))
  return { g: globalLayout(p.home), pl, sl: sessionLayout(pl, sid) }
}

/** task.json of a session (or null). */
export function taskState(p, sid = p.sid) {
  try {
    return JSON.parse(readFileSync(layouts(p, sid).sl.task, 'utf8'))
  } catch {
    return null
  }
}

/** Every job file of a session, oldest first. */
export function jobsOf(p, sid = p.sid) {
  const dir = layouts(p, sid).sl.jobs
  let names = []
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')) } catch { return [] }
  return names.map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

/** Runs `hooks/hook.mjs <sub>` with `payload` on stdin. Resolves `{ code, stdout, stderr, json }`. */
export async function hook(sub, payload, env, { timeoutMs = 20000 } = {}) {
  const r = await runNode(HOOK, [sub], { stdin: typeof payload === 'string' ? payload : JSON.stringify(payload), env, timeoutMs })
  let json = null
  if (r.stdout.trim() !== '') {
    try { json = JSON.parse(r.stdout) } catch { json = undefined }
  }
  return { ...r, json }
}

/** Hook payloads with the key sets recorded on 2.1.296 (claude-code-experiments.md a). */
export const payloads = {
  sessionStart: (p, source = 'startup', extra = {}) => ({ session_id: p.sid, transcript_path: join(p.home, 'transcript.jsonl'), cwd: p.repo, scratchpad_dir: '/tmp/scratch', hook_event_name: 'SessionStart', source, ...extra }),
  prompt: (p, prompt, extra = {}) => ({ session_id: p.sid, transcript_path: join(p.home, 'transcript.jsonl'), cwd: p.repo, scratchpad_dir: '/tmp/scratch', prompt_id: `prompt-${randomBytes(4).toString('hex')}`, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt, ...extra }),
  pre: (p, tool_name, tool_input, extra = {}) => ({ session_id: p.sid, transcript_path: join(p.home, 'transcript.jsonl'), cwd: p.repo, scratchpad_dir: '/tmp/scratch', prompt_id: 'prompt-x', permission_mode: 'default', effort: { level: 'medium' }, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: `toolu_${randomBytes(8).toString('hex')}`, ...extra }),
  stop: (p, extra = {}) => ({ session_id: p.sid, transcript_path: join(p.home, 'transcript.jsonl'), cwd: p.repo, scratchpad_dir: '/tmp/scratch', prompt_id: 'prompt-x', permission_mode: 'default', effort: { level: 'medium' }, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done', background_tasks: [], session_crons: [], ...extra }),
}

/**
 * A recorded payload shape from test/hooks/payloads/<name>.json with `__SID__`, `__HOME__`,
 * `__CWD__` and `__TEXT__` filled in (JSON-escaped), merged with `extra`.
 */
export function fixture(name, p, { text = '', extra = {} } = {}) {
  const raw = readFileSync(join(ROOT, 'test', 'hooks', 'payloads', `${name}.json`), 'utf8')
  const esc = value => JSON.stringify(String(value)).slice(1, -1)
  const filled = raw.replaceAll('__SID__', esc(p.sid)).replaceAll('__HOME__', esc(p.home)).replaceAll('__CWD__', esc(p.repo)).replaceAll('__TEXT__', esc(text))
  return { ...JSON.parse(filled), ...extra }
}

/** A newline-delimited JSON-RPC client of `mcp/server.mjs` over real stdio. */
export class McpClient {
  constructor(env, { cwd, server = SERVER } = {}) {
    this.child = spawn(process.execPath, [server], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.raw = []
    this.stderr = ''
    let buffer = ''
    this.child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const at = buffer.indexOf('\n')
        if (at < 0) break
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        this.raw.push(line)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
          const { resolve: done } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          done(msg)
        } else if (msg.method) {
          this.notifications.push(msg)
        } else {
          this.notifications.push(msg)
        }
      }
    })
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8') })
    this.exited = new Promise(resolveExit => this.child.on('close', (code, signal) => resolveExit({ code, signal })))
  }

  send(message) {
    this.child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
  }

  /** Sends a request and resolves the whole response message. */
  request(method, params, { id } = {}) {
    const rid = id ?? this.nextId++
    const promise = new Promise((resolveReq, reject) => {
      this.pending.set(rid, { resolve: resolveReq, reject })
    })
    this.send({ jsonrpc: '2.0', id: rid, method, ...(params === undefined ? {} : { params }) })
    return promise
  }

  async initialize() {
    const r = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return r
  }

  async close() {
    try { this.child.stdin.end() } catch { /* closed */ }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 10000)
    const r = await this.exited
    clearTimeout(timer)
    return r
  }
}

/**
 * Calls a cc-rsi tool the way Claude Code does: the attest hook first (PreToolUse with the
 * tool_use_id), then `tools/call` with `_meta["claudecode/toolUseId"]`. Options: `agentId`
 * (a subagent caller), `attest: false` (skip the hook), `progressToken`.
 */
export async function callTool(p, client, name, args = {}, { agentId, attest = true, progressToken, sid = p.sid, cwd = p.repo } = {}) {
  const toolUseId = `toolu_${randomBytes(10).toString('hex')}`
  if (attest) {
    const payload = payloads.pre(p, `${TOOL_PREFIX}${name}`, args, { tool_use_id: toolUseId, session_id: sid, cwd, mcp_server: { name: 'plugin:cc-rsi:rsi', source: 'plugin' } })
    if (agentId) Object.assign(payload, { agent_id: agentId, agent_type: 'general-purpose' })
    const r = await hook('attest', payload, p.env)
    if (r.code !== 0) throw new Error(`attest hook failed: ${r.stderr}`)
  }
  const meta = { 'claudecode/toolUseId': toolUseId }
  if (progressToken !== undefined) meta.progressToken = progressToken
  const response = await client.request('tools/call', { name, arguments: args, _meta: meta })
  if (response.error) throw new Error(`tools/call ${name}: ${JSON.stringify(response.error)}`)
  const result = response.result
  return { ...result, text: result.content.map(c => c.text).join('\n') }
}

/** The CONFIRM CODE in a learning stage message. */
export function confirmCodeIn(text) {
  const m = /CONFIRM CODE: ([0-9a-f]{6})/.exec(text)
  return m ? m[1] : null
}

/** Kills every still-running verification job (and its process group) of a home. */
export async function reapJobs(home) {
  const projects = join(home, 'projects')
  const pids = []
  const walk = dir => {
    let names = []
    try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of names) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json') && dir.endsWith('jobs')) {
        try {
          const job = JSON.parse(readFileSync(full, 'utf8'))
          if (Number.isInteger(job.pid) && job.pid !== process.pid && (job.status === 'running' || job.status === 'queued')) pids.push(job.pid)
        } catch { /* skip */ }
      }
    }
  }
  walk(projects)
  for (const pid of pids) await killGracefully(pid, { group: true, graceMs: 500 }).catch(() => undefined)
}

/** The pid of a process that has already exited and been reaped (a portable dead pid). */
export function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid
}

/** Polls `fn` until it returns a truthy value (or throws after `timeoutMs`). */
export async function until(fn, { timeoutMs = 20000, pollMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, pollMs))
  }
}

export { writeScript }

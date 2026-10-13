// Fake `claude` for cc-rsi tests (SPEC §15.2). Owned by WP4; WP5 and WP6 depend on this contract.
//
// It emulates the parts of Claude Code 2.1.296 the runtime relies on, with the shapes observed on
// the real binary (proposal-fidelity F1-F7, proposal-robust R1-R5, claude-code-experiments f2,
// WP4 probes V3/V4): stream-json events, --session-id/--resume semantics, the R3/R4 error shapes,
// the F3 API-error and F7 blocked-prompt shapes, crashes, hangs, and REAL execution of the hooks
// in the --settings file (so hooks/role-guard.mjs runs end to end).
//
// ============================================================================ CONFIGURATION
// Environment first, then `$CC_RSI_HOME/fake-claude.json` (written by test/_helpers/fake.mjs,
// because the runtime's env allowlist does not pass FAKE_CLAUDE_* to role children):
//   FAKE_CLAUDE_HOME      / "home"       session store: <home>/sessions/<id>.json
//   FAKE_CLAUDE_SCENARIO  / "scenario"   absolute path of the scenario module (default: reply "OK")
//   FAKE_CLAUDE_LOG       / "log"        JSONL invocation log (default <home>/log.jsonl)
//   FAKE_CLAUDE_RUN_HOOKS / "runHooks"   '0' / false disables hook execution (default on)
//   FAKE_CLAUDE_SANDBOX   / "sandbox"    'available' lets a failIfUnavailable sandbox start (default unavailable)
//
// ============================================================================ INVOCATION SURFACE
// --version → "2.1.296 (Claude Code)"; --help → text naming every REQUIRED_FLAGS entry. Neither is logged.
// Requires -p. Parses exactly the flags of SPEC §10.2 (plus --include-hook-events, --max-budget-usd,
// --effort, --no-session-persistence). Unknown flag → stderr "error: unknown option '<x>'", exit 1.
// Any positional argument → exit 2, stderr "FAKE: positional prompt". Missing session flag → exit 2.
// Forbidden env (a NEVER name of SPEC §10.5 other than CC_RSI_*) → exit 3 "FAKE: forbidden env <NAME>".
// Missing CC_RSI_ROLE, CC_RSI_EXPECT or CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 → exit 3.
// The prompt is stdin (byte-exact, R2). Output formats: stream-json (all events), json (the result
// object only), text (the result text only).
//
// ============================================================================ SESSIONS
// <home>/sessions/<id>.json = {id, cwd, turns:[{n, prompt, text, actions, contexts, ...}], pendingInterrupted, cost, toolSeq}
//  - --session-id with an existing id → R4: no stdout, stderr "Error: Session ID <id> is already in use.", exit 1
//  - --resume with an unknown id → R3: one stdout line {"type":"result","subtype":"error_during_execution",
//    "is_error":true,"num_turns":0,"session_id":"<id>","errors":["No conversation found with session ID: <id>"]}, exit 1
//  - --resume works from any cwd (verified on 2.1.296); a session interrupted mid-tool gets a history
//    entry {interrupted:true, toolUseId} before the next turn (R1)
//  - --no-session-persistence: nothing is stored
//  - a sandbox gate failure (below) exits before the session is created (f2); a scenario 'before-init'
//    crash or `stderrOnly` exit removes a session this invocation created (nothing reached the transcript,
//    so a later --resume is R3, the first-message crash path of SPEC §10.9)
//
// ============================================================================ SETTINGS AND HOOKS
// --settings (file path or inline JSON) is read. With sandbox.enabled + failIfUnavailable and the
// sandbox "unavailable" (default) → no stdout, stderr "Error: sandbox required but unavailable: …", exit 1.
// Hooks run for real (command + args exec form, or `sh -c command`; stdin = payload JSON; `timeout`
// seconds honoured; env + CLAUDE_PROJECT_DIR) unless runHooks is off. Exit 2 = blocking error;
// other failures block only with onFailure:"block" (V3 wording). Matchers: '*' or empty = all; an
// exact '|' list when the matcher is [A-Za-z0-9_- ,|] only; otherwise an unanchored regex.
//  - UserPromptSubmit fires first with {session_id, transcript_path, cwd, prompt_id, permission_mode:'dontAsk',
//    hook_event_name, prompt}; decision:block (or exit 2) → F7 shape: system/init, system/informational
//    "UserPromptSubmit operation blocked by hook: …\n\nOriginal prompt: <prompt>", result {subtype:'success',
//    is_error:false, num_turns:0, result:<the same text>}, exit 0; the scenario is NOT consulted.
//  - PreToolUse fires per scripted action whose tool is in --tools and that no `deny` rule refuses
//    (deny rules are checked first, as on 2.1.296), with {…, tool_name, tool_input, tool_use_id:'toolu_fake_<n>'};
//    deny → tool_result is_error "PreToolUse:<Tool> hook error: <reason>" plus a permission_denials entry;
//    permissionDecision "allow" → the log records allowSeen:true and the allow rules are skipped.
//  - PostToolUse fires after an executed tool with tool_response; its additionalContext is recorded.
//  - SessionStart (source 'compact') fires when the scenario returns compact:true; additionalContext recorded.
//  With --include-hook-events each hook emits system/hook_started and system/hook_response.
//
// ============================================================================ TOOLS
// A scripted action whose tool is not in --tools → tool_result "No such tool available: <Tool>" (no hooks).
// Permissions: a matching `deny` rule (bare name, `Read(//abs/**)` for Read/Glob/Grep, `Edit(//abs/**)`
// for writes) refuses the call before the hooks ("Permission to use <Tool> has been denied." for a bare
// rule, "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>"
// for a path rule, as observed on 2.1.296). Then, in dontAsk, a call is permitted iff a
// hook answered allow, `allow` has the bare tool name (or `Edit` for any write tool), `Edit(//abs/**)`
// covers the path of Write/Edit/MultiEdit/NotebookEdit, or `Bash(prefix:*)` matches.
// --restricted: file-tool paths outside cwd + permissions.additionalDirectories are denied.
// Denied → tool_result error + permission_denials entry. Effects are real: Bash runs `/bin/sh -c`
// in cwd with the fake's env (30 s timeout); Write/Edit/Read/Glob/Grep touch the real filesystem.
//
// ============================================================================ SCENARIO API
// `$FAKE_CLAUDE_SCENARIO` is an ES module: `export default async function respond(ctx)`, where
// ctx = { role: env.CC_RSI_ROLE, sessionId, turn /* 1-based per session; interrupted turns do not count */, prompt, history /* prior turns */,
//         cwd, env, flags, recovering: /HARNESS RECOVERY/.test(prompt), fakeHome, settings, model, systemPrompt }.
// It returns one of:
//   { actions?: [{tool:'Bash', command} | {tool:'Write', file_path, content} | {tool:'Edit', file_path, old_string,
//       new_string, replace_all?} | {tool:'Read', file_path} | {tool:'Glob'|'Grep', pattern, path?} | {tool:<any>, input}],
//     text: string, stopReason?: 'end_turn'|'max_tokens'|'refusal', compact?: boolean, model?: string,
//     initOverride?: { mcp_servers?, tools?, permissionMode? } }
//   { apiError: { status, error, text? } }            F3 shape: synthetic assistant + result is_error:true, exit 1
//   { resultSubtype: 'error_max_turns'|'error_during_execution'|'error_max_budget_usd' }   exit 1
//   { crash: 'before-init'|'after-init'|'mid-tool'|'after-result', exit?, stderr? }   (default exit 1; mid-tool 137)
//       'mid-tool': emits the first action's tool_use, then exits 137; the next --resume shows {interrupted:true}
//   { hangMs: number, ...normal }                     sleeps (SIGINT → exit 130, SIGTERM → exit 143, no result),
//                                                     then continues with the normal fields (default text '')
//   { stderrOnly: string, exit: number }              e.g. f2 'Error: sandbox required but unavailable: …'
//
// ============================================================================ STREAM OUTPUT
// [hook events of UserPromptSubmit], system/init {cwd, session_id, tools (parsed --tools), mcp_servers:[],
// model: --model ?? 'fake-default-model', permissionMode, claude_code_version:'2.1.296'}; per action one
// assistant event (message.id msg_<turn>_<k>, one tool_use block), hook events, a user tool_result; one final
// assistant text event; result {type:'result', subtype:'success', is_error:false, result:text, session_id,
// num_turns: actions+1, total_cost_usd (cumulative per session: 0.001 per action + 0.001), stop_reason,
// terminal_reason:'completed', permission_denials}. More actions than --max-turns → error_max_turns.
//
// ============================================================================ LOG
// Each invocation appends {ts, pid, argv, cwd, envKeys, ccRsi:{CC_RSI_*}, stdinSha, sessionId, mode:'new'|'resume',
// exit, signal?, allowSeen, hooksRun:[{event, tool?, exit, decision?}], scenario?, response?} to the log.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const VERSION = '2.1.296'

const VALUE_FLAGS = new Set(['--output-format', '--session-id', '--resume', '--model', '--effort', '--setting-sources', '--mcp-config',
  '--append-system-prompt-file', '--settings', '--permission-mode', '--max-turns', '--max-budget-usd', '--tools'])
const BOOL_FLAGS = new Set(['-p', '--print', '--verbose', '--include-hook-events', '--restricted', '--strict-mcp-config',
  '--disable-slash-commands', '--no-session-persistence'])

// SPEC §10.5 NEVER, kept independent of lib/runtime/env.mjs so the fake catches a broken allowlist.
const NEVER = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  /^CLAUDE_CODE_REMOTE/, /INGRESS/, /^CLAUDE_CODE_MESSAGING_/, 'CLAUDE_CODE_TEE_SDK_STDOUT', 'CLAUDE_CODE_USE_CCR_V2',
  'CLAUDE_CODE_CONTAINER_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_PID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'CLAUDE_CODE_DIAGNOSTICS_FILE', 'CLAUDE_CODE_DEBUG',
  'CLAUDE_AUTO_BACKGROUND_TASKS', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'MCP_TOOL_TIMEOUT',
  /^CCR_/, /^CLAUDE_PLUGIN_/, 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE', /^CLAUDE_CODE_SYNC_/, /^CLAUDE_CODE_ARTIFACT/,
]

const HELP = `Usage: claude [options] [command] [prompt]

Claude Code (fake ${VERSION} for cc-rsi tests)

Options:
  -p, --print                           Print response and exit
  --output-format <format>              Output format: "text", "json", or "stream-json"
  --verbose                             Override verbose mode setting from config
  --include-hook-events                 Include all hook lifecycle events in the output stream
  --session-id <uuid>                   Use a specific session ID for the conversation
  -r, --resume [value]                  Resume a conversation by session ID
  --model <model>                       Model for the current session
  --effort <level>                      Effort level for the current session
  --restricted                          Restricted mode
  --setting-sources <sources>           Comma-separated list of setting sources to load
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --mcp-config <configs...>             Load MCP servers from JSON files or strings
  --disable-slash-commands              Disable all skills
  --append-system-prompt <prompt>       Append a system prompt (also --append-system-prompt-file)
  --settings <file-or-json>             Path to a settings JSON file or a JSON string
  --permission-mode <mode>              Permission mode to use for the session
  --tools <tools...>                    Specify the list of available tools
  --max-budget-usd <amount>             Maximum dollar amount to spend on API calls
  --no-session-persistence              Disable session persistence
  -v, --version                         Output the version number
  -h, --help                            Display help for command
`

// ---------------------------------------------------------------- process-wide state

const run = {
  ts: new Date().toISOString(),
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  envKeys: Object.keys(process.env).sort(),
  ccRsi: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CC_RSI_'))),
  stdinSha: null,
  sessionId: null,
  mode: null,
  exit: null,
  allowSeen: false,
  hooksRun: [],
}
let logFile = null
let finished = false
let outputFormat = 'text'
let buffering = true
const buffered = []
let activeChild = null
let session = null
let sessionPath = null
let persist = true
let turnInFlight = null

function writeAll(fd, text) {
  const buffer = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset)
    } catch (error) {
      if (error?.code !== 'EAGAIN') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}

function stderr(text) {
  writeAll(2, text.endsWith('\n') ? text : `${text}\n`)
}

/** Emits one stream-json event (buffered until the scenario has been consulted). */
function emit(event) {
  if (outputFormat !== 'stream-json') return
  if (buffering) buffered.push(event)
  else writeAll(1, `${JSON.stringify(event)}\n`)
}

function flush() {
  buffering = false
  for (const event of buffered.splice(0)) writeAll(1, `${JSON.stringify(event)}\n`)
}

function discardBuffer() {
  buffered.splice(0)
  buffering = false
}

function finish(code, extra = {}) {
  if (finished) return
  finished = true
  run.exit = code
  Object.assign(run, extra)
  if (logFile) {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${JSON.stringify(run)}\n`)
    } catch { /* logging must not change the outcome */ }
  }
  process.exit(code)
}

function saveSession() {
  if (!persist || !session || !sessionPath) return
  const tmp = `${sessionPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`)
  renameSync(tmp, sessionPath)
}

function onSignal(name, code) {
  try {
    if (activeChild) activeChild.kill('SIGKILL')
  } catch { /* gone */ }
  try {
    if (session && turnInFlight) {
      session.pendingInterrupted = { prompt: turnInFlight.prompt, toolUseId: turnInFlight.toolUseId ?? null, at: new Date().toISOString() }
      saveSession()
    }
  } catch { /* best effort */ }
  finish(code, { signal: name })
}

// ---------------------------------------------------------------- helpers

const sha256 = text => createHash('sha256').update(text).digest('hex')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sleep = ms => new Promise(r => setTimeout(r, ms))

function matchesAny(name, list) {
  return list.some(e => (typeof e === 'string' ? e === name : e.test(name)))
}

function loadConfig() {
  const env = process.env
  let file = {}
  const home = env.CC_RSI_HOME
  if (typeof home === 'string' && home !== '') {
    try { file = JSON.parse(readFileSync(join(home, 'fake-claude.json'), 'utf8')) } catch { file = {} }
  }
  const fakeHome = env.FAKE_CLAUDE_HOME || file.home || null
  const scenario = env.FAKE_CLAUDE_SCENARIO || file.scenario || null
  const log = env.FAKE_CLAUDE_LOG || file.log || (fakeHome ? join(fakeHome, 'log.jsonl') : null)
  const runHooksRaw = env.FAKE_CLAUDE_RUN_HOOKS ?? (file.runHooks === undefined ? undefined : String(file.runHooks))
  const runHooks = !(runHooksRaw === '0' || runHooksRaw === 'false')
  const sandboxRaw = env.FAKE_CLAUDE_SANDBOX ?? (file.sandbox === undefined ? undefined : String(file.sandbox))
  const sandboxAvailable = sandboxRaw === 'available' || sandboxRaw === 'true'
  return { fakeHome, scenario, log, runHooks, sandboxAvailable }
}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  let unknown = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) { unknown = unknown ?? `${a} (missing value)`; break }
      flags[a] = argv[++i]
      continue
    }
    if (BOOL_FLAGS.has(a)) { flags[a] = true; continue }
    if (a.startsWith('-') && a !== '-') { unknown = unknown ?? a; continue }
    positional.push(a)
  }
  return { flags, positional, unknown }
}

function readStdin() {
  return new Promise(resolvePromise => {
    const chunks = []
    process.stdin.on('data', c => chunks.push(c))
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
  })
}

function within(child, parent) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

// ---------------------------------------------------------------- hooks

function matcherMatches(matcher, value) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  if (value === undefined || value === null) return false
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map(s => s.trim()).filter(Boolean).includes(value)
  try {
    return new RegExp(matcher).test(value)
  } catch {
    return false
  }
}

function execHook(hook, payload, cwd) {
  return new Promise(resolvePromise => {
    const timeoutMs = (Number.isFinite(hook.timeout) && hook.timeout > 0 ? hook.timeout : 60) * 1000
    const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd }
    let child
    try {
      child = Array.isArray(hook.args)
        ? spawn(hook.command, hook.args.map(String), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('/bin/sh', ['-c', String(hook.command)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false, spawnError: true })
      return
    }
    const out = []
    const err = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* gone */ }
    }, timeoutMs)
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false, spawnError: true })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(payload))
  })
}

/**
 * Runs every matching hook of `event`. Returns {block, blockReason, allow, deny, denyReason, contexts}.
 */
async function runHooks(ctx, event, matchValue, payload, toolName) {
  const outcome = { block: false, blockReason: null, allow: false, deny: false, denyReason: null, contexts: [] }
  if (!ctx.cfg.runHooks) return outcome
  const groups = Array.isArray(ctx.settings?.hooks?.[event]) ? ctx.settings.hooks[event] : []
  for (const group of groups) {
    if (!matcherMatches(group?.matcher, matchValue)) continue
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') continue
      const hookId = randomUUID()
      const hookName = toolName ? `${event}:${toolName}` : event
      if (ctx.includeHookEvents) emit({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: hookName, hook_event: event, session_id: ctx.sessionId })
      const r = await execHook(hook, payload, ctx.cwd)
      let parsed = null
      const trimmed = r.stdout.trim()
      if (r.code === 0 && trimmed.startsWith('{')) {
        try { parsed = JSON.parse(trimmed) } catch { parsed = null }
      }
      const failed = r.code !== 0 && r.code !== 2
      const blockingFailure = failed && hook.onFailure === 'block'
      const display = [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])].join(' ')
      const record = { event, tool: toolName ?? undefined, exit: r.code }
      if (ctx.includeHookEvents) {
        emit({ type: 'system', subtype: 'hook_response', hook_id: hookId, hook_name: hookName, hook_event: event, output: r.stdout + r.stderr, stdout: r.stdout,
          stderr: r.stderr, exit_code: r.code, outcome: r.code === 0 ? 'success' : 'error', session_id: ctx.sessionId })
      }
      const failureText = `[${display}]: failed; blocking because onFailure is "block"\n${r.stderr}`.trimEnd()
      if (event === 'PreToolUse') {
        const decision = parsed?.hookSpecificOutput?.permissionDecision ?? (parsed?.decision === 'block' ? 'deny' : parsed?.decision === 'approve' ? 'allow' : null)
        const reason = parsed?.hookSpecificOutput?.permissionDecisionReason ?? parsed?.reason ?? ''
        if (r.code === 2) { outcome.deny = true; outcome.denyReason = outcome.denyReason ?? r.stderr.trim(); record.decision = 'deny' }
        else if (blockingFailure) { outcome.deny = true; outcome.denyReason = outcome.denyReason ?? failureText; record.decision = 'deny' }
        else if (decision === 'deny' || decision === 'ask') { outcome.deny = true; outcome.denyReason = outcome.denyReason ?? String(reason); record.decision = decision }
        else if (decision === 'allow') { outcome.allow = true; run.allowSeen = true; record.decision = 'allow' }
      } else if (event === 'UserPromptSubmit') {
        if (r.code === 2) { outcome.block = true; outcome.blockReason = outcome.blockReason ?? r.stderr.trim(); record.decision = 'block' }
        else if (blockingFailure) { outcome.block = true; outcome.blockReason = outcome.blockReason ?? failureText; record.decision = 'block' }
        else if (parsed?.decision === 'block') { outcome.block = true; outcome.blockReason = outcome.blockReason ?? String(parsed.reason ?? ''); record.decision = 'block' }
      }
      const extra = parsed?.hookSpecificOutput?.additionalContext
      if (typeof extra === 'string' && extra !== '') outcome.contexts.push({ event, text: extra })
      run.hooksRun.push(record)
    }
  }
  return outcome
}

// ---------------------------------------------------------------- permissions and tools

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const FILE_TOOLS = new Set([...WRITE_TOOLS, ...READ_TOOLS])

function toolPath(name, input, cwd) {
  const raw = name === 'NotebookEdit' ? input.notebook_path : (name === 'Glob' || name === 'Grep') ? (input.path ?? cwd) : input.file_path
  if (typeof raw !== 'string' || raw === '') return null
  return resolve(cwd, raw)
}

function ruleMatches(rule, name, path, command) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(String(rule))
  if (!m) return false
  const [, ruleTool, spec] = m
  const family = ruleTool === 'Edit' ? WRITE_TOOLS.has(name) : ruleTool === 'Read' && spec !== undefined ? READ_TOOLS.has(name) : ruleTool === name
  if (!family) return false
  if (spec === undefined || spec === '' || spec === '*') return true
  if (ruleTool === 'Bash') {
    const prefix = spec.endsWith(':*') ? spec.slice(0, -2) : spec
    return typeof command === 'string' && (spec.endsWith(':*') ? command.startsWith(prefix) : command === prefix)
  }
  if (spec.startsWith('//') && path) {
    const dir = spec.slice(1).replace(/\/\*\*$/, '').replace(/\/\*$/, '') || '/'
    return within(path, dir)
  }
  return false
}

function denyRuleFor(ctx, name, input, path) {
  const deny = Array.isArray(ctx.settings?.permissions?.deny) ? ctx.settings.permissions.deny : []
  const command = typeof input.command === 'string' ? input.command : undefined
  return deny.find(r => ruleMatches(r, name, path, command)) ?? null
}

function permitted(ctx, name, input, path, hookAllowed) {
  const perms = ctx.settings?.permissions ?? {}
  const allow = Array.isArray(perms.allow) ? perms.allow : []
  const deny = Array.isArray(perms.deny) ? perms.deny : []
  const command = typeof input.command === 'string' ? input.command : undefined
  if (deny.some(r => ruleMatches(r, name, path, command))) return false
  if (hookAllowed) return true
  return allow.some(r => ruleMatches(r, name, path, command))
}

function globToRegExp(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function walk(root, out = [], depth = 0) {
  if (depth > 20 || out.length > 5000) return out
  let names = []
  try { names = readdirSync(root) } catch { return out }
  for (const name of names.sort()) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(root, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out, depth + 1)
    else if (st.isFile()) out.push(full)
  }
  return out
}

function runBash(command, cwd) {
  return new Promise(resolvePromise => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    activeChild = child
    const out = []
    const err = []
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 30000)
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('error', error => {
      clearTimeout(timer)
      activeChild = null
      resolvePromise({ code: 127, stdout: '', stderr: String(error?.message ?? error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      activeChild = null
      resolvePromise({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** Executes one permitted tool call; returns {content, isError, response}. */
async function execute(name, input, cwd) {
  try {
    if (name === 'Bash') {
      const r = await runBash(String(input.command ?? ''), cwd)
      const content = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n') || (r.code === 0 ? '(no output)' : `exit ${r.code}`)
      return { content, isError: r.code !== 0, response: { stdout: r.stdout, stderr: r.stderr, interrupted: false, exitCode: r.code } }
    }
    const path = toolPath(name, input, cwd)
    if (name === 'Write') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, String(input.content ?? ''))
      return { content: `File created successfully at: ${path}`, isError: false, response: { type: 'create', filePath: path } }
    }
    if (name === 'Edit' || name === 'MultiEdit') {
      if (!existsSync(path)) return { content: 'File does not exist.', isError: true, response: { error: 'missing' } }
      let text = readFileSync(path, 'utf8')
      const edits = name === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []) : [input]
      for (const e of edits) {
        const oldS = String(e.old_string ?? '')
        const count = oldS === '' ? 0 : text.split(oldS).length - 1
        if (count === 0) return { content: 'String to replace not found in file.', isError: true, response: { error: 'not_found' } }
        if (count > 1 && !e.replace_all) return { content: `Found ${count} matches of the string to replace; set replace_all to replace all.`, isError: true, response: { error: 'ambiguous' } }
        text = e.replace_all ? text.split(oldS).join(String(e.new_string ?? '')) : text.replace(oldS, () => String(e.new_string ?? ''))
      }
      writeFileSync(path, text)
      return { content: `The file ${path} has been updated successfully.`, isError: false, response: { filePath: path } }
    }
    if (name === 'Read') {
      if (!existsSync(path)) return { content: 'File does not exist.', isError: true, response: { error: 'missing' } }
      const text = readFileSync(path, 'utf8')
      const numbered = text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')
      return { content: numbered, isError: false, response: { type: 'text', file: { filePath: path, content: text } } }
    }
    if (name === 'Glob') {
      const root = path ?? cwd
      const re = globToRegExp(String(input.pattern ?? '**'))
      const files = walk(root).filter(f => re.test(relative(root, f)))
      return { content: files.length ? files.join('\n') : 'No files found', isError: false, response: { filenames: files } }
    }
    if (name === 'Grep') {
      const root = path ?? cwd
      let re
      try { re = new RegExp(String(input.pattern ?? '')) } catch { return { content: 'Invalid regex', isError: true, response: { error: 'regex' } } }
      const files = walk(root).filter(f => { try { return re.test(readFileSync(f, 'utf8')) } catch { return false } })
      return { content: files.length ? `Found ${files.length} files\n${files.join('\n')}` : 'No files found', isError: false, response: { filenames: files } }
    }
    return { content: `${name} executed (fake: no effect)`, isError: false, response: { ok: true } }
  } catch (error) {
    return { content: `Error: ${error?.message ?? error}`, isError: true, response: { error: String(error?.message ?? error) } }
  }
}

function inputOf(action) {
  if (action.input && typeof action.input === 'object') return action.input
  const { tool, ...rest } = action
  return rest
}

// ---------------------------------------------------------------- main

function initEvent(ctx, override = {}) {
  return {
    type: 'system',
    subtype: 'init',
    cwd: ctx.cwd,
    session_id: ctx.sessionId,
    tools: override.tools ?? ctx.tools,
    mcp_servers: override.mcp_servers ?? [],
    model: ctx.model,
    permissionMode: override.permissionMode ?? ctx.permissionMode,
    slash_commands: [],
    apiKeySource: 'none',
    claude_code_version: VERSION,
    output_style: 'default',
    agents: [],
    skills: [],
    plugins: [],
    uuid: randomUUID(),
  }
}

function resultEvent(ctx, fields) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    session_id: ctx.sessionId,
    total_cost_usd: session?.cost ?? 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    permission_denials: [],
    terminal_reason: 'completed',
    safety_stops: 0,
    api_error_status: null,
    uuid: randomUUID(),
    ...fields,
  }
}

function finalOutput(ctx, result) {
  if (outputFormat === 'stream-json') emit(result)
  else if (outputFormat === 'json') writeAll(1, `${JSON.stringify(result)}\n`)
  else writeAll(1, `${result.result ?? ''}\n`)
}

const DEFAULT_SCENARIO = async () => ({ text: 'OK' })

async function loadScenario(path) {
  if (!path) return DEFAULT_SCENARIO
  const mod = await import(pathToFileURL(path).href)
  const fn = mod.default ?? mod.respond
  if (typeof fn !== 'function') throw new Error(`scenario ${path} has no default export function`)
  return fn
}

export async function main() {
  process.on('SIGINT', () => onSignal('SIGINT', 130))
  process.on('SIGTERM', () => onSignal('SIGTERM', 143))
  const argv = process.argv.slice(2)
  if (argv.includes('--version') || argv.includes('-v')) {
    writeAll(1, `${VERSION} (Claude Code)\n`)
    process.exit(0)
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    writeAll(1, HELP)
    process.exit(0)
  }
  const cfg = loadConfig()
  logFile = cfg.log
  const { flags, positional, unknown } = parseArgs(argv)
  outputFormat = flags['--output-format'] ?? 'text'
  run.mode = flags['--session-id'] !== undefined ? 'new' : flags['--resume'] !== undefined ? 'resume' : null
  run.sessionId = flags['--session-id'] ?? flags['--resume'] ?? null
  if (unknown) {
    stderr(`error: unknown option '${unknown}'`)
    return finish(1)
  }
  if (positional.length > 0) {
    stderr('FAKE: positional prompt')
    return finish(2)
  }
  if (!flags['-p'] && !flags['--print']) {
    stderr('FAKE: -p is required')
    return finish(2)
  }
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith('CC_RSI_') && matchesAny(name, NEVER)) {
      stderr(`FAKE: forbidden env ${name}`)
      return finish(3)
    }
  }
  for (const name of ['CC_RSI_ROLE', 'CC_RSI_EXPECT']) {
    if (!process.env[name]) {
      stderr(`FAKE: missing env ${name}`)
      return finish(3)
    }
  }
  if (process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS !== '1') {
    stderr('FAKE: missing env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1')
    return finish(3)
  }
  if (!cfg.fakeHome) {
    stderr('FAKE: no fake home configured (FAKE_CLAUDE_HOME or $CC_RSI_HOME/fake-claude.json)')
    return finish(4)
  }
  const prompt = await readStdin()
  run.stdinSha = sha256(prompt)
  if (prompt === '') {
    stderr('Error: Input must be provided either through stdin or as a prompt argument when using --print')
    return finish(1)
  }

  // Settings (inline JSON or a file) and the sandbox gate (f2: before any session or model call).
  let settings = {}
  const settingsArg = flags['--settings']
  if (settingsArg !== undefined) {
    try {
      settings = JSON.parse(settingsArg.trim().startsWith('{') ? settingsArg : readFileSync(settingsArg, 'utf8'))
    } catch (error) {
      stderr(`Error: Invalid settings: ${error?.message ?? error}`)
      return finish(1)
    }
  }
  if (settings?.sandbox?.enabled && settings.sandbox.failIfUnavailable && !cfg.sandboxAvailable) {
    stderr('Error: sandbox required but unavailable: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed. sandbox.failIfUnavailable is set — refusing to start without a working sandbox.')
    return finish(1)
  }
  let systemPrompt = ''
  if (flags['--append-system-prompt-file'] !== undefined) {
    try {
      systemPrompt = readFileSync(flags['--append-system-prompt-file'], 'utf8')
    } catch (error) {
      stderr(`Error: could not read the system prompt file: ${error?.message ?? error}`)
      return finish(1)
    }
  }
  const maxTurns = flags['--max-turns'] !== undefined ? Number.parseInt(flags['--max-turns'], 10) : Infinity
  if (flags['--max-turns'] !== undefined && !(maxTurns > 0)) {
    stderr(`error: option '--max-turns <turns>' argument '${flags['--max-turns']}' is invalid`)
    return finish(1)
  }

  // Sessions (R3/R4).
  persist = !flags['--no-session-persistence']
  const sessionsDir = join(cfg.fakeHome, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const cwd = process.cwd()
  let sessionId
  if (flags['--session-id'] !== undefined) {
    sessionId = flags['--session-id']
    run.mode = 'new'
    run.sessionId = sessionId
    if (!UUID_RE.test(sessionId)) {
      stderr('Error: Invalid session ID. Must be a valid UUID.')
      return finish(1)
    }
    sessionPath = join(sessionsDir, `${sessionId}.json`)
    session = { id: sessionId, cwd, turns: [], pendingInterrupted: null, cost: 0, toolSeq: 0, createdAt: new Date().toISOString() }
    if (persist) {
      try {
        const fd = openSync(sessionPath, 'wx')
        writeSync(fd, `${JSON.stringify(session, null, 2)}\n`)
        closeSync(fd)
      } catch (error) {
        if (error?.code === 'EEXIST') {
          stderr(`Error: Session ID ${sessionId} is already in use.`)
          return finish(1)
        }
        throw error
      }
    } else if (existsSync(sessionPath)) {
      stderr(`Error: Session ID ${sessionId} is already in use.`)
      return finish(1)
    }
  } else if (flags['--resume'] !== undefined) {
    sessionId = flags['--resume']
    run.mode = 'resume'
    run.sessionId = sessionId
    sessionPath = join(sessionsDir, `${sessionId}.json`)
    let loaded = null
    try { loaded = JSON.parse(readFileSync(sessionPath, 'utf8')) } catch { loaded = null }
    if (!loaded) {
      const r3 = { type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0, stop_reason: null,
        session_id: sessionId, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: randomUUID(),
        errors: [`No conversation found with session ID: ${sessionId}`] }
      if (outputFormat !== 'text') writeAll(1, `${JSON.stringify(r3)}\n`)
      stderr(`No conversation found with session ID: ${sessionId}`)
      return finish(1)
    }
    session = loaded
    if (session.pendingInterrupted) {
      session.turns.push({ n: session.turns.length + 1, interrupted: true, toolUseId: session.pendingInterrupted.toolUseId ?? null, prompt: session.pendingInterrupted.prompt ?? null, text: null, actions: 0 })
      session.pendingInterrupted = null
      saveSession()
    }
  } else {
    stderr('FAKE: missing --session-id/--resume (every role context must name its session)')
    return finish(2)
  }

  const tools = flags['--tools'] === undefined ? ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'] : flags['--tools'].split(/[,\s]+/).filter(Boolean)
  const ctx = {
    cfg,
    settings,
    cwd,
    sessionId,
    tools,
    model: flags['--model'] ?? 'fake-default-model',
    permissionMode: flags['--permission-mode'] ?? 'default',
    includeHookEvents: Boolean(flags['--include-hook-events']),
    restricted: Boolean(flags['--restricted']),
  }
  const transcriptPath = join(cfg.fakeHome, 'transcripts', `${sessionId}.jsonl`)
  const promptId = randomUUID()
  const basePayload = { session_id: sessionId, transcript_path: transcriptPath, cwd, prompt_id: promptId, permission_mode: ctx.permissionMode }
  const turn = session.turns.filter(t => !t.interrupted).length + 1
  const turnRecord = { n: session.turns.length + 1, turn, prompt, text: null, actions: 0, contexts: [], recovering: /HARNESS RECOVERY/.test(prompt) }
  turnInFlight = { prompt }

  // UserPromptSubmit (fires before the model; F6/R2: prompt is byte-identical to stdin).
  const ups = await runHooks(ctx, 'UserPromptSubmit', null, { ...basePayload, hook_event_name: 'UserPromptSubmit', prompt }, null)
  if (ups.block) {
    const text = `UserPromptSubmit operation blocked by hook:\n${ups.blockReason ?? ''}\n\nOriginal prompt: ${prompt}`
    emit(initEvent(ctx))
    emit({ type: 'system', subtype: 'informational', content: text, level: 'warning', prevent_continuation: true, uuid: randomUUID(), session_id: sessionId })
    flush()
    finalOutput(ctx, resultEvent(ctx, { is_error: false, num_turns: 0, stop_reason: null, result: text }))
    turnInFlight = null
    saveSession()
    return finish(0)
  }
  turnRecord.contexts.push(...ups.contexts)

  // The scenario decides the model's behaviour.
  let response
  try {
    const respond = await loadScenario(cfg.scenario)
    response = await respond({
      role: process.env.CC_RSI_ROLE,
      sessionId,
      turn,
      prompt,
      history: JSON.parse(JSON.stringify(session.turns)),
      cwd,
      env: process.env,
      flags,
      recovering: /HARNESS RECOVERY/.test(prompt),
      fakeHome: cfg.fakeHome,
      settings,
      model: ctx.model,
      systemPrompt,
    })
  } catch (error) {
    discardBuffer()
    stderr(`FAKE: scenario error: ${error?.stack ?? error}`)
    return finish(5, { scenarioError: String(error?.message ?? error) })
  }
  if (!response || typeof response !== 'object') response = { text: String(response ?? '') }
  run.response = Object.keys(response)

  if (response.crash === 'before-init' || typeof response.stderrOnly === 'string') {
    // Nothing reached the transcript: a session created by this invocation does not persist (a later
    // --resume of it is R3), exactly like a start that fails before system/init.
    discardBuffer()
    stderr(typeof response.stderrOnly === 'string' ? response.stderrOnly : (response.stderr ?? 'FAKE: crashed before init'))
    turnInFlight = null
    if (run.mode === 'new' && persist && sessionPath && session && session.turns.length === 0) {
      try { rmSync(sessionPath, { force: true }) } catch { /* best effort */ }
    }
    return finish(Number.isInteger(response.exit) ? response.exit : 1)
  }
  if (typeof response.model === 'string' && response.model !== '') ctx.model = response.model
  // Real order with --include-hook-events: UserPromptSubmit hook events, then system/init (WP4 probe V4).
  emit(initEvent(ctx, response.initOverride ?? {}))
  flush()

  if (response.crash === 'after-init') {
    turnRecord.crashed = true
    session.turns.push(turnRecord)
    turnInFlight = null
    saveSession()
    stderr(response.stderr ?? 'FAKE: crashed after init')
    return finish(Number.isInteger(response.exit) ? response.exit : 1)
  }

  if (response.apiError) {
    // F3 shape: a synthetic assistant message carrying `error`, and a result with is_error:true.
    const status = Number.isInteger(response.apiError.status) ? response.apiError.status : 500
    const error = String(response.apiError.error ?? 'api_error')
    const text = response.apiError.text ?? `API Error: ${status} ${error}`
    emit({ type: 'assistant', message: { id: randomUUID(), type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }],
      stop_reason: 'stop_sequence', usage: {} }, parent_tool_use_id: null, session_id: sessionId, error, is_api_error_message: true, uuid: randomUUID() })
    turnRecord.apiError = { status, error }
    session.turns.push(turnRecord)
    turnInFlight = null
    saveSession()
    finalOutput(ctx, resultEvent(ctx, { is_error: true, num_turns: 1, result: text, stop_reason: 'stop_sequence', terminal_reason: 'api_error', api_error_status: status }))
    return finish(1)
  }

  if (typeof response.resultSubtype === 'string') {
    turnRecord.resultSubtype = response.resultSubtype
    session.turns.push(turnRecord)
    turnInFlight = null
    saveSession()
    finalOutput(ctx, resultEvent(ctx, { subtype: response.resultSubtype, is_error: true, num_turns: 1, result: undefined, stop_reason: null,
      terminal_reason: response.resultSubtype, errors: [] }))
    return finish(1)
  }

  if (Number.isFinite(response.hangMs) && response.hangMs > 0) await sleep(response.hangMs)

  const actions = Array.isArray(response.actions) ? response.actions : []
  if (response.crash === 'mid-tool') {
    const action = actions[0] ?? { tool: 'Bash', command: 'true' }
    const id = `toolu_fake_${++session.toolSeq}`
    emit({ type: 'assistant', message: { id: `msg_${turn}_1`, type: 'message', role: 'assistant', model: ctx.model,
      content: [{ type: 'tool_use', id, name: action.tool, input: inputOf(action) }], stop_reason: null }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() })
    session.pendingInterrupted = { prompt, toolUseId: id, at: new Date().toISOString() }
    turnInFlight = null
    saveSession()
    stderr(response.stderr ?? 'FAKE: killed mid-tool')
    return finish(Number.isInteger(response.exit) ? response.exit : 137)
  }

  const denials = []
  let executed = 0
  let maxTurnsHit = false
  let k = 0
  for (const action of actions) {
    if (k >= maxTurns) {
      maxTurnsHit = true
      break
    }
    k++
    const name = String(action.tool ?? '')
    const input = inputOf(action)
    const id = `toolu_fake_${++session.toolSeq}`
    turnInFlight = { prompt, toolUseId: id }
    emit({ type: 'assistant', message: { id: `msg_${turn}_${k}`, type: 'message', role: 'assistant', model: ctx.model,
      content: [{ type: 'tool_use', id, name, input }], stop_reason: null }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() })
    session.cost = Math.round(((session.cost ?? 0) + 0.001) * 1e6) / 1e6
    executed++
    const result = (content, isError) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
      parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() })
    if (!tools.includes(name)) {
      result(`No such tool available: ${name}`, true)
      continue
    }
    const path = FILE_TOOLS.has(name) ? toolPath(name, input, cwd) : null
    // Deny rules apply before any PreToolUse hook (WP4 probe on 2.1.296: the denied call reaches no hook).
    const rule = denyRuleFor(ctx, name, input, path)
    if (rule) {
      result(rule.includes('(') ? '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>'
        : `Permission to use ${name} has been denied.`, true)
      denials.push({ tool_name: name, tool_use_id: id, tool_input: input })
      continue
    }
    const pre = await runHooks(ctx, 'PreToolUse', name, { ...basePayload, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id }, name)
    if (pre.deny) {
      result(`PreToolUse:${name} hook error: ${pre.denyReason ?? ''}`, true)
      denials.push({ tool_name: name, tool_use_id: id, tool_input: input })
      continue
    }
    if (ctx.permissionMode === 'dontAsk' && !permitted(ctx, name, input, path, pre.allow)) {
      result(`Permission to use ${name} has been denied because Claude Code is running in don't ask mode.`, true)
      denials.push({ tool_name: name, tool_use_id: id, tool_input: input })
      continue
    }
    if (ctx.restricted && FILE_TOOLS.has(name)) {
      const dirs = [cwd, ...(Array.isArray(settings?.permissions?.additionalDirectories) ? settings.permissions.additionalDirectories : [])]
      if (!path || !dirs.some(d => within(path, d))) {
        result(`${path ?? '(no path)'} is outside ${cwd}; --restricted confines the file tools to the working directory.`, true)
        denials.push({ tool_name: name, tool_use_id: id, tool_input: input })
        continue
      }
    }
    const r = await execute(name, input, cwd)
    result(r.content, r.isError)
    const post = await runHooks(ctx, 'PostToolUse', name, { ...basePayload, hook_event_name: 'PostToolUse', tool_name: name, tool_input: input, tool_use_id: id, tool_response: r.response }, name)
    turnRecord.contexts.push(...post.contexts)
  }
  turnInFlight = { prompt }
  turnRecord.actions = executed

  if (maxTurnsHit) {
    session.turns.push(turnRecord)
    turnInFlight = null
    saveSession()
    finalOutput(ctx, resultEvent(ctx, { subtype: 'error_max_turns', is_error: true, num_turns: executed + 1, result: undefined, stop_reason: null,
      terminal_reason: 'max_turns', permission_denials: denials, errors: [] }))
    return finish(1)
  }

  if (response.compact) {
    emit({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'auto' }, uuid: randomUUID() })
    const pin = await runHooks(ctx, 'SessionStart', 'compact', { session_id: sessionId, transcript_path: transcriptPath, cwd, hook_event_name: 'SessionStart', source: 'compact' }, null)
    turnRecord.contexts.push(...pin.contexts)
    turnRecord.compacted = true
  }

  const text = typeof response.text === 'string' ? response.text : ''
  const stopReason = typeof response.stopReason === 'string' ? response.stopReason : 'end_turn'
  emit({ type: 'assistant', message: { id: `msg_${turn}_${k + 1}`, type: 'message', role: 'assistant', model: ctx.model,
    content: [{ type: 'text', text }], stop_reason: stopReason }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() })
  session.cost = Math.round(((session.cost ?? 0) + 0.001) * 1e6) / 1e6
  turnRecord.text = text
  session.turns.push(turnRecord)
  turnInFlight = null
  saveSession()
  finalOutput(ctx, resultEvent(ctx, { result: text, num_turns: executed + 1, stop_reason: stopReason, permission_denials: denials, total_cost_usd: session.cost }))
  if (response.crash === 'after-result') {
    stderr(response.stderr ?? 'FAKE: crashed after the result')
    return finish(Number.isInteger(response.exit) ? response.exit : 1)
  }
  return finish(0)
}

// Allow `node claude.mjs …` as well as the CommonJS launcher.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    process.stderr.write(`FAKE: internal error: ${error?.stack ?? error}\n`)
    process.exit(70)
  })
}

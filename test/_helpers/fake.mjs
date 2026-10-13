// Fake-claude setup for tests (SPEC §15.1 `test/_helpers/fake.mjs`, WP4).
//
// The runtime passes an allowlisted environment to role children (SPEC §10.5), so FAKE_CLAUDE_*
// variables would not reach the fake through RoleContext. Besides the env below, `fakeClaude`
// therefore writes `<home>/fake-claude.json`, which the fake reads through CC_RSI_HOME (always set
// explicitly for role children).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the fake `claude` launcher. */
export const FAKE_CLAUDE_BIN = resolve(HERE, '..', 'fake-claude', 'claude')

/** Absolute path of a base scenario shipped with the fake (`test/fake-claude/scenarios/<name>.mjs`). */
export function scenarioPath(name) {
  return resolve(HERE, '..', 'fake-claude', 'scenarios', name.endsWith('.mjs') ? name : `${name}.mjs`)
}

/**
 * Writes the data script read by `scenarios/scripted.mjs`:
 * `{ "<role>" | "*": { turns: [response, …], default: response } }` (see that scenario).
 * `fake` is a `fakeClaude()` result (or its `fakeHome` string).
 */
export function writeScript(fake, script) {
  const fakeHome = typeof fake === 'string' ? fake : fake.fakeHome
  writeFileSync(join(fakeHome, 'script.json'), `${JSON.stringify(script, null, 2)}\n`)
}

function readLog(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { out.push(JSON.parse(line)) } catch { /* torn line */ }
  }
  return out
}

/**
 * `fakeClaude({ scenario, home, runHooks = true, sandbox = 'unavailable' })` →
 * `{ env, bin, log, reset, fakeHome, logFile, sessions, session(id), config }`.
 *  - `env`: process.env (minus CC_RSI_ROLE/CLAUDECODE) + CC_RSI_HOME, CC_RSI_CLAUDE_BIN, FAKE_CLAUDE_HOME,
 *    FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_LOG (and FAKE_CLAUDE_RUN_HOOKS / FAKE_CLAUDE_SANDBOX when set);
 *  - `config`: a config fragment `{children: {claudeBin}}` to merge into a RoleSpec or lineage config;
 *  - `log()`: the parsed invocation log; `reset()`: clears the log and every stored session;
 *  - `sessions()`: ids of stored sessions; `session(id)`: a stored session record or null.
 * `home` (the test's CC_RSI_HOME) is required so role children find `<home>/fake-claude.json`.
 * Calling `fakeClaude` again for the same home replaces the configuration (e.g. a new scenario).
 */
export async function fakeClaude({ scenario, home, runHooks = true, sandbox = 'unavailable' } = {}) {
  if (typeof home !== 'string' || home === '') throw new TypeError('fakeClaude: home (the test CC_RSI_HOME) is required')
  const fakeHome = await tmpDir('cc-rsi-fake-claude-')
  const logFile = join(fakeHome, 'log.jsonl')
  const sessionsDir = join(fakeHome, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const scenarioAbs = scenario ? resolve(scenario) : null
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'fake-claude.json'), `${JSON.stringify({ home: fakeHome, scenario: scenarioAbs, log: logFile, runHooks, sandbox }, null, 2)}\n`)
  const env = { ...process.env, CC_RSI_HOME: home, CC_RSI_CLAUDE_BIN: FAKE_CLAUDE_BIN, FAKE_CLAUDE_HOME: fakeHome, FAKE_CLAUDE_LOG: logFile }
  delete env.FAKE_CLAUDE_SCENARIO
  delete env.FAKE_CLAUDE_RUN_HOOKS
  delete env.FAKE_CLAUDE_SANDBOX
  if (scenarioAbs) env.FAKE_CLAUDE_SCENARIO = scenarioAbs
  if (!runHooks) env.FAKE_CLAUDE_RUN_HOOKS = '0'
  if (sandbox === 'available') env.FAKE_CLAUDE_SANDBOX = 'available'
  delete env.CC_RSI_ROLE
  delete env.CLAUDECODE
  return {
    env,
    bin: FAKE_CLAUDE_BIN,
    fakeHome,
    logFile,
    config: { children: { claudeBin: FAKE_CLAUDE_BIN } },
    log: () => readLog(logFile),
    reset() {
      rmSync(logFile, { force: true })
      rmSync(sessionsDir, { recursive: true, force: true })
      mkdirSync(sessionsDir, { recursive: true })
    },
    sessions() {
      try {
        return readdirSync(sessionsDir).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort()
      } catch {
        return []
      }
    },
    session(id) {
      try {
        return JSON.parse(readFileSync(join(sessionsDir, `${id}.json`), 'utf8'))
      } catch {
        return null
      }
    },
  }
}

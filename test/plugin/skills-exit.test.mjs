// Skill `!` injection and exit codes (cc-integration-4): Claude Code aborts the whole skill on any
// non-zero exit of an injected command, so Claude never sees the skill's instructions. Every skill
// therefore runs the CLI with --report-exit, which reports the real status as a last
// `[cc-rsi exit N]` line and exits 0. Each skill's injected command line is run here through sh, as
// Claude Code runs it (CLAUDECODE set), on its blocker, FAIL and refusal paths.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { projectKey, projectLayout } from '../../lib/core/paths.mjs'
import { MemoryStore } from '../../lib/memory/store.mjs'
import { projectRoot as gitProjectRoot } from '../../lib/workspace/git.mjs'
import { gitRepo, tmpDir, tmpHome } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SID = '33333333-4444-4555-8666-777777777777'

/** `{ injection, allowed }` of a skill: its single `!` command and its allowed-tools rule. */
function skillCommand(name) {
  const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')
  const injection = /^!`([^`]+)`$/m.exec(text)[1]
  const allowed = /^allowed-tools: Bash\((.+)\)$/m.exec(text)[1]
  return { injection, allowed }
}

/** The command line Claude Code runs: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SESSION_ID}` and `$ARGUMENTS` substituted. */
function expand(template, args) {
  return template.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT).replaceAll('${CLAUDE_SESSION_ID}', SID).replaceAll('$ARGUMENTS', args)
}

/** Whether `command` matches a Bash permission rule `prefix *` (prefix + space + anything) or an exact rule. */
function ruleMatches(rule, command) {
  const expanded = rule.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT)
  return expanded.endsWith(' *') ? command.startsWith(expanded.slice(0, -1)) : command === expanded
}

async function hermetic() {
  const { home, env } = await tmpHome()
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_') || name.startsWith('CC_RSI_') || name === 'CLAUDE_CODE_EXECPATH' || name === 'ANTHROPIC_MODEL') delete env[name]
  }
  env.CC_RSI_HOME = home
  env.CLAUDE_CONFIG_DIR = await tmpDir('cc-rsi-claude-config-')
  // Skill injection runs inside Claude Code.
  env.CLAUDECODE = '1'
  chmodSync(home, 0o700)
  const repo = await gitRepo({ 'a.txt': 'a\n' })
  return { home, env, repo }
}

/** Runs a skill's injected command line through sh in `repo`; `{ code, stdout, stderr, command }`. */
function runSkill(name, args, { env, repo }) {
  const { injection, allowed } = skillCommand(name)
  const command = expand(injection, args)
  assert.ok(ruleMatches(allowed, command), `${name}: allowed-tools ${allowed} must match ${command}`)
  const r = spawnSync('sh', ['-c', command], { cwd: repo, env, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, command }
}

function lastLine(text) {
  const lines = text.trimEnd().split('\n')
  return lines[lines.length - 1]
}

describe('skill injection never fails on cc-rsi exit codes (cc-integration-4)', () => {
  it('every skill passes --report-exit and its allowed-tools rule still matches', () => {
    for (const name of ['doctor', 'explore', 'freeze', 'memory', 'status']) {
      const { injection, allowed } = skillCommand(name)
      assert.match(injection, / --report-exit( |$)/, name)
      assert.ok(ruleMatches(allowed, expand(injection, 'list')), `${name}: ${allowed}`)
    }
  })

  it('explore: a preflight with blockers reports exit 3 in-band and the skill command exits 0', async () => {
    const s = await hermetic()
    const r = runSkill('explore', 'preflight --phase broad', s)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(lastLine(r.stdout), '[cc-rsi exit 3]', r.stdout + r.stderr)
    assert.match(r.stdout, /BLOCKERS:/)
    const listed = runSkill('explore', 'list', s)
    assert.equal(listed.code, 0)
    assert.equal(lastLine(listed.stdout), '[cc-rsi exit 0]')
    // A human-only subcommand typed into the skill: refused in-band (65), still exit 0.
    const human = runSkill('explore', 'abandon broad-1', s)
    assert.equal(human.code, 0)
    assert.equal(lastLine(human.stdout), '[cc-rsi exit 65]')
    assert.match(human.stderr, /is human-only/)
  })

  it('doctor: a FAIL check reports exit 1 in-band', async () => {
    const s = await hermetic()
    writeFileSync(join(s.home, 'config.json'), JSON.stringify({ children: { claudeBin: '/nonexistent/claude' } }))
    const r = runSkill('doctor', '', s)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^FAIL claude: /m)
    assert.equal(lastLine(r.stdout), '[cc-rsi exit 1]')
  })

  it('memory: a missing file and a human-only subcommand report their exit codes in-band', async () => {
    const s = await hermetic()
    const missing = runSkill('memory', 'show nope.md', s)
    assert.equal(missing.code, 0, missing.stdout + missing.stderr)
    assert.equal(lastLine(missing.stdout), '[cc-rsi exit 1]')
    const human = runSkill('memory', 'unfreeze', s)
    assert.equal(human.code, 0)
    assert.equal(lastLine(human.stdout), '[cc-rsi exit 65]')
  })

  it('freeze: success and a refusal on tampered memory both reach Claude', async () => {
    const s = await hermetic()
    const pl = projectLayout(s.home, projectKey(await gitProjectRoot(s.repo)))
    const store = await MemoryStore.open(pl.store, { sessionsDir: pl.sessions, lineagesDir: pl.lineages })
    const draft = await store.openDraft('ep-1', { owner: { kind: 'engine', pid: process.pid } })
    writeFileSync(join(draft.dir, 'a.md'), 'a\n')
    await store.commit('ep-1', { kind: 'practice', outcome: 'PASS' })
    await store.close()
    writeFileSync(join(pl.store, 'memory', 'planted.md'), 'x\n')
    const refused = runSkill('freeze', '', s)
    assert.equal(refused.code, 0, refused.stdout + refused.stderr)
    assert.equal(lastLine(refused.stdout), '[cc-rsi exit 3]')
    const clean = await hermetic()
    const ok = runSkill('freeze', '', clean)
    assert.equal(ok.code, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /memory frozen at tree /)
    assert.equal(lastLine(ok.stdout), '[cc-rsi exit 0]')
  })

  it('status reports its exit code in-band', async () => {
    const s = await hermetic()
    const r = runSkill('status', '', s)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(lastLine(r.stdout), '[cc-rsi exit 0]')
  })
})

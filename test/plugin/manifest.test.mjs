// Plugin and marketplace manifests, skills and package.json (SPEC §3, §13.3, §13.7, §14.1, J2-10/J2-11).

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const json = rel => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
const CLI = 'node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi"'

/** `{ frontmatter: {key: value}, body }` of a SKILL.md (simple `key: value` YAML lines). */
function skill(name) {
  const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  assert.ok(m, `${name}: frontmatter`)
  const frontmatter = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    let value = line.slice(i + 1).trim()
    if (/^".*"$/.test(value)) value = JSON.parse(value)
    frontmatter[line.slice(0, i).trim()] = value
  }
  return { frontmatter, body: m[2], text }
}

describe('plugin.json', () => {
  const manifest = json('.claude-plugin/plugin.json')
  it('has the identity fields of SPEC §13.7 and no component path keys', () => {
    assert.equal(manifest.name, 'cc-rsi')
    assert.equal(manifest.displayName, 'cc-rsi — recursive self-improvement')
    assert.deepEqual(manifest.author, { name: 'mutsuki14', url: 'https://github.com/mutsuki14' })
    assert.equal(manifest.homepage, 'https://github.com/mutsuki14/CC-RSI')
    assert.equal(manifest.repository, 'https://github.com/mutsuki14/CC-RSI')
    assert.equal(manifest.license, 'Apache-2.0')
    assert.deepEqual(manifest.keywords, ['self-improvement', 'verifier', 'memory', 'curriculum', 'rsi', 'rsiagent'])
    assert.match(manifest.description, /^RSIAgent-style recursive self-improvement for Claude Code/)
    for (const key of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'workflows', 'settings', 'bin']) {
      assert.equal(Object.prototype.hasOwnProperty.call(manifest, key), false, `no ${key} key: the default locations are used`)
    }
    // A semver version is present because `claude plugin validate --strict` warns without one.
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  })

  it('declares exactly the three userConfig keys of SPEC §14.1', () => {
    assert.deepEqual(Object.keys(manifest.userConfig), ['verifier_model', 'stop_policy', 'sandbox'])
    assert.deepEqual(manifest.userConfig.verifier_model, {
      type: 'string', title: 'Verifier model',
      description: 'Alias (opus, sonnet, haiku, fable) or full model id for the independent Verifier. Empty: the session\'s model.', default: '',
    })
    assert.deepEqual(manifest.userConfig.stop_policy, {
      type: 'string', title: 'Stop policy', options: ['off', 'nudge', 'gate'], default: 'nudge',
      description: 'off: never remind. nudge: remind once before finishing unverified or unlearned work. gate: block finishing unverified work up to 3 times.',
    })
    assert.deepEqual(manifest.userConfig.sandbox, {
      type: 'string', title: 'OS sandbox for role children', options: ['auto', 'require', 'off'], default: 'auto',
      description: 'auto: use the Claude Code sandbox when it works, otherwise degrade explicitly (shown at session start). require: refuse to run Verifier and lineage children without it. off: never use it.',
    })
    for (const option of Object.values(manifest.userConfig)) {
      for (const field of ['type', 'title', 'description']) assert.equal(typeof option[field], 'string')
    }
  })
})

describe('marketplace.json', () => {
  it('is a single-plugin marketplace whose entry is the repository root', () => {
    const m = json('.claude-plugin/marketplace.json')
    assert.equal(m.name, 'cc-rsi')
    assert.deepEqual(m.owner, { name: 'mutsuki14', url: 'https://github.com/mutsuki14' })
    assert.equal(m.description, 'Single-plugin marketplace for cc-rsi.')
    assert.equal(m.plugins.length, 1)
    assert.deepEqual(m.plugins[0], { name: 'cc-rsi', source: './', description: 'Independent Verifier, verified experience memory and exploration lineages for Claude Code (after RSIAgent).' })
    assert.equal(m.plugins[0].version, undefined, 'the version lives in plugin.json only')
  })
})

describe('skills', () => {
  it('ships exactly the five skills; only status is model-invocable', () => {
    assert.deepEqual(readdirSync(join(ROOT, 'skills')).sort(), ['doctor', 'explore', 'freeze', 'memory', 'status'])
    assert.equal(existsSync(join(ROOT, 'commands')), false)
    assert.equal(existsSync(join(ROOT, 'agents')), false)
    for (const name of ['doctor', 'explore', 'freeze', 'memory', 'status']) {
      const { frontmatter, body } = skill(name)
      assert.equal(frontmatter.name, name)
      assert.ok(frontmatter.description && frontmatter.description.length > 20)
      assert.equal(frontmatter['disable-model-invocation'], name === 'status' ? undefined : 'true', name)
      // J2-10: every injection calls the quoted bin through node; allowed-tools uses the same quoted form.
      const injections = [...body.matchAll(/!`([^`]+)`/g)].map(m => m[1])
      assert.equal(injections.length, 1, name)
      assert.ok(injections[0].startsWith(`${CLI} `), injections[0])
      assert.ok(frontmatter['allowed-tools'].startsWith(`Bash(${CLI} `), frontmatter['allowed-tools'])
      // No human-only command is reachable from a skill.
      assert.doesNotMatch(injections[0], /\b(eval|unfreeze|restore|import|accept-external|prune|abandon|release-lock|cancel)\b/)
    }
  })

  it('status, explore and memory are verbatim (SPEC §13.3, with --report-exit: cc-integration-4)', () => {
    assert.equal(skill('status').text, `---
name: status
description: Show cc-rsi state for this project — memory size and integrity, frozen/sealed flags, the current task's independent-verification state, and running or paused exploration lineages. Never shows sealed evaluation scores.
allowed-tools: Bash(node "\${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status *)
---
!\`node "\${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status --report-exit --session \${CLAUDE_SESSION_ID}\`

Summarise the status above for the user in a few short lines (the last line \`[cc-rsi exit N]\` is the exit status; non-zero means the status could not be read). Do not run further commands.
`)
    assert.equal(skill('explore').text, `---
name: explore
description: Start, inspect, pause or resume cc-rsi exploration lineages — Phase 1 broad waves, Phase 2 deep target/practice, Phase 3 frozen attempts — which run in the background as headless Claude Code children.
argument-hint: "preflight|start|status|log|stop|resume|show|list … (e.g. start --phase broad --direction-file ideas.md --yes)"
disable-model-invocation: true
allowed-tools: Bash(node "\${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" explore *)
---
!\`node "\${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" explore --report-exit $ARGUMENTS --session \${CLAUDE_SESSION_ID}\`

Report the output above to the user faithfully. Its last line \`[cc-rsi exit N]\` is the exit status: 0 ok, 1 error, 2 usage, 3 refused by the BLOCKERS listed (explain how to resolve each), 65 human-only (the user must run it in a terminal). If it is a preflight without blockers, tell the user to re-run with --yes to launch. Do not poll; the user can run /cc-rsi:explore status later.
`)
    assert.equal(skill('memory').text, `---
name: memory
description: Inspect the cc-rsi project memory (inventory, history, integrity). Read-only.
argument-hint: "show [path] | inventory | history | verify"
disable-model-invocation: true
allowed-tools: Bash(node "\${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory *)
---
!\`node "\${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory --report-exit $ARGUMENTS\`

Relay the output to the user. Its last line \`[cc-rsi exit N]\` is the exit status: 0 ok, 1 error (for verify: tampered memory, see the remedy above), 2 usage, 3 refused, 65 human-only (the user must run it in a terminal).
`)
    const freeze = skill('freeze')
    assert.equal(freeze.frontmatter['allowed-tools'], 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory freeze --report-exit)')
    assert.match(freeze.body, /^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/cc-rsi" memory freeze --report-exit`\n\nThe last line `\[cc-rsi exit N\]` is the exit status\. On exit 0 tell the user memory is now frozen \(Phase-3 reuse\); unfreezing is human-only: run `cc-rsi memory unfreeze` in a terminal\. Otherwise memory was not frozen: relay the reason above\.\n$/)
    const doctor = skill('doctor')
    assert.equal(doctor.frontmatter['argument-hint'], '[--live]')
    assert.match(doctor.body, /^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/cc-rsi" doctor --report-exit \$ARGUMENTS --session \$\{CLAUDE_SESSION_ID\}`\n\nThe last line `\[cc-rsi exit N\]` is the command's exit status \(0: no check failed; 1: at least one FAIL\)\. Explain each FAIL\/WARN and its remedy\.\n$/)
  })
})

describe('package.json and bin', () => {
  it('package.json has no "type" field (J2-11) and the spec scripts', () => {
    const pkg = json('package.json')
    assert.equal(Object.prototype.hasOwnProperty.call(pkg, 'type'), false)
    assert.deepEqual(pkg, {
      name: 'cc-rsi', private: true, license: 'Apache-2.0', engines: { node: '>=18' },
      scripts: { test: 'node scripts/run-tests.mjs', smoke: 'CC_RSI_E2E=1 node scripts/run-tests.mjs test/e2e' },
    })
    assert.equal(pkg.dependencies, undefined)
    assert.equal(pkg.devDependencies, undefined)
  })

  it('bin/cc-rsi is an executable CommonJS shim with a node shebang', () => {
    const path = join(ROOT, 'bin', 'cc-rsi')
    assert.equal(statSync(path).mode & 0o111, 0o111)
    const text = readFileSync(path, 'utf8')
    assert.ok(text.startsWith('#!/usr/bin/env node\n\'use strict\';\n'))
    assert.match(text, /require\('node:path'\)/)
    assert.match(text, /import\(pathToFileURL\(path\.join\(__dirname, '\.\.', 'lib', 'cli', 'main\.mjs'\)\)\.href\)/)
    assert.doesNotMatch(text, /^import /m)
  })
})

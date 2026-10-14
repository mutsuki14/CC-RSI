// SPEC §10.11: static probe (filesystem lookup), effective probe, isolation decision, live result recording and the
// live probe against the fake claude (which emulates the f2 gate and runs Bash unconfined).

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { decideIsolation, effectiveProbe, liveProbe, probeRecord, readProbe, recordLiveResult, shellQuote, staticProbe, writeProbe } from '../../lib/runtime/sandbox.mjs'
import { fakeClaude } from '../_helpers/fake.mjs'
import { tmpDir, tmpHome } from '../_helpers/tmp.mjs'

async function binDir(names) {
  const dir = await tmpDir('cc-rsi-bins-')
  for (const n of names) {
    writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, n), 0o755)
  }
  return dir
}

test('staticProbe on linux: bwrap AND socat on PATH (no spawn)', async () => {
  const both = await binDir(['bwrap', 'socat'])
  const one = await binDir(['bwrap'])
  const none = await tmpDir()
  const ok = staticProbe({ platform: 'linux', env: { PATH: both } })
  if (!ok.details.wsl1) {
    assert.equal(ok.available, true)
    assert.equal(ok.details.bwrap, join(both, 'bwrap'))
    assert.equal(ok.details.socat, join(both, 'socat'))
  }
  const missingSocat = staticProbe({ platform: 'linux', env: { PATH: one } })
  assert.equal(missingSocat.available, false)
  assert.match(missingSocat.reason, /socat not installed/)
  const missingBoth = staticProbe({ platform: 'linux', env: { PATH: none } })
  assert.equal(missingBoth.reason, 'sandbox unavailable: bubblewrap (bwrap) not installed, socat not installed')
  assert.equal(staticProbe({ platform: 'win32', env: {} }).available, false)
  assert.equal(typeof staticProbe({ platform: 'darwin', env: {} }).available, 'boolean')
})

test('effectiveProbe: a live failure for the same static details wins; changed details fall back to static', async () => {
  const both = await binDir(['bwrap', 'socat'])
  const st = staticProbe({ platform: 'linux', env: { PATH: both } })
  if (!st.available) return // WSL1 hosts
  const record = { ...probeRecord(st, { platform: 'linux' }), live: { ccVersion: '2.1.296', available: false, reason: 'Error: sandbox required but unavailable: x', at: 't' } }
  assert.deepEqual(effectiveProbe(record, st, { platform: 'linux' }), { available: false, reason: 'Error: sandbox required but unavailable: x' })
  const moved = { ...record, bwrap: '/elsewhere/bwrap' }
  assert.equal(effectiveProbe(moved, st, { platform: 'linux' }).available, true)
  assert.equal(effectiveProbe(null, st, { platform: 'linux' }).available, true)
  const unavailable = { available: false, reason: 'sandbox unavailable: socat not installed', details: {} }
  assert.deepEqual(effectiveProbe(record, unavailable), { available: false, reason: 'sandbox unavailable: socat not installed' })
})

test('decideIsolation: off / auto / require', () => {
  const yes = { available: true, reason: 'ok' }
  const no = { available: false, reason: 'sandbox unavailable: bubblewrap (bwrap) not installed' }
  assert.deepEqual(decideIsolation({ want: 'off', probe: yes }), { sandbox: false, refuse: false, reason: 'sandbox disabled by configuration (isolation.sandbox=off)' })
  assert.deepEqual(decideIsolation({ want: 'auto', probe: yes }), { sandbox: true, refuse: false, reason: 'ok' })
  assert.deepEqual(decideIsolation({ want: 'auto', probe: no }), { sandbox: false, refuse: false, reason: no.reason })
  assert.deepEqual(decideIsolation({ want: 'require', probe: yes }), { sandbox: true, refuse: false, reason: 'ok' })
  assert.equal(decideIsolation({ want: 'require', probe: no }).refuse, true)
})

test('probe.json read/write and recordLiveResult', async () => {
  const { home } = await tmpHome()
  assert.equal(await readProbe(home), null)
  await writeProbe(home, { v: 1, platform: 'linux' })
  assert.deepEqual(await readProbe(home), { v: 1, platform: 'linux' })
  const rec = await recordLiveResult(home, { available: false, reason: 'gone', ccVersion: '2.1.296' })
  assert.equal(rec.live.available, false)
  const onDisk = JSON.parse(readFileSync(join(home, 'probe.json'), 'utf8'))
  assert.equal(onDisk.v, 1)
  assert.equal(onDisk.live.reason, 'gone')
  assert.ok('static' in onDisk)
})

test('liveProbe: the f2 gate (no model call) → unavailable', async () => {
  const { home } = await tmpHome()
  const fake = await fakeClaude({ home })
  const r = await liveProbe({ bin: fake.bin, home, env: fake.env })
  assert.equal(r.available, false)
  assert.equal(r.cls, 'sandbox_unavailable')
  assert.match(r.reason, /sandbox required but unavailable/)
  assert.equal(fake.log().length, 1)
})

/** A fake-claude scenario whose body maps the prompt's `touch …` line (`line`) to a reply. */
async function probeScenario(body) {
  const dir = await tmpDir()
  const scenario = join(dir, 'touch.mjs')
  writeFileSync(scenario, `export default async function respond(ctx) {
    const line = ctx.prompt.split('\\n').find(l => l.startsWith('touch '))
    ${body}
  }\n`)
  return scenario
}

/** A CC_RSI_HOME whose path contains a space, a quote and non-ASCII letters (portability-4). */
async function awkwardHome() {
  const home = join(await tmpDir(), "home dir \u00e9 it's")
  mkdirSync(home, { recursive: true })
  return home
}

test('shellQuote: one POSIX word for any path', () => {
  assert.equal(shellQuote('/a/b'), "'/a/b'")
  assert.equal(shellQuote("/x y/it's $HOME"), "'/x y/it'\\''s $HOME'")
})

test('liveProbe: a sandbox that starts but does not confine is reported as not enforced', async () => {
  const { home } = await tmpHome()
  const scenario = await probeScenario("return { actions: [{ tool: 'Bash', command: line }], text: 'DONE' }")
  const fake = await fakeClaude({ home, scenario, sandbox: 'available' })
  const r = await liveProbe({ bin: fake.bin, home, env: fake.env })
  assert.deepEqual({ available: r.available, enforced: r.enforced }, { available: true, enforced: false })
  const log = fake.log()
  assert.equal(log.length, 1)
  assert.ok(log[0].argv.includes('--settings'))
})

test('liveProbe: a home path with spaces still detects a non-confining sandbox (quoted paths)', async () => {
  const home = await awkwardHome()
  const scenario = await probeScenario("return { actions: [{ tool: 'Bash', command: line }], text: 'DONE' }")
  const fake = await fakeClaude({ home, scenario, sandbox: 'available' })
  const r = await liveProbe({ bin: fake.bin, home, env: fake.env })
  assert.deepEqual({ available: r.available, enforced: r.enforced, inconclusive: r.inconclusive }, { available: true, enforced: false, inconclusive: undefined })
})

test('liveProbe: enforced only when the control write inside the allowed directory succeeded', async () => {
  const home = await awkwardHome()
  // Emulates a confining sandbox: the shell parses the touch line, but only its first (allowed) operand is written.
  const scenario = await probeScenario("return { actions: [{ tool: 'Bash', command: line.replace(/^touch /, 'set -- ') + '; touch \"$1\"' }], text: 'DONE' }")
  const fake = await fakeClaude({ home, scenario, sandbox: 'available' })
  const r = await liveProbe({ bin: fake.bin, home, env: fake.env })
  assert.deepEqual({ available: r.available, enforced: r.enforced }, { available: true, enforced: true })
  assert.match(r.reason, /confined a write outside its allowed directory/)
})

test('liveProbe: a model that replies DONE without running the command is inconclusive, not enforced', async () => {
  const { home } = await tmpHome()
  const scenario = await probeScenario("return { text: 'DONE' }")
  const fake = await fakeClaude({ home, scenario, sandbox: 'available' })
  const r = await liveProbe({ bin: fake.bin, home, env: fake.env })
  assert.equal(r.inconclusive, true)
  assert.equal(r.enforced, null)
  assert.equal(r.cls, 'probe_not_run')
  assert.match(r.reason, /inconclusive/)
})

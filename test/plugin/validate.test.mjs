// `claude plugin validate <repo> --strict --json` → success:true with no errors or warnings
// (SPEC §15.3 WP7 plugin row). Skipped when `claude` is not installed. Runs with a temporary HOME and
// CLAUDE_CONFIG_DIR so the real ~/.claude is never touched.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { tmpDir } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const probe = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 })
const skip = probe.status === 0 ? false : '`claude` is not installed'

function warningsAndErrors(report) {
  const out = []
  for (const part of [report.manifest, ...(report.contents ?? [])]) {
    if (!part) continue
    for (const e of part.errors ?? []) out.push(`error ${part.file}: ${e.path}: ${e.message}`)
    for (const w of part.warnings ?? []) out.push(`warning ${part.file}: ${w.path}: ${w.message}`)
  }
  return out
}

describe('claude plugin validate', { skip }, () => {
  it('passes --strict with no errors or warnings', async () => {
    const home = await tmpDir('cc-rsi-validate-home-')
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude` }
    delete env.CLAUDECODE
    const r = spawnSync('claude', ['plugin', 'validate', ROOT, '--strict', '--json'], { encoding: 'utf8', env, timeout: 120000 })
    let report
    try {
      report = JSON.parse(r.stdout)
    } catch {
      assert.fail(`validate printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`)
    }
    assert.deepEqual(warningsAndErrors(report), [])
    assert.equal(report.success, true)
    assert.equal(report.strict, true)
    assert.equal(r.status, 0)
  })
})

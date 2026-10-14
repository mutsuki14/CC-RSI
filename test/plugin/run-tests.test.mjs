// scripts/run-tests.mjs (SPEC §15, portability-13): node flags that take a value keep it in the
// space-separated form (`--test-name-pattern X`), so X is not mistaken for a test path.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { splitArgs } from '../../scripts/run-tests.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

describe('scripts/run-tests.mjs', () => {
  it('splits paths from node flags, keeping the separate value of a value-taking flag', () => {
    assert.deepEqual(splitArgs(['--test-name-pattern', 'parseArgs', 'test/cli']), { flags: ['--test-name-pattern', 'parseArgs'], paths: ['test/cli'] })
    assert.deepEqual(splitArgs(['test/a.test.mjs', '--test-reporter=spec', '-r', './x.cjs']), { flags: ['--test-reporter=spec', '-r', './x.cjs'], paths: ['test/a.test.mjs'] })
    // A boolean flag never swallows the following path.
    assert.deepEqual(splitArgs(['--test-only', 'test/core']), { flags: ['--test-only'], paths: ['test/core'] })
    assert.deepEqual(splitArgs(['--test-name-pattern']), { flags: ['--test-name-pattern'], paths: [] })
  })

  it('runs `--test-name-pattern X <file>` end to end', async () => {
    const dir = await tmpDir('cc-rsi-runner-')
    const file = join(dir, 'pattern.test.mjs')
    writeFileSync(file, "import { it } from 'node:test'\nit('alpha case', () => {})\nit('beta case', () => { throw new Error('beta must be filtered out') })\n")
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'run-tests.mjs'), '--test-name-pattern', 'alpha', file], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /no such file or directory/)
    assert.match(r.stdout, /alpha case/)
  })
})

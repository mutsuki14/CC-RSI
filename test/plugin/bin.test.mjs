// The CommonJS bin on every available Node (SPEC §13.2, J2-11): `bin/cc-rsi version` runs on the
// current Node and on every node18/node20/node22 found on PATH (plus /opt/node<N>/bin/node, where
// this container keeps its other Node versions); it refuses inside a role context before loading ESM.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { tmpHome } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const BIN = join(ROOT, 'bin', 'cc-rsi')

function executable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Every distinct Node binary to try: the current one, nodeNN on PATH, /opt/nodeNN/bin/node. */
function nodes() {
  const found = new Map([[realpathSync(process.execPath), process.execPath]])
  for (const name of ['node18', 'node20', 'node22']) {
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name)
      if (executable(candidate)) found.set(realpathSync(candidate), candidate)
    }
    const opt = `/opt/${name}/bin/node`
    if (executable(opt)) found.set(realpathSync(opt), opt)
  }
  return [...found.values()]
}

describe('bin/cc-rsi', () => {
  for (const node of nodes()) {
    it(`runs "version" on ${node}`, async () => {
      const { env } = await tmpHome()
      const v = spawnSync(node, ['--version'], { encoding: 'utf8' })
      const major = Number(String(v.stdout).replace(/^v/, '').split('.')[0])
      const r = spawnSync(node, [BIN, 'version'], { encoding: 'utf8', env, cwd: ROOT })
      if (major < 18) {
        assert.equal(r.status, 1)
        assert.match(r.stderr, /cc-rsi requires Node >= 18/)
        return
      }
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, new RegExp(`^cc-rsi \\d+\\.\\d+\\.\\d+ \\(node ${String(v.stdout).trim().replace(/^v/, '').replace(/\./g, '\\.')};`))
      const role = spawnSync(node, [BIN, 'version'], { encoding: 'utf8', env: { ...env, CC_RSI_ROLE: 'verifier' }, cwd: ROOT })
      assert.equal(role.status, 64)
      assert.equal(role.stdout, '')
    })
  }

  it('runs directly through its shebang', async () => {
    const { env } = await tmpHome()
    const r = spawnSync(BIN, ['version'], { encoding: 'utf8', env, cwd: ROOT })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^cc-rsi /)
  })
})

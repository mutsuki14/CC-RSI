// ids, digest, log and error classes (SPEC §5.3).

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { canonicalJson, canonicalSha256, compareUtf8, sha256File, sha256Hex, sortUtf8 } from '../../lib/core/digest.mjs'
import { CcRsiError, HumanOnlyError, LockTimeoutError, RoleContextError, UsageError } from '../../lib/core/errors.mjs'
import {
  ID_RE, confirmCode, defaultLineageId, interactiveEpisode, isValidId, newJobId, newRunId, pad3, uuid,
} from '../../lib/core/ids.mjs'
import { createLogger } from '../../lib/core/log.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const NOW = new Date(Date.UTC(2026, 9, 13, 7, 5, 9))

describe('ids', () => {
  it('formats ids in UTC', () => {
    assert.match(newJobId(NOW), /^j-20261013070509-[0-9a-f]{6}$/)
    assert.equal(defaultLineageId('deep', NOW), 'deep-20261013070509')
    assert.equal(newRunId(NOW), 'r-20261013070509')
    assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.match(confirmCode(), /^[0-9a-f]{6}$/)
    assert.notEqual(confirmCode() + confirmCode(), confirmCode() + confirmCode())
    assert.equal(pad3(7), '007')
    assert.equal(pad3(1234), '1234')
    assert.equal(interactiveEpisode('0123456789abcdef', 3, 2), 'task-01234567-3-g2')
  })

  it('validates lineage ids', () => {
    for (const ok of ['deep-20261013070509', 'a', 'x_y-z9', 'a'.repeat(64)]) assert.ok(ID_RE.test(ok) && isValidId(ok), ok)
    for (const bad of ['', '-a', 'A', 'a/b', 'a'.repeat(65), '..', 'a b', 7]) assert.equal(isValidId(bad), false, String(bad))
  })
})

describe('digest', () => {
  it('sha256 helpers', async () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'))
    const dir = await tmpDir()
    await writeFile(join(dir, 'f'), 'abc')
    assert.equal(await sha256File(join(dir, 'f')), sha256Hex('abc'))
    await assert.rejects(sha256File(join(dir, 'missing')), /ENOENT/)
  })

  it('UTF-8 ordering differs from UTF-16 ordering for astral vs BMP private-use characters', () => {
    assert.ok(compareUtf8('\uE000', '\u{1F600}') < 0)
    assert.ok('\uE000' > '\u{1F600}', 'JS default ordering puts the surrogate pair first')
    assert.deepEqual(sortUtf8(['é', 'Z', '\u{1F600}', '！', 'a']), ['Z', 'a', 'é', '！', '\u{1F600}'])
    assert.equal(canonicalJson({ '\u{1F600}': 1, '\uE000': 2 }), '{"\uE000":2,"\u{1F600}":1}')
    assert.equal(canonicalSha256({}), sha256Hex('{}'))
    assert.throws(() => canonicalJson(Number.NaN), err => err instanceof CcRsiError && err.code === 'json_not_canonical')
    assert.equal(canonicalJson({ t: new Date(0) }), '{"t":"1970-01-01T00:00:00.000Z"}')
  })
})

describe('log', () => {
  it('appends JSONL records and never throws', async () => {
    const dir = await tmpDir()
    const file = join(dir, 'logs', 'hooks.log')
    const log = createLogger(file, 'guard')
    log.info('hello', { a: 1 })
    log.warn('careful')
    log.error('failed', new Error('boom'))
    const cyclic = {}
    cyclic.self = cyclic
    log.info('cyclic', cyclic)
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.map(l => [l.level, l.component, l.msg]), [['info', 'guard', 'hello'], ['warn', 'guard', 'careful'], ['error', 'guard', 'failed'], ['info', 'guard', 'cyclic']])
    assert.deepEqual(lines[0].data, { a: 1 })
    assert.equal(lines[2].data.message, 'boom')
    assert.equal(lines[3].data, '[unserializable]')
    assert.equal(lines[0].pid, process.pid)
    // A parent that is a regular file makes every write fail: still no throw.
    await writeFile(join(dir, 'plain-file'), 'x')
    createLogger(join(dir, 'plain-file', 'sub', 'x.log'), 'x').info('ignored')
    createLogger(null, 'x').warn('ignored')
  })
})

describe('errors', () => {
  it('carry codes, details and fixed messages', () => {
    const base = new CcRsiError('x_code', 'msg', { a: 1 })
    assert.ok(base instanceof Error)
    assert.deepEqual([base.name, base.code, base.message, base.details], ['CcRsiError', 'x_code', 'msg', { a: 1 }])
    assert.deepEqual(new CcRsiError('only_code').message, 'only_code')
    const human = new HumanOnlyError('memory restore')
    assert.equal(human.message, 'cc-rsi: "memory restore" is human-only: run it in a terminal outside Claude Code')
    assert.equal(human.code, 'human_only')
    assert.equal(human.exitCode, 65)
    assert.equal(new HumanOnlyError('human_only', 'eval run').message, 'cc-rsi: "eval run" is human-only: run it in a terminal outside Claude Code')
    const role = new RoleContextError()
    assert.equal(role.message, 'cc-rsi: refusing to run inside a cc-rsi role context (CC_RSI_ROLE is set)')
    assert.equal(role.exitCode, 64)
    assert.ok(role instanceof CcRsiError)
    const usage = new UsageError('unknown option --x')
    assert.deepEqual([usage.code, usage.message, usage.exitCode], ['usage', 'unknown option --x', 2])
    assert.equal(new UsageError('bad_flag', 'bad flag').code, 'bad_flag')
    const lock = new LockTimeoutError('held', { path: '/p' })
    assert.deepEqual([lock.code, lock.message, lock.details.path, lock.name], ['lock_timeout', 'held', '/p', 'LockTimeoutError'])
  })
})

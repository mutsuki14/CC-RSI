// loadConfig (SPEC §5.2, §14).

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DEFAULTS, GLOBAL_ONLY, TIGHTEN_ONLY, configSha, getKey, loadConfig, userConfigFromEnv,
} from '../../lib/core/config.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

async function setup({ global, project } = {}) {
  const home = await tmpDir('cc-rsi-home-')
  const projectRoot = await tmpDir('cc-rsi-proj-')
  if (global !== undefined) await writeFile(join(home, 'config.json'), typeof global === 'string' ? global : JSON.stringify(global))
  if (project !== undefined) {
    await mkdir(join(projectRoot, '.claude'), { recursive: true })
    await writeFile(join(projectRoot, '.claude', 'cc-rsi.json'), typeof project === 'string' ? project : JSON.stringify(project))
  }
  return { home, projectRoot }
}

describe('DEFAULTS', () => {
  it('matches the §14.2 table and is deep-frozen', () => {
    assert.equal(DEFAULTS.mode, 'learn')
    assert.equal(DEFAULTS.models.verifier, '')
    assert.equal(DEFAULTS.interactive.stopPolicy, 'nudge')
    assert.equal(DEFAULTS.isolation.sandbox, 'auto')
    assert.equal(DEFAULTS.interactive.waitSeconds, 100)
    assert.equal(DEFAULTS.interactive.checkpointMaxBytes, 268435456)
    assert.deepEqual(DEFAULTS.transport.pauseCeilingSecs, { interactive: 1800, lineage: 21600 })
    assert.deepEqual(DEFAULTS.transport.turnTimeoutSec, { actor: 14400, verifier: 14400, interactiveVerifier: 7200, curriculum: 14400, summarizer: 600 })
    assert.deepEqual(DEFAULTS.transport.compaction, { practiceActor: 'off', targetActor: 'auto', verifier: 'off', curriculum: 'off' })
    assert.equal(DEFAULTS.exploration.waveConcurrency, 2)
    assert.deepEqual(DEFAULTS.memory, { dir: '', maxFiles: 400, maxTotalBytes: 4194304, maxFileBytes: 65536, keepHistory: true, promptInventory: 40 })
    assert.deepEqual(DEFAULTS.evaluation, { command: [], timeoutSec: 900, retries: 2, identicalErrorLimit: 3 })
    assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.transport.maxTurns) && Object.isFrozen(DEFAULTS.audit.sealedTextFiles))
    assert.ok(GLOBAL_ONLY.includes('memory.dir'))
    assert.deepEqual(TIGHTEN_ONLY['isolation.sandbox'].order, ['off', 'auto', 'require'])
  })

  it('loadConfig without files returns a mutable copy of the defaults', () => {
    const { config, warnings, sources } = loadConfig({})
    assert.deepEqual(config, JSON.parse(JSON.stringify(DEFAULTS)))
    assert.deepEqual(warnings, [])
    assert.equal(sources['models.verifier'], 'default')
    config.models.verifier = 'x'
    assert.equal(DEFAULTS.models.verifier, '')
  })
})

describe('loadConfig precedence', () => {
  it('CLI > non-empty userConfig > project > global > DEFAULTS', async () => {
    const { home, projectRoot } = await setup({
      global: { models: { verifier: 'global-v', actor: 'global-a', curriculum: 'global-c' }, interactive: { taskMessages: 5 } },
      project: { models: { verifier: 'project-v', actor: 'project-a' }, interactive: { taskMessages: 7 } },
    })
    const { config, warnings, sources } = loadConfig({
      home, projectRoot, userConfig: { verifier_model: 'user-v', stop_policy: '', sandbox: undefined }, cli: { models: { actor: 'cli-a' } },
    })
    assert.deepEqual(warnings, [])
    assert.equal(config.models.verifier, 'user-v')
    assert.equal(config.models.actor, 'cli-a')
    assert.equal(config.models.curriculum, 'global-c')
    assert.equal(config.interactive.taskMessages, 7)
    assert.equal(config.interactive.stopPolicy, 'nudge')
    assert.equal(sources['models.verifier'], 'userConfig')
    assert.equal(sources['models.actor'], 'cli')
    assert.equal(sources['models.curriculum'], 'global')
    assert.equal(sources['interactive.taskMessages'], 'project')
    assert.equal(sources['interactive.stopPolicy'], 'default')
  })

  it('accepts dotted keys in CLI and userConfig layers', async () => {
    const { config } = loadConfig({ cli: { 'exploration.waveConcurrency': 4 }, userConfig: { stop_policy: 'gate', sandbox: 'require' } })
    assert.equal(config.exploration.waveConcurrency, 4)
    assert.equal(config.interactive.stopPolicy, 'gate')
    assert.equal(config.isolation.sandbox, 'require')
  })

  it('ignores GLOBAL_ONLY keys from the project file with a warning', async () => {
    const { home, projectRoot } = await setup({
      global: { isolation: { allowUnconfined: true }, memory: { dir: '/global/store' } },
      project: {
        isolation: { allowUnconfined: false },
        memory: { dir: '/evil', maxFiles: 10 },
        evaluation: { command: ['sh', '-c', 'curl evil'] },
        children: { claudeBin: '/tmp/evil-claude', envPassthrough: ['AWS_*'], keepStreams: false },
        exploration: { modelMayStart: true },
        audit: { sealedTextFiles: [] },
      },
    })
    const { config, warnings } = loadConfig({ home, projectRoot })
    assert.equal(config.isolation.allowUnconfined, true)
    assert.equal(config.memory.dir, '/global/store')
    assert.equal(config.memory.maxFiles, 10)
    assert.deepEqual(config.evaluation.command, [])
    assert.equal(config.children.claudeBin, '')
    assert.deepEqual(config.children.envPassthrough, [])
    assert.equal(config.children.keepStreams, false)
    assert.equal(config.exploration.modelMayStart, false)
    for (const key of ['isolation.allowUnconfined', 'memory.dir', 'evaluation.command', 'children.claudeBin', 'children.envPassthrough', 'exploration.modelMayStart', 'audit.sealedTextFiles']) {
      assert.ok(warnings.some(w => w.includes(`"${key}"`) && w.includes('honoured only')), key)
    }
    // The CLI may still set them.
    assert.equal(loadConfig({ home, projectRoot, cli: { memory: { dir: '/cli' } } }).config.memory.dir, '/cli')
  })

  it('tighten-only: the project cannot loosen the sandbox, but can tighten it', async () => {
    let { home, projectRoot } = await setup({ project: { isolation: { sandbox: 'off' } } })
    let result = loadConfig({ home, projectRoot })
    assert.equal(result.config.isolation.sandbox, 'auto')
    assert.ok(result.warnings.some(w => w.includes('isolation.sandbox') && w.includes('tighten-only')))
    // Even a looser CLI/userConfig value cannot undercut a stricter project value.
    ;({ home, projectRoot } = await setup({ project: { isolation: { sandbox: 'require' } } }))
    result = loadConfig({ home, projectRoot, userConfig: { sandbox: 'off' }, cli: { isolation: { sandbox: 'auto' } } })
    assert.equal(result.config.isolation.sandbox, 'require')
    assert.equal(result.sources['isolation.sandbox'], 'project')
    // webTools: the project may only turn it off.
    ;({ home, projectRoot } = await setup({ global: { exploration: { webTools: true } }, project: { exploration: { webTools: false } } }))
    assert.equal(loadConfig({ home, projectRoot }).config.exploration.webTools, false)
    ;({ home, projectRoot } = await setup({ project: { exploration: { webTools: true } } }))
    assert.equal(loadConfig({ home, projectRoot }).config.exploration.webTools, false)
  })

  it('tighten-only: network lists intersect (the project may only remove entries)', async () => {
    const { home, projectRoot } = await setup({
      global: { isolation: { verifierNetwork: ['a.example', 'b.example'], actorNetwork: ['x.example'] } },
      project: { isolation: { verifierNetwork: ['b.example', 'c.example'] } },
    })
    const { config, warnings } = loadConfig({ home, projectRoot })
    assert.deepEqual(config.isolation.verifierNetwork, ['b.example'])
    assert.deepEqual(config.isolation.actorNetwork, ['x.example'])
    assert.ok(warnings.some(w => w.includes('c.example')))
    const noGlobal = await setup({ project: { isolation: { actorNetwork: ['evil.example'] } } })
    assert.deepEqual(loadConfig(noGlobal).config.isolation.actorNetwork, [])
  })

  it('invalid values and unknown keys warn and fall back; malformed files never throw', async () => {
    const { home, projectRoot } = await setup({
      global: { interactive: { taskMessages: 4, waitSeconds: 5 }, exploration: { waveConcurrency: 9 }, bogus: 1, models: { verifier: 7, nope: 'x' } },
      project: '{ not json',
    })
    const { config, warnings } = loadConfig({ home, projectRoot })
    assert.equal(config.interactive.taskMessages, 4)
    assert.equal(config.interactive.waitSeconds, 100)
    assert.equal(config.exploration.waveConcurrency, 2)
    assert.equal(config.models.verifier, '')
    assert.equal(getKey(config, 'bogus'), undefined)
    for (const needle of ['interactive.waitSeconds', 'exploration.waveConcurrency', '"bogus"', 'models.verifier', 'models.nope', 'malformed project config']) {
      assert.ok(warnings.some(w => w.includes(needle)), needle)
    }
    const enumBad = loadConfig({ cli: { interactive: { stopPolicy: 'always' }, audit: { shingleWords: 2 }, memory: { maxFiles: 1.5 } } })
    assert.equal(enumBad.config.interactive.stopPolicy, 'nudge')
    assert.equal(enumBad.config.audit.shingleWords, 8)
    assert.equal(enumBad.config.memory.maxFiles, 400)
    assert.equal(enumBad.warnings.length, 3)
    const arrayRoot = await setup({ global: '[1,2]' })
    assert.ok(loadConfig(arrayRoot).warnings.some(w => w.includes('not a JSON object')))
  })

  it('a layer value replaces arrays wholesale and keeps sibling defaults', async () => {
    const { home } = await setup({ global: { evaluation: { command: ['python3', 'grade.py'] }, transport: { turnTimeoutSec: { actor: 60 } } } })
    const { config } = loadConfig({ home })
    assert.deepEqual(config.evaluation.command, ['python3', 'grade.py'])
    assert.equal(config.transport.turnTimeoutSec.actor, 60)
    assert.equal(config.transport.turnTimeoutSec.verifier, 14400)
  })
})

describe('helpers', () => {
  it('getKey walks dotted keys', () => {
    assert.equal(getKey(DEFAULTS, 'transport.maxTurns.summarizer'), 1)
    assert.equal(getKey(DEFAULTS, 'transport.nope.x'), undefined)
    assert.equal(getKey(DEFAULTS, 'mode'), 'learn')
  })

  it('configSha is the sha256 of canonical JSON and ignores key order', () => {
    const a = loadConfig({}).config
    const b = JSON.parse(JSON.stringify(a))
    const reordered = Object.fromEntries(Object.entries(b).reverse())
    assert.match(configSha(a), /^[0-9a-f]{64}$/)
    assert.equal(configSha(reordered), configSha(a))
    b.models.verifier = 'opus'
    assert.notEqual(configSha(b), configSha(a))
  })

  it('userConfigFromEnv reads present variables only, for both prefixes', () => {
    assert.deepEqual(userConfigFromEnv({ CLAUDE_PLUGIN_OPTION_STOP_POLICY: 'gate' }, 'CLAUDE_PLUGIN_OPTION_'), { stop_policy: 'gate' })
    assert.deepEqual(userConfigFromEnv({ CC_RSI_OPT_VERIFIER_MODEL: '', CC_RSI_OPT_STOP_POLICY: 'nudge', CC_RSI_OPT_SANDBOX: 'auto' }, 'CC_RSI_OPT_'),
      { verifier_model: '', stop_policy: 'nudge', sandbox: 'auto' })
    assert.deepEqual(userConfigFromEnv({ CC_RSI_OPT_VERIFIER_MODEL: '${user_config.verifier_model}' }, 'CC_RSI_OPT_'), {})
    assert.deepEqual(userConfigFromEnv({}, 'CC_RSI_OPT_'), {})
    // An empty userConfig value never overrides.
    assert.equal(loadConfig({ userConfig: userConfigFromEnv({ CC_RSI_OPT_VERIFIER_MODEL: '' }, 'CC_RSI_OPT_') }).config.models.verifier, '')
  })
})

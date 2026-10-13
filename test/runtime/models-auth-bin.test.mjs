// SPEC §10.1 (binary), §10.3 (models), §10.4 (forwarded auth settings).

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { forwardedUserSettings } from '../../lib/runtime/auth-settings.mjs'
import { claudeVersion, clearClaudeBinCache, compareVersions, missingFlags, REQUIRED_FLAGS, resolveClaudeBin } from '../../lib/runtime/claude-bin.mjs'
import { effective, resolveModel, userSettingsModel, userSettingsModelSync } from '../../lib/runtime/models.mjs'
import { FAKE_CLAUDE_BIN } from '../_helpers/fake.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

test('resolveModel: config → session → ANTHROPIC_MODEL → user settings → default', () => {
  const env = { ANTHROPIC_MODEL: 'env-model' }
  assert.deepEqual(resolveModel('opus', { sessionModel: 's', env, userSettingsModel: 'u' }), { model: 'opus', source: 'config' })
  assert.deepEqual(resolveModel('inherit', { sessionModel: 's', env, userSettingsModel: 'u' }), { model: 's', source: 'session' })
  assert.deepEqual(resolveModel('', { sessionModel: null, env, userSettingsModel: 'u' }), { model: 'env-model', source: 'env' })
  assert.deepEqual(resolveModel('', { env: {}, userSettingsModel: 'u' }), { model: 'u', source: 'user-settings' })
  assert.deepEqual(resolveModel(undefined, { env: {} }), { model: null, source: 'default' })
  assert.deepEqual(resolveModel('  ', { sessionModel: '  ', env: { ANTHROPIC_MODEL: '' } }), { model: null, source: 'default' })
  assert.equal(effective(null), '(default)')
  assert.equal(effective(''), '(default)')
  assert.equal(effective('claude-x'), 'claude-x')
})

test('userSettingsModel reads ${CLAUDE_CONFIG_DIR}/settings.json', async () => {
  const dir = await tmpDir()
  assert.equal(await userSettingsModel({ CLAUDE_CONFIG_DIR: dir }), null)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
  assert.equal(await userSettingsModel({ CLAUDE_CONFIG_DIR: dir }), 'sonnet')
  assert.equal(userSettingsModelSync({ CLAUDE_CONFIG_DIR: dir }), 'sonnet')
  writeFileSync(join(dir, 'settings.json'), '{broken')
  assert.equal(await userSettingsModel({ CLAUDE_CONFIG_DIR: dir }), null)
  const home = await tmpDir()
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku' }))
  assert.equal(await userSettingsModel({ HOME: home }), 'haiku')
})

test('forwardedUserSettings: auth keys and PASS env entries only', async () => {
  const dir = await tmpDir()
  assert.deepEqual(await forwardedUserSettings({ env: { CLAUDE_CONFIG_DIR: dir } }), {})
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    apiKeyHelper: '/usr/local/bin/key-helper', awsAuthRefresh: 'aws sso login', awsCredentialExport: 'x', forceLoginMethod: 'claudeai', forceLoginOrgUUID: 'org',
    model: 'opus', permissions: { allow: ['Bash'] }, hooks: { Stop: [] }, enabledPlugins: { x: true },
    env: { ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', MY_SECRET: 's', API_TIMEOUT_MS: 600000 },
  }))
  assert.deepEqual(await forwardedUserSettings({ env: { CLAUDE_CONFIG_DIR: dir } }), {
    apiKeyHelper: '/usr/local/bin/key-helper', awsAuthRefresh: 'aws sso login', awsCredentialExport: 'x', forceLoginMethod: 'claudeai', forceLoginOrgUUID: 'org',
    env: { ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', API_TIMEOUT_MS: '600000' },
  })
  const widened = await forwardedUserSettings({ env: { CLAUDE_CONFIG_DIR: dir }, passthrough: ['MY_*', 'CLAUDECODE'] })
  assert.equal(widened.env.MY_SECRET, 's')
  assert.equal(widened.env.CLAUDECODE, undefined, 'NEVER wins over passthrough')
})

test('resolveClaudeBin precedence', () => {
  assert.equal(resolveClaudeBin({ config: { children: { claudeBin: '/c/claude' } }, env: { CC_RSI_CLAUDE_BIN: '/t/claude', CLAUDE_CODE_EXECPATH: '/e/claude' } }), '/c/claude')
  assert.equal(resolveClaudeBin({ config: { children: { claudeBin: '' } }, env: { CC_RSI_CLAUDE_BIN: '/t/claude', CLAUDE_CODE_EXECPATH: '/e/claude' } }), '/t/claude')
  assert.equal(resolveClaudeBin({ env: { CLAUDE_CODE_EXECPATH: '/opt/claude-code/bin/claude' } }), '/opt/claude-code/bin/claude')
  assert.equal(resolveClaudeBin({ env: { CLAUDE_CODE_EXECPATH: '/usr/bin/node' } }), 'claude', 'an execpath that is not claude is ignored')
  assert.equal(resolveClaudeBin({ env: {} }), 'claude')
})

test('claudeVersion and missingFlags against the fake; a broken binary', async () => {
  clearClaudeBinCache()
  assert.equal(await claudeVersion(FAKE_CLAUDE_BIN), '2.1.296')
  assert.deepEqual(await missingFlags(FAKE_CLAUDE_BIN), [])
  const dir = await tmpDir()
  const broken = join(dir, 'claude')
  writeFileSync(broken, '#!/bin/sh\necho "Usage: claude --restricted --tools"\n')
  chmodSync(broken, 0o755)
  assert.equal(await claudeVersion(broken), null)
  const missing = await missingFlags(broken)
  assert.ok(missing.includes('--include-hook-events'))
  assert.ok(!missing.includes('--restricted'))
  assert.equal(await claudeVersion(join(dir, 'absent')), null)
  assert.deepEqual(await missingFlags(join(dir, 'absent')), [...REQUIRED_FLAGS])
})

test('compareVersions', () => {
  assert.ok(compareVersions('2.1.296', '2.1.295') > 0)
  assert.equal(compareVersions('2.1.295', '2.1.295'), 0)
  assert.ok(compareVersions('2.1.29', '2.1.295') < 0)
  assert.ok(compareVersions('3.0.0', '2.99.999') > 0)
})

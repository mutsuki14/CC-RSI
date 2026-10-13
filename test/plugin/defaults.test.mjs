// userConfig defaults parity (SPEC §14.1): the manifest defaults equal the code defaults, every
// option value is accepted by the config loader, and each key maps to its config key.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { DEFAULTS, getKey, loadConfig, TIGHTEN_ONLY, USERCONFIG_MAP, userConfigFromEnv } from '../../lib/core/config.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))

describe('userConfig defaults parity', () => {
  it('the manifest defaults equal DEFAULTS', () => {
    assert.equal(DEFAULTS.models.verifier, '')
    assert.equal(DEFAULTS.interactive.stopPolicy, 'nudge')
    assert.equal(DEFAULTS.isolation.sandbox, 'auto')
    assert.deepEqual(Object.keys(manifest.userConfig).sort(), Object.keys(USERCONFIG_MAP).sort())
    for (const [key, dotted] of Object.entries(USERCONFIG_MAP)) {
      assert.equal(manifest.userConfig[key].default, getKey(DEFAULTS, dotted), `${key} → ${dotted}`)
    }
  })

  it('every option value is valid for its config key, and nothing else is', async () => {
    const home = await tmpDir()
    for (const [key, option] of Object.entries(manifest.userConfig)) {
      const dotted = USERCONFIG_MAP[key]
      for (const value of option.options ?? []) {
        const { config, warnings } = loadConfig({ home, userConfig: { [key]: value } })
        assert.deepEqual(warnings, [], `${key}=${value}`)
        assert.equal(getKey(config, dotted), value)
      }
      if (option.options) {
        const { config, warnings } = loadConfig({ home, userConfig: { [key]: 'not-an-option' } })
        assert.ok(warnings.length > 0)
        assert.equal(getKey(config, dotted), option.default)
      }
    }
    // The sandbox picker offers exactly the tighten-only order.
    assert.deepEqual([...manifest.userConfig.sandbox.options].sort(), [...TIGHTEN_ONLY['isolation.sandbox'].order].sort())
  })

  it('hook and MCP option variables map to the same keys; unsaved placeholders are absent', () => {
    assert.deepEqual(userConfigFromEnv({ CLAUDE_PLUGIN_OPTION_STOP_POLICY: 'gate' }, 'CLAUDE_PLUGIN_OPTION_'), { stop_policy: 'gate' })
    assert.deepEqual(userConfigFromEnv({ CC_RSI_OPT_SANDBOX: 'require', CC_RSI_OPT_VERIFIER_MODEL: '${user_config.verifier_model}' }, 'CC_RSI_OPT_'), { sandbox: 'require' })
    // .mcp.json (WP5) carries every userConfig key into the server environment.
    let mcp = null
    try { mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) } catch { mcp = null }
    if (mcp) {
      const env = mcp.mcpServers.rsi.env
      for (const key of Object.keys(manifest.userConfig)) assert.equal(env[`CC_RSI_OPT_${key.toUpperCase()}`], `\${user_config.${key}}`)
    }
  })
})

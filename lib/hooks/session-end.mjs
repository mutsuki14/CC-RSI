// SessionEnd (SPEC §11.8 `session-end`): marks the session ended within the shared ~1.5 s budget.
// It never touches jobs: a running verification finishes and records into this session's state.
// Only the cached project index is used (no git), so the hook stays far below the budget.

import { join } from 'node:path'
import { readJsonSafeSync, writeJsonAtomicSync } from '../core/atomic.mjs'
import { loadConfig } from '../core/config.mjs'
import { ccRsiHome, globalLayout, projectLayout, safeName, sessionLayout } from '../core/paths.mjs'
import { failOpen, isRole } from './common.mjs'

function sessionEnd(payload, env) {
  const sid = typeof payload.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null
  if (sid === null) return {}
  const home = ccRsiHome(env)
  const cache = readJsonSafeSync(join(globalLayout(home).runSessions, `${safeName(sid)}.json`), null)
  if (!cache || typeof cache.projectKey !== 'string') return {}
  const { config } = loadConfig({ home, projectRoot: cache.projectRoot })
  const storeDir = typeof config.memory?.dir === 'string' && config.memory.dir !== '' ? config.memory.dir : undefined
  const sl = sessionLayout(projectLayout(home, cache.projectKey, { storeDir }), sid)
  const current = readJsonSafeSync(sl.sessionJson, null)
  if (!current || typeof current !== 'object') return {}
  const now = new Date().toISOString()
  writeJsonAtomicSync(sl.sessionJson, { ...current, v: 1, endedAt: now, endReason: typeof payload.reason === 'string' ? payload.reason : null, lastSeen: now })
  return {}
}

/** SessionEnd hook entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  return failOpen('session-end', async () => sessionEnd(payload ?? {}, env), { env })
}

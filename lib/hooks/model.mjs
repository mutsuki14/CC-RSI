// PostModelSwitch (SPEC §11.8 `model`; J2-8): keeps session.json's model current, so a Verifier
// whose `verifier_model` is empty or `inherit` follows the session's model (SPEC §10.3 step 2).

import { sessionContext, writeSession } from '../interactive/session.mjs'
import { failOpen, isRole } from './common.mjs'

async function model(payload, env) {
  const to = typeof payload.to_model === 'string' && payload.to_model !== '' ? payload.to_model
    : typeof payload.model === 'string' && payload.model !== '' ? payload.model : null
  if (to === null) return {}
  const ctx = await sessionContext({ payload, env, create: false })
  await writeSession(ctx.sl, { model: to, modelSource: 'model-switch', lastSeen: new Date().toISOString() })
  return {}
}

/** PostModelSwitch hook entry (SPEC §11.8 module export). */
export async function run(payload, { env = process.env } = {}) {
  if (isRole(env)) return {}
  return failOpen('model', () => model(payload ?? {}, env), { env })
}

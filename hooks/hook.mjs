#!/usr/bin/env node
// Main-session hook dispatcher (SPEC §11.7, §11.8): `node hooks/hook.mjs <sub>` with the hook
// payload on stdin → lib/hooks/<sub>.mjs run(payload, {env}). Prints at most one JSON object on
// stdout, the optional stderr line, and exits with the returned code (0 unless a sub asks for 2).
// Main-session hooks fail open: an unknown sub, malformed stdin or any error exits 0 silently.
// Inside a role child (CC_RSI_ROLE set) every sub is a no-op except `attest`, which denies.

import { SUBS, denyPre, isRole, readStdinJson } from '../lib/hooks/common.mjs'

async function dispatch(sub) {
  const payload = await readStdinJson()
  if (!SUBS.includes(sub)) return {}
  if (isRole(process.env)) {
    return sub === 'attest' ? { stdout: denyPre('cc-rsi tools are not available inside role contexts') } : {}
  }
  if (payload === null) return {}
  const mod = await import(`../lib/hooks/${sub}.mjs`)
  return mod.run(payload, { env: process.env })
}

function emit(out) {
  const result = out && typeof out === 'object' ? out : {}
  if (result.stdout !== undefined && result.stdout !== null) process.stdout.write(JSON.stringify(result.stdout))
  if (typeof result.stderr === 'string' && result.stderr !== '') process.stderr.write(`${result.stderr}\n`)
  process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 0
}

dispatch(process.argv[2]).then(emit, () => {
  process.exitCode = 0
})

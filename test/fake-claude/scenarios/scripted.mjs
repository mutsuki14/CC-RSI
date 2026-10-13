// Base scenario driven by data: `<fakeHome>/script.json` (see test/_helpers/fake.mjs writeScript).
//   { "<role>" | "*": { "turns": [response, …], "default": response } }
// The response for a message is `turns[turn - 1]` of the caller's role (else of "*"), falling back to
// `default`, then to {text:"OK"}. Strings in a response may use {{CWD}}, {{TURN}}, {{ROLE}} and
// {{SESSION}}. A response {"echoPrompt": true} replies with the prompt itself. Selection depends
// only on (role, per-session turn), so concurrent sessions stay deterministic.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{(CWD|TURN|ROLE|SESSION)\}\}/g, (_, k) => vars[k])
  if (Array.isArray(value)) return value.map(v => fill(v, vars))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]))
  return value
}

export default async function respond(ctx) {
  let script = {}
  try { script = JSON.parse(readFileSync(join(ctx.fakeHome, 'script.json'), 'utf8')) } catch { script = {} }
  const entry = script[ctx.role] ?? script['*'] ?? {}
  const turns = Array.isArray(entry.turns) ? entry.turns : []
  const chosen = turns[ctx.turn - 1] ?? entry.default ?? { text: 'OK' }
  if (chosen && chosen.echoPrompt) return { text: ctx.prompt }
  return fill(chosen, { CWD: ctx.cwd, TURN: String(ctx.turn), ROLE: String(ctx.role), SESSION: ctx.sessionId })
}

// Base scenario: replies with the role, the per-session turn, the recovery flag and the prompt's
// first line, so tests can see exactly what reached the model.
export default async function respond(ctx) {
  const firstLine = String(ctx.prompt).split('\n')[0]
  return { text: `ROLE ${ctx.role} TURN ${ctx.turn} RECOVERING ${ctx.recovering}\n${firstLine}` }
}

// Base scenario: a Verifier that inspects the candidate with one Bash action and publishes PASS.
// Any other role replies "OK".
export default async function respond(ctx) {
  if (ctx.role !== 'verifier') return { text: 'OK' }
  return { actions: [{ tool: 'Bash', command: 'ls -1' }], text: `Inspected the candidate in ${ctx.cwd}.\nVERDICT: PASS` }
}

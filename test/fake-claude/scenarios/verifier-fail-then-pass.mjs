// Base scenario: a Verifier context that answers FAIL on its first message and PASS afterwards
// (the FAIL → repair → re-verify flow keeps one Verifier context: --resume of the same session).
export default async function respond(ctx) {
  if (ctx.role !== 'verifier') return { text: 'OK' }
  const verdict = ctx.turn === 1 ? 'FAIL' : 'PASS'
  return { actions: [{ tool: 'Bash', command: 'ls -1' }], text: `Inspection ${ctx.turn}.\nVERDICT: ${verdict}` }
}

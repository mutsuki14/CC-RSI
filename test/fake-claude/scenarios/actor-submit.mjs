// Base scenario: an Actor that writes result.txt in its cwd and hands off with STATUS: SUBMIT.
// Other roles reply "OK".
export default async function respond(ctx) {
  if (ctx.role !== 'actor') return { text: 'OK' }
  return { actions: [{ tool: 'Write', file_path: `${ctx.cwd}/result.txt`, content: `turn ${ctx.turn}\n` }], text: 'Work is complete.\nSTATUS: SUBMIT' }
}

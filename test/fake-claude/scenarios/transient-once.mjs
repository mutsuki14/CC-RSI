// Base scenario: the first message of each session fails with an F3-shaped transient API error
// (HTTP 529 overloaded); later messages (the recovery note) succeed and echo the recovery flag.
export default async function respond(ctx) {
  if (!ctx.history.some(t => t.apiError)) return { apiError: { status: 529, error: 'overloaded', text: 'API Error: 529 Overloaded' } }
  return { text: `RECOVERED ${ctx.recovering}` }
}

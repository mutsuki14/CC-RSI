// Base scenario: hangs for 60 s (killable: SIGINT → exit 130, SIGTERM → exit 143, no result).
export default async function respond() {
  return { hangMs: 60000, text: 'late' }
}

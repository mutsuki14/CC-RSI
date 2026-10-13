// Base scenario: every message gets the reply "OK" with no tool actions.
export default async function respond() {
  return { text: 'OK' }
}

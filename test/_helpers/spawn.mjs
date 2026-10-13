// Runs a Node script in a child process and captures its output (SPEC §15.1).

import { spawn } from 'node:child_process'

/**
 * `node <script> ...args` with `stdin` written and closed. Resolves
 * `{ code, stdout, stderr, signal, timedOut }`; a timeout kills the child (SIGKILL) and sets
 * `timedOut` (code is then null). `script` may also be a Node flag such as '--input-type=module'
 * with `args = ['-e', source]`.
 */
export function runNode(script, args = [], { stdin = '', env, cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), signal, timedOut })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(stdin)
  })
}

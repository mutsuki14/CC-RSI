#!/usr/bin/env node
// Test runner (SPEC §15): collects test/**/*.test.mjs and runs `node --test <files…>`.
//
// An explicit file list avoids Node 18's "run every .js file under a test directory" rule.
// test/e2e is excluded unless CC_RSI_E2E=1 (it drives the real `claude` with a real model).
//
// Usage: node scripts/run-tests.mjs [path…] [--node-flag…]
//   path    a test file or a directory to collect from (default: test/); relative to the repository
//   --flag  passed to node before --test (e.g. --test-reporter=spec on Node >= 19)

import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const E2E_DIR = join(ROOT, 'test', 'e2e')

/** Every *.test.mjs under `dir` (sorted, skipping node_modules and dot directories). */
function collect(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

function main(argv) {
  const flags = argv.filter(arg => arg.startsWith('-'))
  const paths = argv.filter(arg => !arg.startsWith('-'))
  const e2e = process.env.CC_RSI_E2E === '1'
  const targets = paths.length > 0 ? paths.map(p => resolve(ROOT, p)) : [join(ROOT, 'test')]
  const files = []
  for (const target of targets) {
    let info
    try {
      info = statSync(target)
    } catch {
      process.stderr.write(`run-tests: no such file or directory: ${relative(ROOT, target) || target}\n`)
      return Promise.resolve(2)
    }
    if (info.isDirectory()) collect(target, files)
    else files.push(target)
  }
  const selected = [...new Set(files)].filter(file => e2e || !isUnder(file, E2E_DIR))
  if (selected.length === 0) {
    process.stdout.write(e2e ? 'run-tests: no test files found\n' : 'run-tests: no test files selected (test/e2e runs only with CC_RSI_E2E=1)\n')
    return Promise.resolve(0)
  }
  const args = [...flags, '--test', ...selected.map(file => relative(ROOT, file))]
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
    const forward = signal => () => {
      try { child.kill(signal) } catch { /* already gone */ }
    }
    const onInt = forward('SIGINT')
    const onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    child.on('error', error => {
      process.stderr.write(`run-tests: cannot start node: ${error.message}\n`)
      resolvePromise(1)
    })
    child.on('close', (code, signal) => {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      resolvePromise(code ?? (signal ? 1 : 0))
    })
  })
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code
})

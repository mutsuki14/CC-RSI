// Import boundaries (SPEC §3): parses the import statements of every module and enforces the
// package rules, the hook hot-path rules (directly and through static imports), the role-guard
// rule, "lib/runtime/child.mjs is the only module that spawns claude", and zero dependencies.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function walk(dir, out = []) {
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names.sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.mjs')) out.push(full)
  }
  return out
}

const rel = p => relative(ROOT, p).split(sep).join('/')

/** Source without block comments and `//` comment lines (so prose never counts as an import). */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

/**
 * `{ static: [spec], dynamic: [spec], prefixes: [spec prefix] }` of one module: `import … from`,
 * `export … from`, bare `import '…'`, `import('…')`, and template `import(\`…${x}…\`)` prefixes.
 */
export function importsOf(text) {
  const src = code(text)
  const out = { static: [], dynamic: [], prefixes: [] }
  for (const m of src.matchAll(/^[ \t]*(?:import|export)\s[^;]*?\sfrom\s+(['"])([^'"\n]+)\1/gm)) out.static.push(m[2])
  for (const m of src.matchAll(/^[ \t]*import\s+(['"])([^'"\n]+)\1/gm)) out.static.push(m[2])
  for (const m of src.matchAll(/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)) out.dynamic.push(m[2])
  for (const m of src.matchAll(/\bimport\s*\(\s*`([^`$\n]*)\$\{/g)) out.prefixes.push(m[1])
  return out
}

const FILES = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'hooks')), ...walk(join(ROOT, 'mcp')), ...walk(join(ROOT, 'scripts'))]
const GRAPH = new Map()
for (const file of FILES) {
  const found = importsOf(readFileSync(file, 'utf8'))
  const resolveSpec = spec => (spec.startsWith('.') ? rel(resolve(dirname(file), spec)) : spec)
  GRAPH.set(rel(file), {
    static: found.static.map(resolveSpec),
    dynamic: found.dynamic.map(resolveSpec),
    prefixes: found.prefixes.map(p => (p.startsWith('.') ? `${rel(resolve(dirname(file), p.endsWith('/') ? `${p}x` : p))}`.replace(/x$/, '') : p)),
  })
}

const isNode = spec => spec.startsWith('node:')
const under = (target, dir) => target === dir || target.startsWith(`${dir}/`)

/** Violations of `allowed(target)` among a file's imports (static, dynamic and template prefixes). */
function violations(file, allowed) {
  const g = GRAPH.get(file)
  return [...g.static, ...g.dynamic, ...g.prefixes].filter(t => !isNode(t) && !allowed(t)).map(t => `${file} → ${t}`)
}

function filesIn(dir) {
  return [...GRAPH.keys()].filter(f => under(f, dir))
}

const HOOK_INTERACTIVE = ['session', 'requests', 'task', 'attest', 'wslock', 'memview'].map(n => `lib/interactive/${n}.mjs`)

function hookAllowed(t) {
  return under(t, 'lib/core') || under(t, 'lib/guard') || HOOK_INTERACTIVE.includes(t) || under(t, 'lib/prompts') || under(t, 'lib/memory')
    || t === 'lib/workspace/git.mjs' || t === 'lib/runtime/sandbox.mjs' || t === 'lib/runtime/models.mjs' || t === 'lib/cli/shim.mjs'
    || under(t, 'lib/hooks')
}

describe('import boundaries (SPEC §3)', () => {
  it('parses the import forms used in this repository', () => {
    const found = importsOf("import { a } from './a.mjs'\nimport {\n  b,\n  c,\n} from \"../b.mjs\"\nexport { d } from './d.mjs'\nimport './side.mjs'\n// import x from './comment.mjs'\nconst m = await import('./lazy.mjs')\nawait import(`../lib/hooks/${sub}.mjs`)\n")
    assert.deepEqual(found.static.sort(), ['../b.mjs', './a.mjs', './d.mjs', './side.mjs'])
    assert.deepEqual(found.dynamic, ['./lazy.mjs'])
    assert.deepEqual(found.prefixes, ['../lib/hooks/'])
  })

  it('every import is node:* or a repository module (zero dependencies)', () => {
    const bad = []
    for (const [file, g] of GRAPH) {
      for (const t of [...g.static, ...g.dynamic]) if (!isNode(t) && !t.startsWith('lib/') && !t.startsWith('hooks/') && !t.startsWith('mcp/')) bad.push(`${file} → ${t}`)
    }
    assert.deepEqual(bad, [])
  })

  it('lib/core imports only node:* (and its own siblings)', () => {
    assert.deepEqual(filesIn('lib/core').flatMap(f => violations(f, t => under(t, 'lib/core'))), [])
  })

  it('lib/memory, lib/protocol and lib/workspace import only node:*, lib/core and their own package', () => {
    for (const pkg of ['lib/memory', 'lib/protocol', 'lib/workspace']) {
      assert.deepEqual(filesIn(pkg).flatMap(f => violations(f, t => under(t, 'lib/core') || under(t, pkg))), [], pkg)
    }
  })

  it('lib/guard imports node:* and lib/core; lib/prompts adds lib/protocol', () => {
    assert.deepEqual(filesIn('lib/guard').flatMap(f => violations(f, t => under(t, 'lib/core') || under(t, 'lib/guard'))), [])
    assert.deepEqual(filesIn('lib/prompts').flatMap(f => violations(f, t => under(t, 'lib/core') || under(t, 'lib/protocol') || under(t, 'lib/prompts'))), [])
  })

  it('lib/runtime imports node:*, lib/core, lib/guard, lib/prompts and lib/memory/hash.mjs', () => {
    const allowed = t => under(t, 'lib/core') || under(t, 'lib/guard') || under(t, 'lib/prompts') || t === 'lib/memory/hash.mjs' || under(t, 'lib/runtime')
    assert.deepEqual(filesIn('lib/runtime').flatMap(f => violations(f, allowed)), [])
  })

  it('hooks import only their hot-path set and never reach lib/engine or the role runtime', () => {
    const hookFiles = [...filesIn('lib/hooks'), ...filesIn('hooks').filter(f => f !== 'hooks/role-guard.mjs')]
    assert.ok(hookFiles.length > 0 || GRAPH.size > 0)
    assert.deepEqual(hookFiles.flatMap(f => violations(f, hookAllowed)), [])
    // Static closure: nothing loaded on a hook's hot path pulls in the engine, child.mjs or context.mjs.
    const forbidden = t => under(t, 'lib/engine') || t === 'lib/runtime/child.mjs' || t === 'lib/runtime/context.mjs'
    const bad = []
    for (const entry of hookFiles) {
      const seen = new Set([entry])
      const queue = [entry]
      while (queue.length > 0) {
        const file = queue.shift()
        for (const t of GRAPH.get(file)?.static ?? []) {
          if (isNode(t) || seen.has(t)) continue
          seen.add(t)
          if (forbidden(t)) bad.push(`${entry} ⇒ … ⇒ ${t} (via ${file})`)
          queue.push(t)
        }
      }
    }
    assert.deepEqual(bad, [])
  })

  it('hooks/role-guard.mjs imports only lib/core and lib/guard', () => {
    if (!GRAPH.has('hooks/role-guard.mjs')) return
    assert.deepEqual(violations('hooks/role-guard.mjs', t => under(t, 'lib/core') || under(t, 'lib/guard')), [])
  })

  it('lib/cli/shim.mjs (loaded by SessionStart) imports only node:* and lib/core', () => {
    assert.deepEqual(violations('lib/cli/shim.mjs', t => under(t, 'lib/core')), [])
  })

  it('lib/engine never imports lib/interactive, lib/mcp or lib/hooks; lib/interactive never imports lib/engine', () => {
    assert.deepEqual(filesIn('lib/engine').flatMap(f => violations(f, t => !under(t, 'lib/interactive') && !under(t, 'lib/mcp') && !under(t, 'lib/hooks'))), [])
    assert.deepEqual(filesIn('lib/interactive').flatMap(f => violations(f, t => !under(t, 'lib/engine'))), [])
  })

  it('lib/runtime/child.mjs is the only module that spawns claude', () => {
    const bad = []
    for (const file of GRAPH.keys()) {
      if (file === 'lib/runtime/child.mjs') continue
      const src = code(readFileSync(join(ROOT, file), 'utf8'))
      for (const m of src.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|runCapture|spawnDetached)\s*\(\s*([^,)]+)/g)) {
        if (/claude|\bbin\b|claudeBin/i.test(m[2])) bad.push(`${file}: ${m[0]}`)
      }
    }
    assert.deepEqual(bad, [])
  })
})

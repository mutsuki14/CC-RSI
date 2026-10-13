// Prompt template loading and rendering (SPEC §8.1).
//
// Templates are plain Markdown/text files in <pluginRoot>/prompts with `{{UPPER_SNAKE}}`
// placeholders. There is no conditional or loop syntax: conditional fragments are separate files,
// or `## <slug>` sections of one file that builders render with `renderSection` (a cc-rsi
// addition for the families SPEC §8.3 keeps in one file, e.g. one section per refusal kind).
// Rendering is strict: a missing variable and a variable passed but unused are both errors
// (they catch builder typos). Values are inserted verbatim in a single pass, so a value that
// itself contains `{{X}}` (a report, a task) is never re-expanded. A lineage renders from its own
// snapshot of the templates (`snapshotPrompts` + `setPromptsDir`), so a plugin update never
// changes the text a running lineage sends (SPEC §12.2, §12.4).

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, fsyncDir, writeFileAtomic } from '../core/atomic.mjs'
import { sha256Hex } from '../core/digest.mjs'

/** Raised for unknown templates or sections, unreadable files, and placeholder mismatches. */
export class PromptError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PromptError'
    this.code = 'prompt'
    this.details = details
  }
}

/** Every template in prompts/ without '.md' (SPEC §8.3), sorted. */
export const PROMPT_NAMES = Object.freeze([
  'actor-protocol', 'actor-protocol-frozen', 'actor-protocol-learn', 'actor-protocol-unverified',
  'actor-runtime-contract', 'conflict', 'continuation-recovery', 'continuation-stall',
  'continuation-transport', 'continuation-truncated', 'curriculum-continuation',
  'curriculum-runtime-contract', 'curriculum-system', 'deep-charter', 'deep-charter-defaults',
  'deep-charter-memory-none', 'diagnosis', 'disagreement', 'disagreement-tail-engine',
  'disagreement-tail-interactive', 'distillation', 'distillation-tail-actor', 'distillation-tail-engine',
  'engine-system', 'epistemic', 'frozen-actor-opening', 'guidance-commit', 'guidance-fail-tail',
  'guidance-harness-note', 'guidance-infra', 'guidance-pass', 'guidance-refusals', 'guidance-running',
  'guidance-unverified-tail', 'leads-request-engine', 'leads-request-interactive', 'lifecycle-transition',
  'limit-condense', 'memory-preamble', 'memory-preamble-empty', 'memory-revisit-fold',
  'memory-revisit-recovery', 'memory-revisit-stagnation', 'memory-revisit-verifier', 'notes-block',
  'outcome', 'phase1-recovery-notice', 'practice-actor-charter', 'reconciliation',
  'reconciliation-tail-actor', 'reconciliation-tail-engine', 'repeat-warning', 'resume-appendix',
  'resume-handoff', 'resume-pivot', 'strategy-review-ask', 'strategy-review-system', 'summarizer-request',
  'summarizer-system', 'target-actor-opening', 'target-outcome', 'task-pin', 'unverified',
  'unverified-tail-engine', 'unverified-tail-interactive', 'verifier-charter', 'verifier-charter-changed',
  'verifier-charter-continuity', 'verifier-charter-continuity-other', 'verifier-charter-handover-reports',
  'verifier-charter-leads', 'verifier-charter-original-fixtures', 'verifier-charter-prior-reports',
  'verifier-continuation', 'verifier-mechanics-live-rollback', 'verifier-mechanics-live-sandbox',
  'verifier-mechanics-replay-sandbox', 'verifier-mechanics-replay-unconfined', 'verifier-practice-context-1',
  'verifier-practice-context-2', 'verifier-practice-context-evidence', 'verifier-private', 'verifier-system',
  'verifier-unverified-clause', 'wave-charter', 'wave-charter-distribution', 'wave-charter-first',
  'wave-continuation', 'wave-outcomes',
].sort())

const KNOWN = new Set(PROMPT_NAMES)
const PLUGIN_PROMPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts')
const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g
const SECTION_HEADING = /^## ([a-z0-9][a-z0-9_-]*)[ \t]*$/

let currentDir = PLUGIN_PROMPTS
const cache = new Map()
const loaded = new Set()

/** `<pluginRoot>/prompts`, resolved from this module's location. */
export function promptsDir() {
  return PLUGIN_PROMPTS
}

/** The directory templates are currently rendered from (the plugin dir or a lineage snapshot). */
export function activePromptsDir() {
  return currentDir
}

/** Renders from `dir` from now on (the engine passes its lineage snapshot); a falsy dir resets. */
export function setPromptsDir(dir) {
  currentDir = dir ? resolve(String(dir)) : PLUGIN_PROMPTS
  cache.clear()
}

/** Sync read + cache of one template: `{ text, sha256 }`. Unknown names throw PromptError. */
export function loadTemplate(name) {
  if (typeof name !== 'string' || !KNOWN.has(name)) throw new PromptError(`unknown prompt template "${String(name)}"`)
  const key = `${currentDir}\u0000${name}`
  let entry = cache.get(key)
  if (entry === undefined) {
    const file = join(currentDir, `${name}.md`)
    let bytes
    try {
      bytes = readFileSync(file)
    } catch (error) {
      throw new PromptError(`prompt template "${name}" cannot be read from ${currentDir}: ${error?.code ?? error}`, { name, dir: currentDir })
    }
    entry = Object.freeze({ text: bytes.toString('utf8'), sha256: sha256Hex(bytes) })
    cache.set(key, entry)
  }
  loaded.add(name)
  return entry
}

/** Names of the templates loaded so far in this process (diagnostics and the coverage test). */
export function loadedTemplateNames() {
  return [...loaded].sort()
}

function substitute(where, text, vars) {
  if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new PromptError(`${where}: variables must be an object`)
  }
  const values = new Map()
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === 'string') values.set(key, value)
    else if (typeof value === 'number' && Number.isFinite(value)) values.set(key, String(value))
    else throw new PromptError(`${where}: variable ${key} must be a string (got ${value === null ? 'null' : typeof value})`)
  }
  const used = new Set()
  const missing = new Set()
  const out = text.replace(PLACEHOLDER, (match, key) => {
    if (!values.has(key)) {
      missing.add(key)
      return match
    }
    used.add(key)
    return values.get(key)
  })
  if (missing.size > 0) throw new PromptError(`${where}: missing variable(s) ${[...missing].join(', ')}`)
  const unused = [...values.keys()].filter(key => !used.has(key))
  if (unused.length > 0) throw new PromptError(`${where}: variable(s) passed but not used: ${unused.join(', ')}`)
  return out
}

/**
 * Renders a whole template. Placeholders are `{{UPPER_SNAKE}}`; a missing or an unused variable
 * throws PromptError; values are inserted verbatim; `{{` without a closing `}}` is literal; the
 * file's trailing newline is kept.
 */
export function render(name, vars = {}) {
  return substitute(`prompt "${name}"`, loadTemplate(name).text, vars)
}

function parseSections(name, text) {
  const sections = new Map()
  let current = null
  let lines = []
  const close = () => {
    if (current === null) return
    let start = 0
    let end = lines.length
    while (start < end && lines[start].trim() === '') start++
    while (end > start && lines[end - 1].trim() === '') end--
    sections.set(current, lines.slice(start, end).join('\n'))
  }
  for (const line of text.split(/\r?\n/)) {
    const heading = SECTION_HEADING.exec(line)
    if (heading) {
      close()
      if (sections.has(heading[1])) throw new PromptError(`prompt "${name}" repeats section "${heading[1]}"`)
      current = heading[1]
      lines = []
      continue
    }
    if (current !== null) lines.push(line)
  }
  close()
  return sections
}

/** The `## <slug>` section names of a template, in file order. */
export function templateSections(name) {
  return [...parseSections(name, loadTemplate(name).text).keys()]
}

/**
 * Renders one `## <slug>` section of a template (leading and trailing blank lines of the section
 * removed, no trailing newline) with the same strict placeholder rules as `render`.
 */
export function renderSection(name, section, vars = {}) {
  const sections = parseSections(name, loadTemplate(name).text)
  if (!sections.has(section)) throw new PromptError(`prompt "${name}" has no section "${section}"`)
  return substitute(`prompt "${name}" section "${section}"`, sections.get(section), vars)
}

/** `{ [name]: sha256 }` of the templates in the active directory. */
export function bundleSha() {
  const out = {}
  for (const name of PROMPT_NAMES) out[name] = loadTemplate(name).sha256
  return out
}

/**
 * Copies every template from the plugin's prompts/ into `destDir` (a lineage snapshot), each
 * written atomically with mode 0600 in a 0700 directory. Returns `{ [name]: sha256 }` of the bytes
 * written. Reads all sources first, so a missing template leaves no partial snapshot behind.
 */
export async function snapshotPrompts(destDir) {
  const target = resolve(String(destDir))
  const sources = []
  for (const name of PROMPT_NAMES) {
    let bytes
    try {
      bytes = readFileSync(join(PLUGIN_PROMPTS, `${name}.md`))
    } catch (error) {
      throw new PromptError(`prompt template "${name}" cannot be read from ${PLUGIN_PROMPTS}: ${error?.code ?? error}`, { name })
    }
    sources.push([name, bytes])
  }
  await ensureDir(target, 0o700)
  const shas = {}
  for (const [name, bytes] of sources) {
    await writeFileAtomic(join(target, `${name}.md`), bytes, { mode: 0o600 })
    shas[name] = sha256Hex(bytes)
  }
  await fsyncDir(target)
  return shas
}

// `cc-rsi memory …` (SPEC §13.1): inspect the project memory store and apply the human-only
// remedies of SPEC §6.6 (accept an external change, restore a history snapshot), freeze and
// unfreeze (Phase-3 ordering, §13.4), export/import, and the draft listing.
//
// Read-only subcommands (show, inventory, history, log, verify, drafts, export) use a store handle
// without open-time recovery, so the `/cc-rsi:memory` skill never changes anything. Every change goes
// through MemoryStore (canonical memory changes only through commits; trust boundary 5).

import { randomBytes } from 'node:crypto'
import { lstat, readdir, readFile, realpath, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { exists, readJsonSafe } from '../core/atomic.mjs'
import { UsageError } from '../core/errors.mjs'
import { compactStamp } from '../core/ids.mjs'
import { isUnderLexical, safeName } from '../core/paths.mjs'
import { formatInventory } from '../memory/inventory.mjs'
import { safeRelativePath } from '../memory/safe-path.mjs'
import { diffManifests, loadTree, scanTree, writeTree } from '../memory/tree.mjs'
import { materializeView } from '../memory/view.mjs'
import { removeTree } from '../workspace/copy.mjs'
import { EXIT, intOption, onlyOptions, openStore, parseArgs, projectContext, refusal, requireHuman, say, storeOptions } from './main.mjs'

const SPEC = { string: ['project', 'session', 'n'], boolean: ['accept-external', 'after-sealed', 'prune'], alias: { n: 'n' } }

const USAGE = 'usage: cc-rsi memory show [<rel>] | inventory | history | log [-n N] | verify [--accept-external] | restore <N> | freeze | unfreeze [--after-sealed] | export <dir> | import <dir> | drafts [--prune]'

const short = hash => (typeof hash === 'string' ? hash.slice(0, 12) : String(hash))

/** A store handle without recovery (read-only commands). */
async function peekStore(ctx) {
  const { MemoryStore } = await import('../memory/store.mjs')
  return new MemoryStore(ctx.pl.store, storeOptions(ctx.config, ctx.pl, { lockWaitMs: 5000 }))
}

function describeDelta(record) {
  const parts = []
  for (const [label, list] of [['created', record.created], ['modified', record.modified], ['deleted', record.deleted]]) {
    if (Array.isArray(list) && list.length > 0) parts.push(`${label}: ${list.slice(0, 20).join(', ')}${list.length > 20 ? ` … ${list.length - 20} more` : ''}`)
  }
  return parts.length > 0 ? parts.join('; ') : 'no file changes'
}

function recordLine(r) {
  const delta = `+${r.created?.length ?? 0} ~${r.modified?.length ?? 0} -${r.deleted?.length ?? 0}`
  const outcome = r.outcome ? ` ${r.outcome}` : ''
  const lineage = r.lineage ? ` lineage ${r.lineage}` : ''
  return `#${r.seq ?? '?'}  ${r.ts ?? '?'}  ${r.kind ?? '?'}${outcome}  ${r.episode}  ${short(r.treeBefore)}→${short(r.treeAfter)}  ${delta}${lineage}`
}

async function noStore(ctx, io) {
  if (await exists(ctx.pl.store)) return false
  say(io, `no memory store for project ${ctx.key} yet (memory is empty)`)
  return true
}

// ---------------------------------------------------------------- read-only

async function inventory(ctx, io, { header = true } = {}) {
  if (await noStore(ctx, io)) return EXIT.ok
  const store = await peekStore(ctx)
  try {
    const inv = await store.inventory()
    if (header) say(io, `memory of ${ctx.key}: ${inv.files.length} files, ${inv.totalBytes ?? 0} bytes, tree ${inv.treeSha256}`)
    for (const line of formatInventory(inv.files, inv.files.length).lines) say(io, line)
    return EXIT.ok
  } finally {
    await store.close()
  }
}

async function show(ctx, io, rel) {
  if (rel === undefined) return inventory(ctx, io)
  if (await noStore(ctx, io)) return EXIT.error
  const safe = safeRelativePath(rel)
  const memoryDir = join(ctx.pl.store, 'memory')
  const target = join(memoryDir, safe)
  // Never follow a link out of canonical memory (the tree itself refuses links; this is defence in depth).
  const realRoot = await realpath(memoryDir).catch(() => null)
  const realTarget = await realpath(target).catch(() => null)
  const info = await lstat(target).catch(() => null)
  if (!info || realRoot === null || realTarget === null || !isUnderLexical(realTarget, realRoot)) {
    say(io, `no memory file ${safe}`)
    return EXIT.error
  }
  if (info.isDirectory()) {
    const store = await peekStore(ctx)
    try {
      const inv = await store.inventory()
      const files = inv.files.filter(f => f.path.startsWith(`${safe}/`))
      say(io, `${safe}/: ${files.length} files`)
      for (const line of formatInventory(files, files.length).lines) say(io, line)
    } finally {
      await store.close()
    }
    return EXIT.ok
  }
  if (!info.isFile()) {
    say(io, `${safe} is not a regular file`)
    return EXIT.error
  }
  const data = await readFile(target)
  if (data.includes(0)) say(io, `${safe}: binary file, ${data.length} bytes`)
  else io.stdout.write(data.toString('utf8').endsWith('\n') || data.length === 0 ? data.toString('utf8') : `${data.toString('utf8')}\n`)
  return EXIT.ok
}

async function history(ctx, io) {
  if (await noStore(ctx, io)) return EXIT.ok
  const store = await peekStore(ctx)
  try {
    const snapshots = await store.history()
    const journal = await store.journal()
    if (snapshots.length === 0) say(io, 'no history snapshots')
    for (const s of snapshots) {
      const r = journal.find(entry => entry.seq === s.n)
      say(io, `${String(s.n).padStart(4, '0')}  tree ${short(s.treeSha256)}  ${s.at ?? '?'}${r ? `  ${r.kind} ${r.episode}` : ''}`)
    }
    if (snapshots.length > 0) say(io, 'restore one (human-only): cc-rsi memory restore <N>')
    return EXIT.ok
  } finally {
    await store.close()
  }
}

async function log(ctx, io, n) {
  if (await noStore(ctx, io)) return EXIT.ok
  const store = await peekStore(ctx)
  try {
    const journal = await store.journal()
    if (journal.length === 0) say(io, 'no commits yet')
    for (const r of journal.slice(-n)) say(io, recordLine(r))
    return EXIT.ok
  } finally {
    await store.close()
  }
}

/** The files that differ between the last committed tree (history snapshot) and canonical memory. */
async function tamperDelta(ctx, expected) {
  try {
    const journal = await readFile(join(ctx.pl.store, 'journal.jsonl'), 'utf8').catch(() => '')
    let seq = null
    for (const line of journal.split('\n')) {
      try {
        const r = JSON.parse(line)
        if (r && r.treeAfter === expected && Number.isInteger(r.seq)) seq = r.seq
      } catch { /* torn line */ }
    }
    const before = seq === null ? (expected === (await import('../memory/hash.mjs')).EMPTY_TREE_SHA256 ? {} : null) : (await scanTree(join(ctx.pl.store, 'history', String(seq).padStart(4, '0')))).files
    if (before === null) return null
    const after = (await scanTree(join(ctx.pl.store, 'memory'))).files
    return diffManifests(before, after)
  } catch {
    return null
  }
}

async function verify(ctx, io, { acceptExternal }) {
  if (acceptExternal) {
    requireHuman(io, 'memory verify --accept-external')
    const store = await openStore(ctx)
    try {
      const record = await store.acceptExternal({ by: 'cli' })
      if (record === null) say(io, 'nothing to accept: canonical memory matches its last commit')
      else say(io, `accepted the external change as commit #${record.seq} (${record.episode}): tree ${short(record.treeBefore)} → ${short(record.treeAfter)}; ${describeDelta(record)}`)
      return EXIT.ok
    } finally {
      await store.close()
    }
  }
  if (await noStore(ctx, io)) return EXIT.ok
  const store = await peekStore(ctx)
  try {
    // The shared lock-free rule (memory-crash-10): an install in flight is not tamper.
    const { expected, actual, intact } = await store.integrity()
    const commits = (await store.journal()).length
    const frozen = await store.frozen()
    // While frozen, only the snapshot of the frozen tree can be restored and no external change can
    // be accepted (memory-crash-8): name the remedy that works.
    const frozenRemedy = async () => {
      const snapshot = frozen?.treeHash ? [...(await store.history())].reverse().find(h => h.treeSha256 === frozen.treeHash) : null
      return snapshot
        ? `remedy (human-only, in a terminal): cc-rsi memory restore ${snapshot.n} (reinstates the frozen tree from its history snapshot)`
        : 'no history snapshot holds the frozen tree; copy the frozen tree back into canonical memory by hand'
    }
    let code = EXIT.ok
    if (intact) {
      say(io, `memory intact: tree ${actual} (${commits} commits)`)
    } else {
      code = EXIT.error
      say(io, `CHANGED OUTSIDE A COMMIT: canonical memory has tree ${actual}, but the last commit recorded ${expected}`)
      const delta = await tamperDelta(ctx, expected)
      if (delta) say(io, `differences: ${describeDelta(delta)}`)
      if (frozen) {
        say(io, await frozenRemedy())
      } else {
        say(io, 'remedies (human-only, in a terminal): cc-rsi memory verify --accept-external (keep the change as a recorded commit)')
        say(io, '                                     cc-rsi memory restore <N> (roll back to a history snapshot; see cc-rsi memory history)')
      }
    }
    if (frozen) {
      try {
        await store.assertFrozenIntact()
        say(io, `frozen at tree ${frozen.treeHash} since ${frozen.frozenAt ?? '?'} (intact)`)
      } catch (error) {
        code = EXIT.error
        say(io, `FROZEN MEMORY MUTATED: ${error.message}`)
        if (intact) say(io, await frozenRemedy())
      }
    }
    const sealed = await store.sealed()
    if (sealed) say(io, `sealed: ${sealed.runs.length} sealed evaluation run(s)${sealed.learningAfterSealed ? '; learning reopened after them (--after-sealed)' : '; learning is closed'}`)
    return code
  } finally {
    await store.close()
  }
}

async function drafts(ctx, io, { prune }) {
  if (prune) requireHuman(io, 'memory drafts --prune')
  if (await noStore(ctx, io)) return EXIT.ok
  const store = prune ? await openStore(ctx) : await peekStore(ctx)
  try {
    const list = await store.drafts()
    if (list.length === 0) say(io, 'no memory drafts')
    for (const d of list) {
      const keep = prune ? await keepOnPrune(ctx, d) : null
      const owner = d.owner?.kind === 'session' ? `session ${d.owner.sessionId}` : d.owner?.kind === 'engine' ? `engine pid ${d.owner.pid}${d.owner.lineage ? ` (lineage ${d.owner.lineage})` : ''}` : 'unknown owner'
      const state = [d.live ? 'live' : 'owner gone', d.dirExists ? 'dir present' : 'dir missing', d.committed ? 'committed' : null].filter(Boolean).join(', ')
      if (prune && keep === null) {
        await store.discardDraft(d.episode)
        say(io, `pruned ${d.episode} (${owner}; ${state})`)
      } else {
        say(io, `${d.episode}  ${owner}  ${state}  ${d.createdAt ?? '?'}  ${d.dir}${keep ? `  kept: ${keep}` : ''}`)
      }
    }
    // Only drafts of gone owners or committed episodes are abandoned: a live owner's missing
    // directory or pending rebase is finished by the next rebaseDraft/openDraft (memory-crash-4/-5).
    if (!prune && list.some(d => !d.live || d.committed)) say(io, 'abandoned drafts (owner gone or episode committed) are removed by cc-rsi memory drafts --prune (human-only) or the next store recovery')
    return EXIT.ok
  } finally {
    await store.close()
  }
}

/**
 * Why `--prune` keeps a draft, or null to discard it. Kept: drafts whose engine is running or whose
 * lineage is paused (resume continues them, SPEC §12.8), and session drafts of an open learning
 * phase in a session that has not ended (SPEC §11.10).
 */
async function keepOnPrune(ctx, d) {
  if (!d.live || d.committed) return null
  const owner = d.owner ?? {}
  // A running or paused engine's draft is kept even with its directory missing or its rebase
  // pending: resume finishes it (memory-crash-4/-5; pruning would delete the Actor's .prev).
  if (owner.kind === 'engine') return owner.lineage ? `lineage ${owner.lineage} may resume it` : 'its engine is running'
  if (!d.dirExists && !d.rebasing) return null
  if (owner.kind === 'session' && typeof owner.sessionId === 'string') {
    const dir = join(ctx.pl.sessions, safeName(owner.sessionId))
    const session = await readJsonSafe(join(dir, 'session.json'), null)
    const task = await readJsonSafe(join(dir, 'task.json'), null)
    const open = task?.learning && task.learning.episode === d.episode
    if (open && !session?.endedAt) return `session ${owner.sessionId} has this learning phase open`
    return null
  }
  return null
}

// ---------------------------------------------------------------- changes

async function restore(ctx, io, n) {
  requireHuman(io, 'memory restore')
  if (!/^\d+$/.test(String(n ?? ''))) throw new UsageError('usage: cc-rsi memory restore <N> (see cc-rsi memory history)')
  const store = await openStore(ctx)
  try {
    const record = await store.restoreHistory(Number.parseInt(n, 10), { by: 'cli' })
    say(io, `restored history snapshot ${n} as commit #${record.seq}: tree ${short(record.treeBefore)} → ${short(record.treeAfter)}; ${describeDelta(record)}`)
    return EXIT.ok
  } finally {
    await store.close()
  }
}

async function freeze(ctx, io) {
  const store = await openStore(ctx)
  try {
    const before = await store.frozen()
    const { treeHash } = await store.freeze({ by: 'cli' })
    say(io, before?.treeHash ? `memory was already frozen at tree ${treeHash}` : `memory frozen at tree ${treeHash} (Phase-3 reuse: learning lineages and interactive learning are closed)`)
    say(io, 'unfreezing is human-only: run cc-rsi memory unfreeze in a terminal')
    return EXIT.ok
  } finally {
    await store.close()
  }
}

async function unfreeze(ctx, io, { afterSealed }) {
  requireHuman(io, 'memory unfreeze')
  const store = await openStore(ctx)
  try {
    const frozen = await store.frozen()
    const sealed = await store.sealed()
    if (!frozen && !(sealed && afterSealed && !sealed.learningAfterSealed)) {
      say(io, 'memory is not frozen')
      return EXIT.ok
    }
    await store.unfreeze({ afterSealed })
    say(io, 'memory unfrozen: learning may change it again')
    if (sealed && afterSealed) say(io, 'learning after a sealed evaluation is now open; later lineage results record learning_after_sealed_evaluation: true')
    return EXIT.ok
  } finally {
    await store.close()
  }
}

async function exportMemory(ctx, io, dir) {
  if (typeof dir !== 'string' || dir === '') throw new UsageError('usage: cc-rsi memory export <dir>')
  const dest = resolve(io.cwd, dir)
  if (isUnderLexical(dest, ctx.home)) throw refusal(`refusing to export into the cc-rsi home (${ctx.home}); choose a directory outside it`)
  const info = await lstat(dest).catch(() => null)
  if (info && (!info.isDirectory() || (await readdir(dest)).length > 0)) throw refusal(`${dest} exists and is not an empty directory`)
  if (await noStore(ctx, io)) return EXIT.ok
  const store = await peekStore(ctx)
  try {
    const expected = await store.expectedTreeHash()
    const { treeSha256 } = await materializeView(store.memoryDir, dest, { readOnly: false })
    const files = Object.keys((await scanTree(dest)).files).length
    say(io, `exported ${files} files (tree ${treeSha256}) to ${dest}`)
    if (treeSha256 !== expected) say(io, `warning: canonical memory differs from its last commit (${expected}); run cc-rsi memory verify`)
    return EXIT.ok
  } finally {
    await store.close()
  }
}

/**
 * Replaces the contents of an open draft directory, never the directory itself (memory-crash-4: a
 * live draft is never without its directory): the new tree is written beside it, then the old
 * entries are removed and the new ones renamed in.
 */
async function replaceDraftContents(dir, contents, fileMode) {
  const staging = `${dir}.import-${randomBytes(4).toString('hex')}`
  await writeTree(staging, contents, { fileMode, dirMode: 0o700 })
  try {
    for (const name of await readdir(dir)) await removeTree(join(dir, name))
    for (const name of await readdir(staging)) await rename(join(staging, name), join(dir, name))
  } finally {
    await removeTree(staging).catch(() => undefined)
  }
}

async function importMemory(ctx, io, dir) {
  requireHuman(io, 'memory import')
  if (typeof dir !== 'string' || dir === '') throw new UsageError('usage: cc-rsi memory import <dir>')
  const src = resolve(io.cwd, dir)
  const info = await lstat(src).catch(() => null)
  if (!info || !info.isDirectory()) throw new UsageError(`${src} is not a directory`)
  // Regular files with safe names only (symlinks, special files and unsafe names are refused).
  const tree = await loadTree(src)
  const contents = {}
  for (const [rel, { data }] of Object.entries(tree)) contents[rel] = data
  const store = await openStore(ctx)
  const episode = `import-${compactStamp()}-${randomBytes(3).toString('hex')}`
  let committed = false
  try {
    await store.assertCanonicalIntact()
    // A CLI-owned draft: pid liveness (like an engine draft without a lineage), so a crashed
    // import is swept by the next store recovery.
    const draft = await store.openDraft(episode, { fresh: true, owner: { kind: 'engine', pid: process.pid } })
    await replaceDraftContents(draft.dir, contents, rel => ((tree[rel].mode & 0o100) ? 0o700 : 0o600))
    const record = await store.commit(episode, { kind: 'external', outcome: null, origin: null, lineage: null })
    committed = true
    say(io, `imported ${record.files} files from ${src} as commit #${record.seq} (${episode}): tree ${short(record.treeBefore)} → ${short(record.treeAfter)}; ${describeDelta(record)}`)
    return EXIT.ok
  } finally {
    if (!committed) await store.discardDraft(episode).catch(() => undefined)
    await store.close()
  }
}

export async function run(args, io) {
  const { positionals, options } = parseArgs(args, SPEC)
  // A bare `cc-rsi memory` (e.g. /cc-rsi:memory without arguments) shows the inventory.
  const [sub = 'show', ...rest] = positionals
  const allowed = {
    show: ['project', 'session'],
    inventory: ['project', 'session'],
    history: ['project', 'session'],
    log: ['project', 'session', 'n'],
    verify: ['project', 'session', 'accept-external'],
    restore: ['project', 'session'],
    freeze: ['project', 'session'],
    unfreeze: ['project', 'session', 'after-sealed'],
    export: ['project', 'session'],
    import: ['project', 'session'],
    drafts: ['project', 'session', 'prune'],
  }
  if (!sub || !allowed[sub]) throw new UsageError(USAGE)
  onlyOptions(options, allowed[sub], `memory ${sub}`)
  const maxPositionals = { show: 1, restore: 1, export: 1, import: 1 }
  if (rest.length > (maxPositionals[sub] ?? 0)) throw new UsageError(USAGE)
  // Human-only refusals come before any file access.
  if (sub === 'restore') requireHuman(io, 'memory restore')
  if (sub === 'unfreeze') requireHuman(io, 'memory unfreeze')
  if (sub === 'import') requireHuman(io, 'memory import')
  if (sub === 'verify' && options['accept-external']) requireHuman(io, 'memory verify --accept-external')
  if (sub === 'drafts' && options.prune) requireHuman(io, 'memory drafts --prune')
  const ctx = await projectContext(io, { project: options.project, session: options.session })
  switch (sub) {
    case 'show': return show(ctx, io, rest[0])
    case 'inventory': return inventory(ctx, io)
    case 'history': return history(ctx, io)
    case 'log': return log(ctx, io, Math.max(1, intOption(options, 'n', 20)))
    case 'verify': return verify(ctx, io, { acceptExternal: options['accept-external'] === true })
    case 'restore': return restore(ctx, io, rest[0])
    case 'freeze': return freeze(ctx, io)
    case 'unfreeze': return unfreeze(ctx, io, { afterSealed: options['after-sealed'] === true })
    case 'export': return exportMemory(ctx, io, rest[0])
    case 'import': return importMemory(ctx, io, rest[0])
    case 'drafts': return drafts(ctx, io, { prune: options.prune === true })
    default: throw new UsageError(USAGE)
  }
}

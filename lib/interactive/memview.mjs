// The main Actor's read-only memory view (SPEC §11.10; J2-3).
//
// The main session never sees the canonical tree: it reads a materialized copy
// `<P>/views/<sid>/memory` (files 0444, dirs 0555) that is rebuilt whenever it differs from
// committed memory. Edits made to the view (e.g. through Bash) are therefore discarded by
// construction at the next refresh, which is RSIAgent's discard-by-construction of work-phase
// memory edits (analysis/memory-learning.md §2: a fresh copy is pushed into every workspace).
// The view always shows COMMITTED memory: when canonical changed outside a commit (SPEC §6.6), the
// history snapshot of the last journal `treeAfter` is materialized instead (memory changes only
// through commits, SPEC §2 boundary 5).

import { join } from 'node:path'
import { readJsonSafe, readJsonSafeSync, writeJsonAtomic } from '../core/atomic.mjs'
import { EMPTY_TREE_SHA256 } from '../memory/hash.mjs'
import { listTree } from '../memory/tree.mjs'
import { materializeView, viewTreeHash } from '../memory/view.mjs'

/** The history snapshot directory holding `treeSha256` (SPEC §6.2 `history/<NNNN>/`), or null. */
async function committedSnapshot(store, treeSha256) {
  if (treeSha256 === EMPTY_TREE_SHA256) return join(store.root, 'history', '.empty-tree') // missing → an empty view
  let snapshots = []
  try {
    snapshots = await store.history()
  } catch {
    return null
  }
  const hit = [...snapshots].reverse().find(s => s.treeSha256 === treeSha256)
  return hit ? join(store.root, 'history', String(hit.n).padStart(4, '0')) : null
}

/**
 * Re-materializes `viewDir` when its tree hash differs from committed memory, then records
 * `view.json` `{treeSha256, at}`. `store` is a MemoryStore. Returns `{ changed, treeSha256, tampered }`;
 * when canonical memory was changed outside a commit and no committed snapshot exists, the current
 * view is kept unchanged.
 */
export async function refreshView({ store, viewDir, viewJson }) {
  const expected = await store.expectedTreeHash()
  let actual = null
  try {
    actual = await store.treeHash()
  } catch {
    actual = null
  }
  const tampered = actual !== expected
  const current = await viewTreeHash(viewDir)
  if (current !== null && current === expected) {
    const recorded = await readJsonSafe(viewJson, null)
    if (!recorded || recorded.treeSha256 !== current) await writeJsonAtomic(viewJson, { v: 1, treeSha256: current, at: new Date().toISOString() })
    return { changed: false, treeSha256: current, tampered }
  }
  const source = tampered ? await committedSnapshot(store, expected) : store.memoryDir
  if (source === null) return { changed: false, treeSha256: current, tampered }
  const { treeSha256 } = await materializeView(source, viewDir, { readOnly: true })
  await writeJsonAtomic(viewJson, { v: 1, treeSha256, at: new Date().toISOString() })
  return { changed: true, treeSha256, tampered }
}

/**
 * Cheap staleness check for the UserPromptSubmit hot path (no hashing): whether the store's
 * `inventory.json` tree hash differs from the hash recorded in `view.json` (SPEC §11.10).
 */
export function viewLooksStale(storeRoot, viewJson) {
  const inventory = readJsonSafeSync(join(storeRoot, 'inventory.json'), null)
  const view = readJsonSafeSync(viewJson, null)
  if (!inventory || typeof inventory.treeSha256 !== 'string') return view === null
  return !view || view.treeSha256 !== inventory.treeSha256
}

/** The cached inventory of a store (`inventory.json`) without opening it: `{treeSha256, files, totalBytes}` or null. */
export function cachedInventory(storeRoot) {
  const inventory = readJsonSafeSync(join(storeRoot, 'inventory.json'), null)
  if (!inventory || typeof inventory.treeSha256 !== 'string' || !Array.isArray(inventory.files)) return null
  return inventory
}

/**
 * The inventory of what the Actor can read: `{ treeSha256, files: [{path, bytes}] }` of the view
 * (names and sizes only; never file bodies). A missing or invalid view lists nothing.
 */
export async function viewInventory(viewDir) {
  const treeSha256 = await viewTreeHash(viewDir)
  if (treeSha256 === null) return { treeSha256: null, files: [] }
  try {
    const entries = await listTree(viewDir)
    return { treeSha256, files: entries.map(e => ({ path: e.rel, bytes: e.bytes })) }
  } catch {
    return { treeSha256, files: [] }
  }
}

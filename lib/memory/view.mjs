// Read-only views and writable copies of a memory tree (SPEC §6.7, §11.10).
//
// A view is rebuilt from the source on every refresh, so edits made to it are discarded by
// construction (RSIAgent pushes a fresh copy of durable memory into every Actor workspace and
// discards it after the work phase, analysis/memory-learning.md §2).

import { chmod, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../core/digest.mjs'
import { EMPTY_TREE_SHA256, treeSha256 } from './hash.mjs'
import { loadTree, replaceDir, scanTree, writeTree } from './tree.mjs'

/** chmods every directory under `root` (deepest first) to `mode`. */
async function chmodDirs(root, mode) {
  const dirs = []
  const visit = async dir => {
    dirs.push(dir)
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(dir, entry.name))
    }
  }
  await visit(root)
  for (const dir of dirs.reverse()) await chmod(dir, mode)
}

/**
 * Replaces `destDir` with a copy of the regular files of `srcDir` (same rules as pullTree: a
 * symlink or special file in the source is refused). With `readOnly` (default) files are 0444
 * and directories 0555; otherwise files are 0600 (0700 when the source has the owner exec
 * bit) and directories 0700. The copy is built beside `destDir` and swapped in, so it is never
 * seen half-written, and an existing `destDir` symlink is replaced, never followed. A missing
 * source yields an empty directory. Returns `{ treeSha256 }` of what was written.
 */
export async function materializeView(srcDir, destDir, { readOnly = true } = {}) {
  const tree = await loadTree(srcDir)
  const contents = {}
  const hashes = {}
  for (const [rel, { data }] of Object.entries(tree)) {
    contents[rel] = data
    hashes[rel] = sha256Hex(data)
  }
  await replaceDir(destDir, async staging => {
    await writeTree(staging, contents, {
      fileMode: rel => (readOnly ? 0o444 : (tree[rel].mode & 0o100 ? 0o700 : 0o600)),
      dirMode: 0o700,
    })
    if (readOnly) await chmodDirs(staging, 0o555)
  })
  return { treeSha256: Object.keys(hashes).length === 0 ? EMPTY_TREE_SHA256 : treeSha256(hashes) }
}

/** tree_sha256 of a view (or any tree); null when it is missing or not a valid memory tree. */
export async function viewTreeHash(destDir) {
  try {
    const info = await lstat(destDir)
    if (info.isSymbolicLink() || !info.isDirectory()) return null
    return (await scanTree(destDir)).treeSha256
  } catch {
    return null
  }
}

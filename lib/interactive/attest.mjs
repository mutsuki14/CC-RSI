// MCP caller attestation (SPEC §11.4; J1-1; PR §4.2).
//
// The MCP server process keeps its spawn-time session id after /clear, and an MCP request does not
// say which conversation (main thread or subagent) made it. Claude Code runs the plugin's PreToolUse
// hook (matcher ^mcp__plugin_cc-rsi_rsi__) before every call to our tools and passes the call's
// tool_use_id, which also arrives in `tools/call` params `_meta["claudecode/toolUseId"]` (EXP e,
// E9). The hook writes one record per tool_use_id; the server takes (reads and deletes) it. A call
// without a record was not made through an attested Claude Code session (hooks disabled), and a
// record with `agent_id` came from a subagent.

import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from '../core/atomic.mjs'

const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,200}$/

/** Whether `id` is a usable tool_use_id (it names a file). */
export function validToolUseId(id) {
  return typeof id === 'string' && TOOL_USE_ID.test(id)
}

const str = value => (typeof value === 'string' ? value : null)

/**
 * Writes `<attDir>/<tool_use_id>.json` (0600, atomic) from a PreToolUse payload:
 * `{v:1, tool_use_id, tool_name, session_id, transcript_path, cwd, agent_id, agent_type,
 *   permission_mode, prompt_id, ts}`. Throws TypeError for a missing or unsafe tool_use_id.
 */
export async function writeAttestation(attDir, { tool_use_id, tool_name, session_id, transcript_path, cwd, agent_id, agent_type,
  permission_mode, prompt_id } = {}) {
  if (!validToolUseId(tool_use_id)) throw new TypeError(`writeAttestation: unusable tool_use_id ${JSON.stringify(tool_use_id)}`)
  const record = {
    v: 1,
    tool_use_id,
    tool_name: str(tool_name),
    session_id: str(session_id),
    transcript_path: str(transcript_path),
    cwd: str(cwd),
    agent_id: str(agent_id),
    agent_type: str(agent_type),
    permission_mode: str(permission_mode),
    prompt_id: str(prompt_id),
    ts: new Date().toISOString(),
  }
  await writeJsonAtomic(join(attDir, `${tool_use_id}.json`), record, { mode: 0o600 })
  return record
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Takes the attestation of `toolUseId`: polls every `pollMs` for up to `waitMs`, then reads and
 * unlinks it. Returns the record, or null when none arrives (or the id is unusable, or the record
 * is malformed). A record is used once: a second take of the same id returns null.
 */
export async function takeAttestation(attDir, toolUseId, { waitMs = 2000, pollMs = 25, signal } = {}) {
  if (!validToolUseId(toolUseId)) return null
  const path = join(attDir, `${toolUseId}.json`)
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    let text = null
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null
    }
    if (text !== null) {
      try {
        await unlink(path)
      } catch (error) {
        // Someone else took it first: it is used once.
        if (error?.code === 'ENOENT') return null
      }
      try {
        const record = JSON.parse(text)
        if (!record || typeof record !== 'object' || record.tool_use_id !== toolUseId) return null
        return record
      } catch {
        return null
      }
    }
    if (Date.now() >= deadline || signal?.aborted) return null
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

/** Removes attestations older than `olderThanMs` (default 1 h). Returns the number removed. */
export async function sweepAttestations(attDir, { olderThanMs = 3600000, now = Date.now() } = {}) {
  let names = []
  try {
    names = await readdir(attDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
    const path = join(attDir, name)
    try {
      const info = await stat(path)
      if (now - info.mtimeMs > olderThanMs) {
        await unlink(path)
        removed++
      }
    } catch {
      // gone already
    }
  }
  return removed
}

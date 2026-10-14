// A stable machine identity (portability-7). A hostname is not one: macOS renames the host when the
// network changes, and a record written under the old name then looks foreign, so a dead holder on
// this very machine is never judged gone. Records carry `machine` next to `host`; "written on this
// machine" means the same machine id, or (records without one, or no id available) the same host.
//
// The id must never be shared between machines (r2-concurrency-3): a record whose id matches is
// judged by pid (a pid that does not exist here is "gone"), so two machines with one id would take
// each other's live leases over. It therefore never comes from the cc-rsi home, which a network home
// or a bind-mounted container home shares: it is a digest of the OS machine id, else of macOS's
// IOPlatformUUID, else a random id kept machine-locally in `/var/tmp/cc-rsi-<uid>/machine-id`. On
// Linux the pid namespace is mixed in, so containers on one kernel (whose pids are not comparable)
// never count as the same machine.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

const OS_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id']
const LOCAL_ID = /^[0-9a-f]{32}$/
let cached

const hashed = text => createHash('sha256').update(text).digest('hex').slice(0, 32)

function uidOf() {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/** `/var/tmp/cc-rsi-<uid>/machine-id`: survives reboots, and is local to the machine (or container). */
export function localIdPath() {
  return join('/var/tmp', `cc-rsi-${uidOf() ?? 'user'}`, 'machine-id')
}

/** The pid namespace (`pid:[…]`) of this process, or '' when unknown. */
function pidNamespace(nsPath) {
  try {
    return readlinkSync(nsPath)
  } catch {
    return ''
  }
}

/** macOS's hardware UUID (`ioreg`), or null. */
function platformUuid() {
  try {
    const r = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 })
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout ?? '')
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** A directory we own and that is not a link (a world-writable parent such as /var/tmp is shared). */
function ownDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const info = lstatSync(dir)
    const uid = uidOf()
    return info.isDirectory() && (uid === null || info.uid === uid)
  } catch {
    return false
  }
}

function readLocalId(path) {
  try {
    const info = lstatSync(path)
    const uid = uidOf()
    if (!info.isFile() || (uid !== null && info.uid !== uid)) return null
    const id = readFileSync(path, 'utf8').trim()
    return LOCAL_ID.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * The machine id from explicit sources (tests pass their own): `os:<digest>` of the first OS machine
 * id file, else `local:<digest>` of the machine-local id (seeded from macOS's IOPlatformUUID when
 * available, else random), or null. On Linux the pid namespace is mixed into the digest.
 */
export function computeMachineId({ osFiles = OS_ID_FILES, localPath = localIdPath(), platform = process.platform, nsPath = '/proc/self/ns/pid', uuid = platformUuid } = {}) {
  const ns = platform === 'linux' ? pidNamespace(nsPath) : ''
  const mix = text => hashed(ns === '' ? text : `${text}\u0000${ns}`)
  for (const file of osFiles) {
    try {
      const id = readFileSync(file, 'utf8').trim()
      if (id !== '') return `os:${mix(id)}`
    } catch {
      // next source
    }
  }
  if (typeof localPath !== 'string' || localPath === '' || !ownDir(dirname(localPath))) return null
  let id = readLocalId(localPath)
  if (id === null) {
    const seed = platform === 'darwin' && typeof uuid === 'function' ? uuid() : null
    try {
      writeFileSync(localPath, `${seed ? hashed(`IOPlatformUUID:${seed}`) : randomBytes(16).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
    } catch {
      // another process created it first
    }
    id = readLocalId(localPath)
  }
  return id === null ? null : `local:${mix(id)}`
}

/** This machine's id (see computeMachineId), cached per process; null when none is available. */
export function machineId() {
  if (cached === undefined) cached = computeMachineId()
  return cached
}

/**
 * Whether a record (`{ host, machine }`) was written on this machine: the same machine id, or the
 * same hostname. The id only adds sameness (a renamed host); it never makes a same-host record foreign.
 */
export function sameMachine(record) {
  if (!record || typeof record !== 'object') return false
  if (typeof record.machine === 'string' && record.machine !== '') {
    const mine = machineId()
    if (mine !== null && record.machine === mine) return true
  }
  return typeof record.host === 'string' && record.host === hostname()
}

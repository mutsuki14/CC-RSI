// A stable machine identity (portability-7). A hostname is not one: macOS renames the host when the
// network changes, and a record written under the old name then looks foreign, so a dead holder on
// this very machine is never judged gone. Records carry `machine` next to `host`; "written on this
// machine" means the same machine id, or (records without one, or no id available) the same host.

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { ccRsiHome } from './paths.mjs'

const OS_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id']
const HOME_ID = /^[0-9a-f]{32}$/
const cache = new Map()

const hashed = text => createHash('sha256').update(text).digest('hex').slice(0, 32)

function readHomeId(path) {
  try {
    const id = readFileSync(path, 'utf8').trim()
    return HOME_ID.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * This machine's id: a digest of the OS machine id (Linux `/etc/machine-id`, never recorded raw),
 * else a random id kept in `<home>/run/machine-id` (mode 0600, created once). Null when neither is
 * available. Cached per process (and per home for the fallback).
 */
export function machineId(env = process.env) {
  if (cache.has('os')) return cache.get('os')
  for (const file of OS_ID_FILES) {
    try {
      const id = readFileSync(file, 'utf8').trim()
      if (id !== '') {
        const out = `os:${hashed(id)}`
        cache.set('os', out)
        return out
      }
    } catch {
      // next source
    }
  }
  const path = join(ccRsiHome(env), 'run', 'machine-id')
  if (cache.has(path)) return cache.get(path)
  let id = readHomeId(path)
  if (id === null) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, `${randomBytes(16).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
    } catch {
      // another process created it first, or the home is not writable
    }
    id = readHomeId(path)
  }
  const out = id === null ? null : `home:${id}`
  cache.set(path, out)
  return out
}

/**
 * Whether a record (`{ host, machine }`) was written on this machine: the same machine id, or the
 * same hostname. The id only adds sameness (a renamed host); it never makes a same-host record foreign.
 */
export function sameMachine(record, env = process.env) {
  if (!record || typeof record !== 'object') return false
  if (typeof record.machine === 'string' && record.machine !== '') {
    const mine = machineId(env)
    if (mine !== null && record.machine === mine) return true
  }
  return typeof record.host === 'string' && record.host === hostname()
}

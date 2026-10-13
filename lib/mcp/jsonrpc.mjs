// Newline-delimited JSON-RPC 2.0 over stdio (SPEC §11.11 "Protocol"; MCP stdio transport).
//
// Stdout carries protocol frames only: every frame is one JSON object followed by '\n'. Requests
// are dispatched concurrently (a long `tools/call` never blocks `ping` or a cancellation). A
// cancelled request gets no response (MCP: the receiver SHOULD NOT respond to a cancelled request).
// Verified Claude Code behaviour (claude-code-experiments.md e): `server/discover` arrives before
// `initialize` and must be answered with a JSON-RPC error; `tools/call` carries
// `_meta["claudecode/toolUseId"]` and a `progressToken`; a timeout sends `notifications/cancelled`.

import { StringDecoder } from 'node:string_decoder'

/** A JSON-RPC error with a code (-32601 Method not found, -32602 Invalid params, …). */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

const MAX_LINE = 64 * 2 ** 20

function isId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

/**
 * `createRpc({ input, output, onRequest, onNotification, log })` → `{ notify(method, params), close(), closed }`.
 * - `onRequest(method, params, { id, signal })` → result (or throws RpcError); `signal` aborts on
 *   `notifications/cancelled {requestId}` for that id (the response is then suppressed).
 * - `onNotification(method, params)` for every other notification.
 * - Malformed JSON → -32700 with id null; a batch array or a message without a method → -32600.
 * - Client responses (no method; result/error) are ignored: this server sends no requests.
 * `closed` resolves when the input ends (or `close()` is called) and every in-flight request has settled.
 */
export function createRpc({ input = process.stdin, output = process.stdout, onRequest, onNotification = () => {}, log = () => {} } = {}) {
  const inflight = new Map() // id key → AbortController
  const pending = new Set()
  let ended = false
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const keyOf = id => `${typeof id}:${id}`

  const write = message => {
    try {
      output.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      log('write failed', error)
    }
  }
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message, data) => write({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } })

  const maybeClosed = () => {
    if (ended && pending.size === 0) resolveClosed()
  }

  const handleRequest = (id, method, params) => {
    const controller = new AbortController()
    const key = keyOf(id)
    inflight.set(key, controller)
    const task = (async () => {
      try {
        const result = await onRequest(method, params, { id, signal: controller.signal })
        if (!controller.signal.aborted) reply(id, result ?? {})
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof RpcError) fail(id, error.code, error.message, error.data)
        else {
          log('request failed', { method, error: String(error?.stack ?? error) })
          fail(id, INTERNAL_ERROR, `Internal error: ${error?.message ?? error}`)
        }
      } finally {
        if (inflight.get(key) === controller) inflight.delete(key)
      }
    })()
    pending.add(task)
    task.finally(() => {
      pending.delete(task)
      maybeClosed()
    })
  }

  const handleNotification = (method, params) => {
    if (method === 'notifications/cancelled') {
      const requestId = params?.requestId
      if (isId(requestId)) inflight.get(keyOf(requestId))?.abort()
      return
    }
    try {
      onNotification(method, params)
    } catch (error) {
      log('notification handler failed', { method, error: String(error?.message ?? error) })
    }
  }

  const handleLine = line => {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      fail(null, PARSE_ERROR, 'Parse error')
      return
    }
    if (Array.isArray(message)) {
      fail(null, INVALID_REQUEST, 'Invalid Request: batches are not supported')
      return
    }
    if (!message || typeof message !== 'object') {
      fail(null, INVALID_REQUEST, 'Invalid Request')
      return
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null
    if (typeof message.method !== 'string' || message.method === '') {
      // A response to a request we never sent, or garbage.
      if (hasId && ('result' in message || 'error' in message)) return
      fail(hasId && isId(message.id) ? message.id : null, INVALID_REQUEST, 'Invalid Request: missing method')
      return
    }
    if (hasId) {
      if (!isId(message.id)) {
        fail(null, INVALID_REQUEST, 'Invalid Request: id must be a string or a number')
        return
      }
      handleRequest(message.id, message.method, message.params)
    } else {
      handleNotification(message.method, message.params)
    }
  }

  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const onData = chunk => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      handleLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
    if (buffer.length > MAX_LINE) {
      buffer = ''
      fail(null, PARSE_ERROR, 'Parse error: message too large')
    }
  }
  const onEnd = () => {
    if (ended) return
    buffer += decoder.end()
    if (buffer.trim() !== '') handleLine(buffer)
    buffer = ''
    ended = true
    // The client closed the connection (MCP stdio shutdown): in-flight waits end now; nothing can
    // read their responses any more (a verification job continues on its own).
    setImmediate(() => {
      for (const controller of inflight.values()) controller.abort()
      maybeClosed()
    })
  }
  input.on('data', onData)
  input.on('end', onEnd)
  input.on('close', onEnd)
  input.on('error', error => {
    log('input error', String(error?.message ?? error))
    onEnd()
  })

  return {
    notify(method, params) {
      write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
    },
    close() {
      input.off?.('data', onData)
      for (const controller of inflight.values()) controller.abort()
      ended = true
      maybeClosed()
    },
    closed,
  }
}

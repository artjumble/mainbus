import fs from 'node:fs/promises'
import net from 'node:net'
import { IntakeFailure, type IntakeHandler } from './methods'
import {
  INTAKE_METHODS,
  INTAKE_VERSION,
  MAX_LINE_BYTES,
  type IntakeError,
  type IntakeMethod,
  type IntakeReply,
  type RequestId
} from './protocol'

export interface IntakeServer {
  readonly endpoint: string
  /** Stops listening and drops open connections. Safe to call twice. */
  close(): Promise<void>
}

export interface IntakeServerOptions {
  /** A connection with no traffic for this long is closed. */
  idleMs?: number
  /** A connection is closed this long after it opened, busy or not, so slow clients can't hold every slot. */
  maxLifetimeMs?: number
  maxConnections?: number
  /** At most this many requests read from one connection wait for their replies; reading pauses meanwhile. */
  maxInFlight?: number
  log?: (message: string, error?: unknown) => void
}

const NEWLINE = 0x0a

function isRequestId(id: unknown): id is RequestId {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

function isMethod(method: string): method is IntakeMethod {
  return (INTAKE_METHODS as readonly string[]).includes(method)
}

/**
 * Listens for intake requests on `endpoint` and answers each with `handle`.
 *
 * Access (Windows): Node gives the pipe no security descriptor of its own, so it gets the default one.
 * Read back from a pipe Node created, that is
 *   D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<current user>)
 * Full control for the current user, SYSTEM and Administrators; Everyone and Anonymous get read only
 * (FILE_GENERIC_READ, which has no FILE_WRITE_DATA). Another account can therefore open the pipe for
 * reading but can never write a request, and it gets no reply without one; its idle connection is
 * closed after `idleMs`. libuv also creates the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so
 * if another process already owns the name, listening fails instead of sharing it.
 * server.test.ts checks this DACL. Off Windows the socket is created with mode 0600.
 *
 * Every connection is served one request at a time, in order. A malformed line, a bad envelope, an
 * unknown method or a line over MAX_LINE_BYTES gets an error reply and the connection is closed once
 * that reply is flushed. Nothing a client sends can throw out of here.
 *
 * Backpressure: a connection is not read while any of its requests waits for a reply or a reply waits
 * to be written, and only `maxInFlight` requests are taken from bytes already read. A client that floods
 * requests without reading the replies stalls only itself, until its idle timeout or lifetime ends it.
 */
export async function startIntakeServer(
  endpoint: string,
  handle: IntakeHandler,
  options: IntakeServerOptions = {}
): Promise<IntakeServer> {
  const idleMs = options.idleMs ?? 60_000
  const maxLifetimeMs = options.maxLifetimeMs ?? 5 * 60_000
  const maxInFlight = options.maxInFlight ?? 8
  const log = options.log ?? ((message: string, error?: unknown) => console.error(`Mainbus intake: ${message}`, error ?? ''))
  const sockets = new Set<net.Socket>()

  function serve(socket: net.Socket): void {
    sockets.add(socket)
    const lifetime = setTimeout(() => socket.destroy(), maxLifetimeMs)
    socket.on('close', () => {
      clearTimeout(lifetime)
      sockets.delete(socket)
    })
    // A client that vanishes mid-reply is not an error worth more than dropping the connection.
    socket.on('error', () => socket.destroy())
    socket.setTimeout(idleMs, () => socket.destroy())

    /** The start of a line whose newline hasn't arrived yet. */
    let partial: Buffer[] = []
    let partialBytes = 0
    /** Bytes read but not yet split into lines, because maxInFlight requests were already waiting. */
    let unread: Buffer | null = null
    let inFlight = 0
    let writeBlocked = false
    let closing = false
    let queue = Promise.resolve()

    /** Reads only while nothing waits: no unanswered request, no unsplit bytes, no unsent reply. */
    const flow = (): void => {
      if (closing || socket.destroyed) return
      if (inFlight === 0 && unread === null && !writeBlocked) socket.resume()
      else socket.pause()
    }
    /** Settles when a blocked write drains or the connection closes; shared by every waiting request. */
    let drained: Promise<void> | null = null
    socket.on('drain', () => {
      writeBlocked = false
      drained = null
      flow()
    })
    const writable = (): Promise<void> => {
      if (!writeBlocked || socket.destroyed) return Promise.resolve()
      drained ??= new Promise((resolve) => {
        const done = (): void => {
          socket.off('drain', done).off('close', done)
          resolve()
        }
        socket.on('drain', done).on('close', done)
      })
      return drained
    }

    const send = (reply: IntakeReply): void => {
      if (socket.destroyed || !socket.writable) return
      if (!socket.write(`${JSON.stringify(reply)}\n`)) writeBlocked = true
    }
    const fail = (id: RequestId | null, error: IntakeError): void => send({ id, error })

    /** Replies after any requests still being answered, then closes once the reply is flushed. Later input is ignored. */
    const fatal = (id: RequestId | null, error: IntakeError): void => {
      closing = true
      socket.pause()
      partial = []
      unread = null
      queue = queue.then(() => {
        if (socket.destroyed || !socket.writable) return void socket.destroy()
        // end() alone leaves the connection half open, holding a slot, until the client closes its side.
        socket.end(`${JSON.stringify({ id, error } satisfies IntakeReply)}\n`, () => socket.destroy())
      })
    }

    function answer(line: string): void {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return fatal(null, { code: 'parse_error', message: 'Malformed JSON' })
      }
      const request = typeof message === 'object' && message !== null && !Array.isArray(message) ? (message as Record<string, unknown>) : null
      const id = request && isRequestId(request.id) ? request.id : null
      if (!request || id === null || typeof request.method !== 'string') {
        return fatal(id, { code: 'bad_request', message: 'Expected {"v": 1, "id", "method", "params"}' })
      }
      if (request.v !== INTAKE_VERSION) {
        return fatal(id, { code: 'bad_request', message: `Unsupported protocol version: expected v ${INTAKE_VERSION}` })
      }
      const method = request.method
      if (!isMethod(method)) {
        return fatal(id, { code: 'unknown_method', message: `Unknown method: ${method.slice(0, 100)}` })
      }
      inFlight++
      queue = queue.then(async () => {
        try {
          // A client that isn't reading its replies gets nothing more done for it until it does.
          await writable()
          if (socket.destroyed) return
          send({ id, result: await handle(method, request.params) })
        } catch (error) {
          fail(
            id,
            error instanceof IntakeFailure
              ? error.toError()
              : { code: 'internal', message: error instanceof Error ? error.message : String(error) }
          )
        } finally {
          inFlight--
          split()
        }
      })
    }

    /** Takes whole lines from the unread bytes while fewer than maxInFlight requests wait. */
    function split(): void {
      while (!closing && unread !== null && inFlight < maxInFlight) {
        const end = unread.indexOf(NEWLINE)
        const part = end === -1 ? unread : unread.subarray(0, end)
        if (partialBytes + part.length > MAX_LINE_BYTES) {
          return fatal(null, { code: 'too_large', message: `Request line is over ${MAX_LINE_BYTES} bytes` })
        }
        if (end === -1) {
          if (part.length > 0) {
            partial.push(part)
            partialBytes += part.length
          }
          unread = null
          break
        }
        const line = Buffer.concat([...partial, part]).toString('utf8').replace(/\r$/, '')
        partial = []
        partialBytes = 0
        unread = end + 1 < unread.length ? unread.subarray(end + 1) : null
        if (line.trim() !== '') answer(line)
      }
      flow()
    }

    socket.on('data', (chunk: Buffer) => {
      if (closing) return
      // Reading pauses while anything is unsplit, so at most one chunk is ever held here.
      unread = unread === null ? chunk : Buffer.concat([unread, chunk])
      split()
    })
  }

  const server = net.createServer(serve)
  server.maxConnections = options.maxConnections ?? 32

  if (process.platform !== 'win32') {
    // A socket file left by a crash would block listening. Only one app runs per home (the
    // single-instance lock), so whatever is there is stale.
    await fs.rm(endpoint, { force: true })
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // The socket file takes its mode from the umask at bind time, which happens inside listen().
    const umask = process.platform === 'win32' ? null : process.umask(0o177)
    try {
      server.listen(endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    } finally {
      if (umask !== null) process.umask(umask)
    }
  })
  server.on('error', (error) => log('server error', error))

  let closed: Promise<void> | null = null
  return {
    endpoint,
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
      return closed
    }
  }
}

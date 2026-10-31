import net from 'node:net'
import {
  INTAKE_VERSION,
  type IntakeError,
  type IntakeErrorCode,
  type IntakeMethod,
  type IntakeReply,
  type IntakeResults
} from '../engine/intake/protocol'

/** Nothing is listening on the endpoint: the app for this data home isn't running. */
export class NotRunningError extends Error {
  constructor(readonly homeRoot: string) {
    super(`Mainbus isn't running (data home: ${homeRoot}). Start it and try again.`)
    this.name = 'NotRunningError'
  }
}

/** The app answered with an error. */
export class IntakeRequestError extends Error {
  readonly code: IntakeErrorCode
  readonly field: string | undefined
  constructor(error: IntakeError) {
    super(error.message)
    this.name = 'IntakeRequestError'
    this.code = error.code
    this.field = error.field
  }
}

const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED'])

export interface IntakeTarget {
  endpoint: string
  /** Named in the "isn't running" message. */
  homeRoot: string
}

/**
 * Sends one request over a fresh connection and resolves with its result. Never starts the app:
 * with nothing listening it rejects at once with NotRunningError.
 */
export function request<M extends IntakeMethod>(
  target: IntakeTarget,
  method: M,
  params: unknown,
  timeoutMs = 30_000
): Promise<IntakeResults[M]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.endpoint)
    let buffer = ''
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      fn()
    }

    socket.setTimeout(timeoutMs, () => settle(() => reject(new Error('Mainbus did not answer in time'))))
    socket.on('error', (error: NodeJS.ErrnoException) =>
      settle(() => reject(error.code && NOT_LISTENING.has(error.code) ? new NotRunningError(target.homeRoot) : error))
    )
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: INTAKE_VERSION, id: 1, method, params })}\n`)
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end === -1) return
      settle(() => {
        try {
          const reply = JSON.parse(buffer.slice(0, end)) as IntakeReply
          if ('error' in reply) reject(new IntakeRequestError(reply.error))
          else resolve(reply.result as IntakeResults[M])
        } catch {
          reject(new Error('Mainbus sent a reply that could not be read'))
        }
      })
    })
    socket.on('close', () => settle(() => reject(new Error('Mainbus closed the connection without answering'))))
  })
}

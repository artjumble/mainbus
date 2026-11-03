import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotRunningError, request } from '../../cli/client'
import { resolveHome } from '../home'
import { intakeEndpoint } from './endpoint'
import { MAX_LINE_BYTES } from './protocol'
import { startIntakeServer } from './server'
import { makeTestBoard, type TestBoard } from './testBoard'

let boards: TestBoard[] = []

async function board(): Promise<TestBoard> {
  const b = await makeTestBoard()
  boards.push(b)
  // Every request names the caller's folder, which must be inside a workspace: here, the board's repo.
  create.source.cwd = b.repoPath
  cwd = b.repoPath
  return b
}

afterEach(async () => {
  for (const b of boards) await b.dispose()
  boards = []
})

const create = { title: 'From an agent', intent: 'Please do this', source: { agent: 'codex', cwd: '/x' } }
let cwd = ''

/** Writes raw bytes, then collects every reply line until the server closes the connection (or a timeout). */
function exchange(endpoint: string, payload: string | Buffer, waitMs = 5_000): Promise<{ replies: unknown[]; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    let text = ''
    const done = (closed: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve({
        replies: text
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
        closed
      })
    }
    const timer = setTimeout(() => done(false), waitMs)
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // The server may close while a large payload is still being written.
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') return
      clearTimeout(timer)
      reject(error)
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (text += chunk))
    socket.on('end', () => done(true))
    socket.on('connect', () => socket.write(payload))
  })
}

const line = (v: unknown): string => `${JSON.stringify(v)}\n`

describe('intake server', () => {
  it('answers requests in order on one connection, and creates the ticket', async () => {
    const { target, engine } = await board()
    const { replies } = await exchange(
      target.endpoint,
      line({ v: 1, id: 'a', method: 'create', params: create }) + line({ v: 1, id: 'b', method: 'list', params: { cwd } }),
      1_000
    )
    expect(replies).toEqual([
      { id: 'a', result: { number: 1, title: 'From an agent', column: 'backlog' } },
      { id: 'b', result: { tickets: [expect.objectContaining({ number: 1, column: 'backlog' })] } }
    ])
    expect((await engine.invoke('board.get')).tickets).toHaveLength(1)
  })

  it('keeps the connection open after a validation error, which names the field', async () => {
    const { target } = await board()
    const { replies, closed } = await exchange(
      target.endpoint,
      line({ v: 1, id: 1, method: 'create', params: { ...create, column: 'ready' } }) + line({ v: 1, id: 2, method: 'list', params: { cwd } }),
      1_000
    )
    expect(closed).toBe(false)
    expect(replies).toEqual([
      { id: 1, error: { code: 'invalid', message: expect.stringContaining('column'), field: 'column' } },
      { id: 2, result: { tickets: [] } }
    ])
  })

  it.each([
    ['malformed JSON', '{"v":1,"id":1,"method":\n', null, 'parse_error'],
    ['an unknown method', line({ v: 1, id: 7, method: 'delete', params: { number: 1 } }), 7, 'unknown_method'],
    ['a missing method', line({ v: 1, id: 8 }), 8, 'bad_request'],
    ['a wrong version', line({ v: 2, id: 9, method: 'list' }), 9, 'bad_request'],
    ['a JSON array', line([1, 2]), null, 'bad_request']
  ])('replies to %s with an error, closes, and keeps working', async (_, payload, id, code) => {
    const { target, engine } = await board()
    const { replies, closed } = await exchange(target.endpoint, payload + line({ v: 1, id: 'later', method: 'create', params: create }))
    expect(closed).toBe(true)
    expect(replies).toEqual([{ id, error: { code, message: expect.any(String) } }])
    // Nothing after the bad line ran; a new connection is served normally.
    expect((await engine.invoke('board.get')).tickets).toEqual([])
    expect(await request(target, 'create', create)).toMatchObject({ number: 1 })
  })

  it('replies too_large to a line over MAX_LINE_BYTES, closes, and keeps working', async () => {
    const { target, engine } = await board()
    const huge = line({ v: 1, id: 1, method: 'create', params: { ...create, intent: 'x'.repeat(MAX_LINE_BYTES) } })
    const { replies, closed } = await exchange(target.endpoint, huge)
    expect(closed).toBe(true)
    expect(replies).toEqual([{ id: null, error: { code: 'too_large', message: expect.any(String) } }])

    // A line over the limit with no newline at all is caught too.
    const noNewline = await exchange(target.endpoint, Buffer.alloc(MAX_LINE_BYTES + 10, 0x61))
    expect(noNewline.replies).toEqual([{ id: null, error: { code: 'too_large', message: expect.any(String) } }])

    expect((await engine.invoke('board.get')).tickets).toEqual([])
    expect(await request(target, 'list', { cwd })).toEqual({ tickets: [] })
  })

  it('accepts a line of exactly MAX_LINE_BYTES', async () => {
    const { target } = await board()
    const envelope = line({ v: 1, id: 1, method: 'list', params: { cwd } }).trimEnd()
    const padded = `${envelope.slice(0, -1)}${' '.repeat(MAX_LINE_BYTES - Buffer.byteLength(envelope))}}\n`
    expect(Buffer.byteLength(padded)).toBe(MAX_LINE_BYTES + 1)
    const { replies } = await exchange(target.endpoint, padded, 1_000)
    expect(replies).toEqual([{ id: 1, result: { tickets: [] } }])
  })

  it('fits the largest valid request, even when every character is escaped', async () => {
    const { target, repoPath } = await board()
    // U+0001 is one character that JSON escapes to six bytes, the worst case.
    const w = (n: number): string => '\u0001'.repeat(n)
    const largest = {
      title: w(200),
      intent: w(20_000),
      spec: w(100_000),
      criteria: Array.from({ length: 50 }, () => w(1_000)),
      labels: Array.from({ length: 20 }, () => w(50)),
      repo: path.join(repoPath, w(999 - repoPath.length)),
      source: { agent: w(100), cwd: w(1_000) }
    }
    const size = Buffer.byteLength(line({ v: 1, id: 1, method: 'create', params: largest }))
    expect(size).toBeGreaterThan(1_030_000)
    expect(size).toBeLessThan(MAX_LINE_BYTES)
    expect(await request(target, 'create', largest)).toMatchObject({ number: 1 })
  })

  it('a client of one data home cannot reach another', async () => {
    const a = await board()
    const b = await board()
    expect(a.target.endpoint).not.toBe(b.target.endpoint)

    await request(a.target, 'create', { ...create, source: { ...create.source, cwd: a.repoPath } })
    expect((await request(a.target, 'list', { cwd: a.repoPath })).tickets).toHaveLength(1)
    expect((await request(b.target, 'list', { cwd: b.repoPath })).tickets).toHaveLength(0)
    expect((await b.engine.invoke('board.get')).tickets).toEqual([])

    // A home with no app running gets "not running", never another home's board.
    const root = path.join(a.tmp, 'unused-home')
    const error = await request({ endpoint: intakeEndpoint(root), homeRoot: root }, 'list', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NotRunningError)
    expect((error as Error).message).toBe(`Mainbus isn't running (data home: ${root}). Start it and try again.`)
  })

  it.runIf(process.platform === 'win32')('gives other accounts no write access to the pipe', async () => {
    const { target } = await board()
    const pipe = target.endpoint.replace('\\\\.\\pipe\\', '')
    const script = [
      `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${pipe}', [System.IO.Pipes.PipeDirection]::InOut)`,
      '$c.Connect(5000)',
      "$c.GetAccessControl().GetSecurityDescriptorSddlForm('Access')",
      '$c.Dispose()'
    ].join('; ')
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    })
    const sddl = stdout.trim()
    const aces = [...sddl.matchAll(/\((A|D);[^;]*;([^;]*);[^;]*;[^;]*;([^)]*)\)/g)].map(([, type, rights, sid]) => ({
      type,
      rights,
      sid
    }))
    expect(aces.length, sddl).toBeGreaterThan(0)
    // Only SYSTEM, Administrators and the creator may hold more than read access.
    const user = os.userInfo().username
    for (const ace of aces.filter((a) => a.type === 'A' && !['SY', 'BA'].includes(a.sid) && !a.sid.startsWith('S-1-5-21-'))) {
      expect(ace.rights, `${ace.sid} in ${sddl} (user ${user})`).toBe('FR')
    }
    // Exactly one account SID: the current user's.
    expect(aces.filter((a) => a.sid.startsWith('S-1-5-21-'))).toHaveLength(1)
  }, 30_000)

  it('closes cleanly with a connection still open', async () => {
    const { server, target } = await board()
    const socket = net.connect(target.endpoint)
    await new Promise((resolve) => socket.on('connect', resolve))
    await server.close()
    await server.close()
    await expect(request(target, 'list', {})).rejects.toBeInstanceOf(NotRunningError)
    socket.destroy()
  })
})

describe('intakeEndpoint', () => {
  it('names a pipe from the data home, the same however the path is written', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }
    const stable = intakeEndpoint(resolveHome(env, 'stable', 'C:\\Users\\x').root, 'win32')
    const dev = intakeEndpoint(resolveHome(env, 'dev', 'C:\\Users\\x').root, 'win32')
    expect(stable).toMatch(/^\\\\\.\\pipe\\mainbus-[0-9a-f]{16}$/)
    expect(dev).not.toBe(stable)
    expect(intakeEndpoint('c:\\users\\x\\appdata\\local\\MAINBUS\\', 'win32')).toBe(stable)
    expect(intakeEndpoint('C:\\Users\\x\\AppData\\Local\\Mainbus\\..\\Mainbus', 'win32')).toBe(stable)
  })

  it('uses a socket in the data home off Windows', () => {
    expect(intakeEndpoint('/home/x/.mainbus', 'linux')).toBe(path.join('/home/x/.mainbus', 'intake.sock'))
  })
})

/** A server with a stub handler on a fresh endpoint, for connection-level tests. */
async function stubServer(
  options: Parameters<typeof startIntakeServer>[2] = {},
  result: unknown = { ok: true }
): Promise<{ target: { endpoint: string; homeRoot: string }; calls: () => number }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-stub-'))
  const endpoint = intakeEndpoint(tmp)
  let calls = 0
  const server = await startIntakeServer(endpoint, async () => (calls++, result) as never, { log: () => {}, ...options })
  cleanups.push(async () => {
    await server.close()
    await fs.rm(tmp, { recursive: true, force: true })
  })
  return { target: { endpoint, homeRoot: tmp }, calls: () => calls }
}

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups = []
})

const connected = (socket: net.Socket): Promise<void> =>
  new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject))

describe('intake server under load', () => {
  it('stops reading a client that floods requests without reading replies, and still answers another client', async () => {
    const { target, calls } = await stubServer({ idleMs: 30_000 }, { padding: 'x'.repeat(4_096) })
    const total = 5_000
    const flood = net.connect(target.endpoint)
    flood.on('error', () => {})
    await connected(flood)
    flood.pause()
    flood.write(Array.from({ length: total }, (_, i) => line({ v: 1, id: i, method: 'list', params: {} })).join(''))

    // The server answers until its replies back up, then stops taking requests from this client.
    let last = -1
    await vi.waitFor(
      () => {
        const now = calls()
        const settled = now === last && now > 0
        last = now
        expect(settled).toBe(true)
      },
      { timeout: 10_000, interval: 300 }
    )
    expect(calls()).toBeLessThan(total / 10)

    // Another client is served meanwhile.
    expect(await request(target, 'list', {}, 2_000)).toEqual({ padding: expect.any(String) })

    // Once the flooding client reads, every reply arrives, in order.
    let text = ''
    let received = 0
    flood.setEncoding('utf8')
    await new Promise<void>((resolve) => {
      flood.on('data', (chunk: string) => {
        text += chunk
        const lines = text.split('\n')
        text = lines.pop()!
        for (const l of lines) expect((JSON.parse(l) as { id: number }).id).toBe(received++)
        if (received === total) resolve()
      })
      flood.resume()
    })
    flood.destroy()
  }, 30_000)

  it('drops a connection once a fatal reply is flushed, even if the client never closes its side', async () => {
    const { target } = await stubServer({ maxConnections: 1, idleMs: 30_000 })
    const stubborn = net.connect({ path: target.endpoint, allowHalfOpen: true })
    stubborn.on('error', () => {})
    await connected(stubborn)
    stubborn.setEncoding('utf8')
    const reply = new Promise<string>((resolve) => stubborn.once('data', resolve))
    stubborn.write('not json\n')
    expect(JSON.parse(await reply)).toMatchObject({ error: { code: 'parse_error' } })

    // The only slot is free again: the server closed its end for good.
    await vi.waitFor(() => expect(request(target, 'list', {}, 1_000)).resolves.toEqual({ ok: true }), { timeout: 3_000 })
    stubborn.destroy()
  })

  it('closes a connection at the end of its lifetime, so a slow client cannot hold a slot', async () => {
    const { target } = await stubServer({ maxConnections: 1, idleMs: 30_000, maxLifetimeMs: 300 })
    const slow = net.connect(target.endpoint)
    slow.on('error', () => {})
    await connected(slow)
    // A byte every 50 ms keeps it from ever going idle, and never finishes a line.
    const drip = setInterval(() => slow.writable && slow.write('{'), 50)
    try {
      await expect(request(target, 'list', {}, 1_000)).rejects.toThrow()
      await vi.waitFor(() => expect(request(target, 'list', {}, 1_000)).resolves.toEqual({ ok: true }), { timeout: 3_000 })
    } finally {
      clearInterval(drip)
      slow.destroy()
    }
  })
})

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestBoard, type TestBoard } from '../engine/intake/testBoard'
import { EXIT, main, type Io } from './main'

let b: TestBoard

beforeEach(async () => {
  b = await makeTestBoard()
})

afterEach(async () => {
  await b.dispose()
})

interface Run {
  code: number
  stdout: string
  stderr: string
  io: Io
}

async function run(argv: string[], over: Partial<Io> = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const io: Io = {
    env: { MAINBUS_HOME: b.paths.root },
    cwd: b.repoPath,
    mode: 'dev',
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: async () => '',
    serveMcp: vi.fn(async () => {}),
    ...over
  }
  const code = await main(argv, io)
  return { code, stdout, stderr, io }
}

const tickets = async () => (await b.engine.invoke('board.get')).tickets

describe('mainbus ticket create', () => {
  it('creates from flags and prints the number and title', async () => {
    await fs.writeFile(path.join(b.tmp, 'intent.md'), 'Long intent\nover lines')
    await fs.writeFile(path.join(b.tmp, 'spec.md'), '# Spec')
    const r = await run([
      'ticket', 'create',
      '--title', 'Add a CLI',
      '--intent-file', path.join(b.tmp, 'intent.md'),
      '--spec-file', path.join(b.tmp, 'spec.md'),
      '--criterion', 'One', '--criterion', 'Two',
      '--label', 'cli',
      '--repo', '.',
      '--agent', 'claude-code'
    ])
    expect(r).toMatchObject({ code: EXIT.ok, stdout: '#1 Add a CLI\n', stderr: '' })
    const [t] = await tickets()
    expect(t).toMatchObject({ title: 'Add a CLI', spec: '# Spec', labels: ['cli'], manualColumn: 'backlog' })
    expect(t!.criteria.map((c) => c.text)).toEqual(['One', 'Two'])
    expect(t!.intent[0]).toMatchObject({
      text: 'Long intent\nover lines',
      source: { kind: 'agent', agent: 'claude-code', cwd: b.repoPath }
    })
  })

  it('defaults the agent to cli', async () => {
    expect((await run(['ticket', 'create', '--title', 'T', '--intent', 'I'])).code).toBe(EXIT.ok)
    expect((await tickets())[0]!.intent[0]!.source?.agent).toBe('cli')
  })

  it('takes a JSON object from a file or from stdin, without a byte-order mark', async () => {
    const input = { title: 'From JSON', intent: 'quotes " and %PATH% survive', criteria: ['c'], labels: ['l'], agent: 'codex' }
    await fs.writeFile(path.join(b.tmp, 't.json'), JSON.stringify(input))
    expect((await run(['ticket', 'create', '--json', path.join(b.tmp, 't.json')])).stdout).toBe('#1 From JSON\n')

    const piped = await run(['ticket', 'create', '--json', '-'], {
      readStdin: async () => `\ufeff${JSON.stringify({ ...input, title: 'From stdin', repo: b.repoPath })}`
    })
    expect(piped).toMatchObject({ code: EXIT.ok, stdout: '#2 From stdin\n' })

    const [first, second] = await tickets()
    expect(first!.intent[0]).toMatchObject({ text: input.intent, source: { agent: 'codex' } })
    expect(second!.title).toBe('From stdin')
  })

  it.each([
    [['ticket', 'create', '--intent', 'I'], '--title is required'],
    [['ticket', 'create', '--title', 'T'], 'exactly one of --intent and --intent-file'],
    [['ticket', 'create', '--title', 'T', '--intent', 'I', '--intent-file', 'x'], 'exactly one'],
    [['ticket', 'create', '--title', 'T', '--intent', 'I', '--column', 'ready'], "Unknown option '--column'"],
    [['ticket', 'create', '--json', 'missing.json'], 'Could not read --json missing.json'],
    [['ticket', 'create', '--json', '-', '--title', 'T'], 'use no other options'],
    [['ticket', 'show'], 'Give one ticket number'],
    [['ticket', 'show', 'abc'], 'Give one ticket number'],
    [['ticket', 'frobnicate'], 'Unknown command: ticket frobnicate'],
    [['ticket'], 'Missing command'],
    [['launch'], 'Unknown command: launch'],
    [['mcp', 'extra'], 'takes no arguments'],
    [[], 'Usage:']
  ])('%j is a usage error (exit 1)', async (argv, message) => {
    const r = await run(argv)
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain(message)
    expect(await tickets()).toEqual([])
  })

  it('rejects malformed or non-object JSON input as usage', async () => {
    expect((await run(['ticket', 'create', '--json', '-'], { readStdin: async () => '{nope' })).code).toBe(EXIT.usage)
    expect((await run(['ticket', 'create', '--json', '-'], { readStdin: async () => '[]' })).code).toBe(EXIT.usage)
    const r = await run(['ticket', 'create', '--json', '-'], {
      readStdin: async () => JSON.stringify({ title: 'T', intent: 'I', source: { agent: 'me', cwd: '' } })
    })
    expect(r.stderr).toContain('source is filled in by mainbus')
    expect(r.code).toBe(EXIT.usage)
  })

  it.each([
    [{ title: 'T', intent: 'I', column: 'ready' }, 'column'],
    [{ title: 'T', intent: 'I', priority: 1 }, 'priority'],
    [{ title: 'x'.repeat(201), intent: 'I' }, 'title'],
    [{ title: 'T', intent: 'I', repo: 'C:\\somewhere\\else' }, 'repo'],
    [{ title: 'T', intent: 'I', agent: '' }, 'source.agent']
  ])('reports engine validation of %j with the field (exit 2)', async (input, field) => {
    const r = await run(['ticket', 'create', '--json', '-'], { readStdin: async () => JSON.stringify(input) })
    expect(r.code).toBe(EXIT.failed)
    expect(r.stderr).toMatch(new RegExp(`^Error: .*\\(field: ${field.replace('.', '\\.')}\\)\\n$`))
    expect(await tickets()).toEqual([])
  })
})

describe('mainbus ticket list and show', () => {
  beforeEach(async () => {
    await run(['ticket', 'create', '--title', 'Agent ticket', '--intent', 'From codex', '--agent', 'codex', '--label', 'ci'])
    await b.engine.invoke('ticket.create', { title: 'User ticket', intent: 'Mine', spec: 'S', criteria: ['c'], labels: [], column: 'ready' })
  })

  it('lists for people and as JSON, with a column filter', async () => {
    const r = await run(['ticket', 'list'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.stdout).toMatch(/#1 +backlog +not_started +Agent ticket +\[ci\] +from codex \(reported\)/)
    expect(r.stdout).toMatch(/#2 +ready +not_started +User ticket\n/)

    const json = JSON.parse((await run(['ticket', 'list', '--json', '--column', 'ready'])).stdout) as unknown[]
    expect(json).toEqual([expect.objectContaining({ number: 2, title: 'User ticket', column: 'ready', source: null })])

    const bad = await run(['ticket', 'list', '--column', 'nowhere'])
    expect(bad.code).toBe(EXIT.failed)
    expect(bad.stderr).toContain('(field: column)')
  })

  it('shows a ticket for people and as JSON', async () => {
    const r = await run(['ticket', 'show', '#1'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.stdout).toContain('#1 Agent ticket')
    expect(r.stdout).toContain(`Intent, from codex (reported), in ${b.repoPath}:\nFrom codex`)

    const json = JSON.parse((await run(['ticket', 'show', '2', '--json'])).stdout) as Record<string, unknown>
    expect(json).toMatchObject({ number: 2, spec: 'S', criteria: [{ text: 'c', checked: false }], intent: [{ text: 'Mine', source: null }] })

    const missing = await run(['ticket', 'show', '9'])
    expect(missing.code).toBe(EXIT.failed)
    expect(missing.stderr).toContain('(field: number)')
  })
})

describe('when it cannot or must not reach the app', () => {
  it('exits 3 with the data home when the app is not running', async () => {
    const root = path.join(b.tmp, 'not-running')
    for (const argv of [['ticket', 'list'], ['ticket', 'show', '1'], ['ticket', 'create', '--title', 'T', '--intent', 'I']]) {
      const r = await run(argv, { env: { MAINBUS_HOME: root } })
      expect(r.code).toBe(EXIT.notRunning)
      expect(r.stderr).toBe(`Mainbus isn't running (data home: ${root}). Start it and try again.\n`)
    }
  })

  it('exits 4 under MAINBUS_AGENT without MAINBUS_HOME, for the CLI and the MCP server', async () => {
    for (const argv of [['ticket', 'list'], ['mcp']]) {
      const r = await run(argv, { env: { MAINBUS_AGENT: '1' } })
      expect(r.code).toBe(EXIT.refused)
      expect(r.stderr).toContain('MAINBUS_AGENT is set')
      expect(r.io.serveMcp).not.toHaveBeenCalled()
    }
  })

  it('still works under MAINBUS_AGENT with a MAINBUS_HOME of its own', async () => {
    const r = await run(['ticket', 'list'], { env: { MAINBUS_AGENT: '1', MAINBUS_HOME: b.paths.root } })
    expect(r.code).toBe(EXIT.ok)
  })

  it('mainbus mcp serves against the resolved data home', async () => {
    const r = await run(['mcp'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.io.serveMcp).toHaveBeenCalledWith(b.target, b.repoPath)
  })
})

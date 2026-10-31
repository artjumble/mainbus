import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestBoard, type TestBoard } from '../engine/intake/testBoard'
import type { IntakeTarget } from './client'
import { agentName, createMcpServer } from './mcp'

let b: TestBoard
let clients: Client[] = []

beforeEach(async () => {
  b = await makeTestBoard()
})

afterEach(async () => {
  for (const c of clients) await c.close()
  clients = []
  await b.dispose()
})

async function connect(target: IntakeTarget = b.target, name = 'test-agent'): Promise<Client> {
  const server = createMcpServer(target, b.repoPath)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(clientSide)
  clients.push(client)
  return client
}

const textOf = (result: unknown): string => ((result as CallToolResult).content[0] as { text: string }).text

describe('mainbus mcp', () => {
  it('lists the three tools, telling the agent about Backlog and duplicates', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['create_ticket', 'get_ticket', 'list_tickets'])
    const create = tools.find((t) => t.name === 'create_ticket')!
    expect(create.description).toMatch(/Backlog/)
    expect(create.description).toMatch(/list_tickets first/)
    expect(Object.keys(create.inputSchema.properties ?? {}).sort()).toEqual(
      ['agent', 'criteria', 'intent', 'labels', 'repo', 'spec', 'title'].sort()
    )
    expect(create.inputSchema.required?.sort()).toEqual(['intent', 'title'])
  })

  it("creates a ticket whose source agent is the client's clientInfo.name", async () => {
    const client = await connect(b.target, 'my-mcp-client')
    const result = await client.callTool({
      name: 'create_ticket',
      arguments: { title: 'Spotted a bug', intent: 'The parser drops tabs.', criteria: ['Tabs survive'], repo: '.' }
    })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('Created #1 Spotted a bug in Backlog for the user to review.')

    const [t] = (await b.engine.invoke('board.get')).tickets
    expect(t).toMatchObject({ title: 'Spotted a bug', manualColumn: 'backlog', state: { column: 'backlog' } })
    expect(t!.intent[0]!.source).toEqual({ kind: 'agent', agent: 'my-mcp-client', cwd: b.repoPath })

    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_tickets', arguments: {} }))) as {
      tickets: { number: number; source: { agent: string } }[]
    }
    expect(listed.tickets).toEqual([expect.objectContaining({ number: 1, source: expect.objectContaining({ agent: 'my-mcp-client' }) })])

    const got = JSON.parse(textOf(await client.callTool({ name: 'get_ticket', arguments: { number: 1 } }))) as Record<string, unknown>
    expect(got).toMatchObject({ number: 1, title: 'Spotted a bug', criteria: [{ text: 'Tabs survive', checked: false }] })
  })

  it('records the agent the call names instead of the client name', async () => {
    const client = await connect()
    await client.callTool({ name: 'create_ticket', arguments: { title: 'T', intent: 'I', agent: 'codex' } })
    expect((await b.engine.invoke('board.get')).tickets[0]!.intent[0]!.source?.agent).toBe('codex')
  })

  it('records mcp-client for a client with an empty name, and cuts long names to 100 characters', async () => {
    const anonymous = await connect(b.target, '')
    expect((await anonymous.callTool({ name: 'create_ticket', arguments: { title: 'A', intent: 'I' } })).isError).toBeFalsy()
    const verbose = await connect(b.target, 'v'.repeat(300))
    expect((await verbose.callTool({ name: 'create_ticket', arguments: { title: 'B', intent: 'I' } })).isError).toBeFalsy()
    const named = await connect()
    const long = await named.callTool({ name: 'create_ticket', arguments: { title: 'C', intent: 'I', agent: 'a'.repeat(150) } })
    expect(long.isError).toBeFalsy()

    const agents = (await b.engine.invoke('board.get')).tickets.map((t) => t.intent[0]!.source?.agent)
    expect(agents).toEqual(['mcp-client', 'v'.repeat(100), 'a'.repeat(100)])
  })

  it('returns validation errors as tool errors naming the field, and creates nothing', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'create_ticket', arguments: { title: 'x'.repeat(201), intent: 'I' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/\(field: title\)$/)

    const mismatch = await client.callTool({
      name: 'create_ticket',
      arguments: { title: 'T', intent: 'I', repo: path.join(b.tmp, 'elsewhere') }
    })
    expect(mismatch.isError).toBe(true)
    expect(textOf(mismatch)).toMatch(/not in the open workspace.*\(field: repo\)$/)
    expect((await b.engine.invoke('board.get')).tickets).toEqual([])
  })

  it("returns Mainbus isn't running, with the data home, from every tool when the app is not running", async () => {
    const root = path.join(b.tmp, 'not-running')
    const { intakeEndpoint } = await import('../engine/intake/endpoint')
    const client = await connect({ endpoint: intakeEndpoint(root), homeRoot: root })
    for (const [name, args] of [
      ['create_ticket', { title: 'T', intent: 'I' }],
      ['list_tickets', {}],
      ['get_ticket', { number: 1 }]
    ] as const) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe(`Mainbus isn't running (data home: ${root}). Start it and try again.`)
    }
  })
})

describe('agentName', () => {
  it('prefers the named agent, then the client name, then mcp-client', () => {
    expect(agentName('codex', 'client')).toBe('codex')
    expect(agentName(undefined, 'client')).toBe('client')
    expect(agentName('  ', ' client ')).toBe('client')
    expect(agentName(undefined, '')).toBe('mcp-client')
    expect(agentName(undefined, undefined)).toBe('mcp-client')
  })

  it('never cuts a character in half', () => {
    expect(agentName(`${'x'.repeat(99)}😀`, undefined)).toBe('x'.repeat(99))
  })
})

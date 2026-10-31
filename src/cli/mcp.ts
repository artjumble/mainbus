import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { IntakeRequestError, request, type IntakeTarget } from './client'

export const VERSION = '0.1.0'

const COLUMNS = ['backlog', 'ready', 'in_progress', 'needs_you', 'review', 'done'] as const

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function failure(error: unknown): CallToolResult {
  let message = error instanceof Error ? error.message : String(error)
  if (error instanceof IntakeRequestError && error.field) message += ` (field: ${error.field})`
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * The `mainbus mcp` server: create_ticket, list_tickets and get_ticket, each one request to the running
 * app. The schemas here only describe the arguments; the app validates them. The agent name is the
 * client's self-reported clientInfo.name unless the call passes one.
 */
export function createMcpServer(target: IntakeTarget, cwd: string): McpServer {
  const server = new McpServer({ name: 'mainbus', version: VERSION })

  const call = async (run: () => Promise<string>): Promise<CallToolResult> => {
    try {
      return text(await run())
    } catch (error) {
      return failure(error)
    }
  }

  server.registerTool(
    'create_ticket',
    {
      title: 'Create a Mainbus ticket',
      description:
        "Files a ticket on the user's Mainbus board for work you have spotted that belongs there. It lands in " +
        'Backlog for the user to review and decide on; nothing starts until they do. Call list_tickets first ' +
        'so you do not file a duplicate. The ticket is marked as written by you, under your agent name.',
      inputSchema: {
        title: z.string().describe('Short, single-line title (up to 200 characters)'),
        intent: z.string().describe('What should change and why, in your own words (up to 20,000 characters)'),
        spec: z.string().optional().describe('Optional longer specification (up to 100,000 characters)'),
        criteria: z.array(z.string()).optional().describe('Optional acceptance criteria, one per item (up to 50)'),
        labels: z.array(z.string()).optional().describe('Optional labels (up to 20, each up to 50 characters)'),
        repo: z
          .string()
          .optional()
          .describe('Optional path of the repository the ticket is for; it must be the workspace open in Mainbus'),
        agent: z.string().optional().describe('Optional agent name to record instead of your client name')
      }
    },
    ({ agent, repo, ...fields }) =>
      call(async () => {
        const name = agent ?? server.server.getClientVersion()?.name ?? 'mcp'
        const created = await request(target, 'create', {
          ...fields,
          ...(repo === undefined ? {} : { repo: path.resolve(cwd, repo) }),
          source: { agent: name, cwd }
        })
        return `Created #${created.number} ${created.title} in Backlog for the user to review.`
      })
  )

  server.registerTool(
    'list_tickets',
    {
      title: 'List Mainbus tickets',
      description:
        "Lists the tickets on the user's Mainbus board (number, title, column, phase, labels, who filed it). " +
        'Call it before create_ticket to avoid duplicates. Optionally filter by column.',
      inputSchema: { column: z.enum(COLUMNS).optional().describe('Only tickets in this column') }
    },
    ({ column }) =>
      call(async () => JSON.stringify(await request(target, 'list', column === undefined ? {} : { column }), null, 2))
  )

  server.registerTool(
    'get_ticket',
    {
      title: 'Read a Mainbus ticket',
      description: "Reads one ticket on the user's Mainbus board by number: title, intent, spec, criteria, labels and status.",
      inputSchema: { number: z.number().int().describe('The ticket number, as in #12') }
    },
    ({ number }) => call(async () => JSON.stringify(await request(target, 'get', { number }), null, 2))
  )

  return server
}

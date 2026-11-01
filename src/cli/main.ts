import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import type { IntentSource } from '../shared/domain'
import type { IntakeTicketDetail, IntakeTicketSummary } from '../engine/intake/protocol'
import { IntakeRequestError, NotRunningError, request, type IntakeTarget } from './client'
import { refusalUnderAgent, resolveTarget, type Env } from './target'

export const EXIT = { ok: 0, usage: 1, failed: 2, notRunning: 3, refused: 4 } as const

export interface Io {
  env: Env
  /** Where the command was run: recorded as the agent's folder, and the base of relative paths. */
  cwd: string
  mode: 'stable' | 'dev'
  stdout(text: string): void
  stderr(text: string): void
  readStdin(): Promise<string>
  /** Runs the MCP server on stdio until the client goes away. */
  serveMcp(target: IntakeTarget, cwd: string): Promise<void>
}

export const USAGE = `Usage:
  mainbus ticket create --title <t> (--intent <text> | --intent-file <path>) [--spec-file <path>]
                        [--criterion <text>]... [--label <l>]... [--repo <path>] [--agent <name>]
  mainbus ticket create --json <path>|-     (an object with title, intent, spec, criteria, labels, repo, agent)
  mainbus ticket list [--column backlog|ready|in_progress|needs_you|review|done] [--json]
  mainbus ticket show <number> [--json]
  mainbus mcp                               (an MCP server on stdio)

Tickets land in Backlog for the user to review. Prefer --json or --*-file for long text: cmd.exe can
mangle quotes and % signs in arguments.`

class UsageError extends Error {}

/** Text from a file or stdin, without the byte-order mark Windows PowerShell adds to piped text. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function readText(io: Io, file: string, flag: string): Promise<string> {
  try {
    return stripBom(file === '-' ? await io.readStdin() : await fs.readFile(path.resolve(io.cwd, file), 'utf8'))
  } catch (error) {
    throw new UsageError(`Could not read ${flag} ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parse<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

async function createParams(io: Io, args: string[]): Promise<Record<string, unknown>> {
  const { values } = parse({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      title: { type: 'string' },
      intent: { type: 'string' },
      'intent-file': { type: 'string' },
      'spec-file': { type: 'string' },
      criterion: { type: 'string', multiple: true },
      label: { type: 'string', multiple: true },
      repo: { type: 'string' },
      agent: { type: 'string' },
      json: { type: 'string' }
    }
  })
  const source = (agent: unknown): { agent: unknown; cwd: string } => ({ agent: agent ?? 'cli', cwd: io.cwd })
  const repo = (value: unknown): Record<string, unknown> =>
    value === undefined ? {} : { repo: typeof value === 'string' ? path.resolve(io.cwd, value) : value }

  if (values.json !== undefined) {
    if (Object.keys(values).length > 1) throw new UsageError('--json takes all the fields; use no other options with it')
    let input: unknown
    try {
      input = JSON.parse(await readText(io, values.json, '--json'))
    } catch (error) {
      if (error instanceof UsageError) throw error
      throw new UsageError(`--json ${values.json} is not valid JSON`)
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new UsageError('--json must hold a JSON object')
    }
    const { agent, repo: repoPath, ...fields } = input as Record<string, unknown>
    // Unknown fields go through to the app, which names them in its error.
    if ('source' in fields) throw new UsageError('source is filled in by mainbus; set agent instead')
    return { ...fields, ...repo(repoPath), source: source(agent) }
  }

  if (values.title === undefined) throw new UsageError('--title is required')
  if ((values.intent === undefined) === (values['intent-file'] === undefined)) {
    throw new UsageError('Give exactly one of --intent and --intent-file')
  }
  const intent = values.intent ?? (await readText(io, values['intent-file'] as string, '--intent-file'))
  return {
    title: values.title,
    intent,
    ...(values['spec-file'] === undefined ? {} : { spec: await readText(io, values['spec-file'], '--spec-file') }),
    ...(values.criterion === undefined ? {} : { criteria: values.criterion }),
    ...(values.label === undefined ? {} : { labels: values.label }),
    ...repo(values.repo),
    source: source(values.agent)
  }
}

function from(source: IntentSource | null): string {
  return source ? `from ${source.agent} (reported)` : ''
}

function status(t: { phase: string; agentStatus: string | null }): string {
  return t.agentStatus ? `${t.phase}, ${t.agentStatus}` : t.phase
}

function formatList(tickets: IntakeTicketSummary[]): string {
  if (tickets.length === 0) return 'No tickets.'
  return tickets
    .map((t) => {
      const labels = t.labels.length ? `  [${t.labels.join(', ')}]` : ''
      const source = t.source ? `  ${from(t.source)}` : ''
      const pr = t.prUrl ? `  ${t.prUrl}` : ''
      return `#${t.number}  ${t.column.padEnd(11)} ${status(t).padEnd(16)} ${t.title}${labels}${source}${pr}`
    })
    .join('\n')
}

function formatTicket(t: IntakeTicketDetail): string {
  const lines = [`#${t.number} ${t.title}`, `Column: ${t.column}   Status: ${status(t)}`]
  if (t.labels.length) lines.push(`Labels: ${t.labels.join(', ')}`)
  if (t.prUrl) lines.push(`Pull request: ${t.prUrl}`)
  for (const [i, entry] of t.intent.entries()) {
    const who = entry.source ? `${from(entry.source)}, in ${entry.source.cwd}` : "the user's words"
    lines.push('', `Intent${i === 0 ? '' : ` (added ${entry.at})`}, ${who}:`, entry.text)
  }
  if (t.spec) lines.push('', 'Spec:', t.spec)
  if (t.criteria.length) {
    lines.push('', 'Criteria:', ...t.criteria.map((c) => `- [${c.checked ? 'x' : ' '}] ${c.text}`))
  }
  return lines.join('\n')
}

async function ticket(io: Io, target: IntakeTarget, args: string[]): Promise<number> {
  const [command, ...rest] = args
  switch (command) {
    case 'create': {
      const created = await request(target, 'create', await createParams(io, rest))
      io.stdout(`#${created.number} ${created.title}\n`)
      return EXIT.ok
    }
    case 'list': {
      const { values } = parse({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: { column: { type: 'string' }, json: { type: 'boolean' } }
      })
      const result = await request(target, 'list', values.column === undefined ? {} : { column: values.column })
      io.stdout(`${values.json ? JSON.stringify(result.tickets, null, 2) : formatList(result.tickets)}\n`)
      return EXIT.ok
    }
    case 'show': {
      const { values, positionals } = parse({
        args: rest,
        strict: true,
        allowPositionals: true,
        options: { json: { type: 'boolean' } }
      })
      const raw = positionals.length === 1 ? positionals[0].replace(/^#/, '') : ''
      if (!/^\d+$/.test(raw)) throw new UsageError('Give one ticket number, as in: mainbus ticket show 12')
      const result = await request(target, 'get', { number: Number(raw) })
      io.stdout(`${values.json ? JSON.stringify(result, null, 2) : formatTicket(result)}\n`)
      return EXIT.ok
    }
    default:
      throw new UsageError(command ? `Unknown command: ticket ${command}` : 'Missing command: ticket create, list or show')
  }
}

/** Runs the CLI and resolves with its exit code. Never starts the app. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    ;(command === undefined ? io.stderr : io.stdout)(`${USAGE}\n`)
    return command === undefined ? EXIT.usage : EXIT.ok
  }

  const target = resolveTarget(io.env, io.mode, io.cwd)
  const refusal = refusalUnderAgent(io.env, target)
  if (refusal) {
    io.stderr(`${refusal}\n`)
    return EXIT.refused
  }

  try {
    if (command === 'mcp') {
      if (rest.length > 0) throw new UsageError('mainbus mcp takes no arguments')
      await io.serveMcp(target, io.cwd)
      return EXIT.ok
    }
    if (command === 'ticket') return await ticket(io, target, rest)
    throw new UsageError(`Unknown command: ${command}`)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${USAGE}\n`)
      return EXIT.usage
    }
    if (error instanceof NotRunningError) {
      io.stderr(`${error.message}\n`)
      return EXIT.notRunning
    }
    if (error instanceof IntakeRequestError) {
      io.stderr(`Error: ${error.message}${error.field ? ` (field: ${error.field})` : ''}\n`)
      return EXIT.failed
    }
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.failed
  }
}

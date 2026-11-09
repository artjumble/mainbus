/** The SDK names Mainbus's own tools with this prefix. */
const MCP_PREFIX = 'mcp__mainbus__'

/** The orchestrator's read tools: each one looks at the board. */
const BOARD_TOOLS = new Set([
  'list_workspaces',
  'list_tickets',
  'get_ticket',
  'get_run_status',
  'get_recent_events',
  'list_pending_decisions'
])

function hostOf(input: unknown): string | null {
  const url = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).url : undefined
  try {
    return typeof url === 'string' ? new URL(url).hostname || null : null
  } catch {
    return null
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * One line for a group of tool calls, such as "Read 3 files, looked at the board": what each kind of tool did,
 * in the order first seen.
 */
export function summariseTools(calls: { name: string; input?: unknown }[]): string {
  const counts = new Map<string, number>()
  const hosts = new Set<string>()
  let badUrls = 0
  for (const { name, input } of calls) {
    const bare = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name
    const kind =
      bare === 'Read'
        ? 'read'
        : bare === 'WebFetch'
          ? 'web'
          : bare === 'WebSearch'
            ? 'websearch'
            : bare === 'Grep' || bare === 'Glob'
              ? 'search'
              : BOARD_TOOLS.has(bare)
                ? 'board'
                : bare.startsWith('propose_')
                  ? 'propose'
                  : bare === 'create_tickets'
                    ? 'create'
                    : bare === 'update_ticket'
                      ? 'edit'
                      : 'other'
    if (kind === 'web') {
      const host = hostOf(input)
      if (host === null) badUrls++
      else hosts.add(host)
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const parts = [...counts].map(([kind, n]) => {
    switch (kind) {
      case 'read':
        return `read ${plural(n, 'file', 'files')}`
      case 'web': {
        const list = [...hosts]
        if (badUrls === 0 && list.length === 1) return `read ${list[0]}`
        if (badUrls === 0 && list.length === 2) return `read ${list[0]} and ${list[1]}`
        return n === 1 ? 'read a web page' : `read ${n} web pages`
      }
      case 'websearch':
        return 'searched the web'
      case 'search':
        return 'searched the code'
      case 'board':
        return 'looked at the board'
      case 'propose':
        return `made ${plural(n, 'proposal', 'proposals')}`
      case 'create':
        return 'created tickets'
      case 'edit':
        return n === 1 ? 'edited a ticket' : 'edited tickets'
      default:
        return `used ${plural(n, 'tool', 'tools')}`
    }
  })
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

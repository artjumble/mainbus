import type { StoredEvent } from '../../../shared/events'

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READS = new Set(['Read', 'Grep', 'Glob'])

/** `path` as the ticket's folder sees it: without the folder in front, and with forward slashes. */
function relative(path: string, folder: string | null): string {
  const p = path.replace(/\\/g, '/')
  const f = folder?.replace(/\\/g, '/').replace(/\/+$/, '')
  return f && p.toLowerCase().startsWith(`${f.toLowerCase()}/`) ? p.slice(f.length + 1) : p
}

function text(input: unknown, ...keys: string[]): string | null {
  if (typeof input !== 'object' || input === null) return null
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * The line under the thread while the role works, from the latest tool call of the run that is open (the last
 * event's): "Implementer is editing src/export.ts", "is reading …", "is running …", or "is working…" when it
 * has called no tool yet. Paths are relative to the ticket's folder.
 */
export function liveLine(events: StoredEvent[], role: string, folder: string | null): string {
  const runId = events.at(-1)?.runId
  for (let i = events.length - 1; i >= 0; i--) {
    const { runId: id, event } = events[i]!
    if (id !== runId) break
    if (event.kind !== 'tool_call') continue
    const name = event.name
    if (EDITS.has(name)) {
      const path = text(event.input, 'file_path', 'notebook_path', 'path')
      if (path) return `${role} is editing ${relative(path, folder)}`
    } else if (READS.has(name)) {
      const target = text(event.input, 'file_path', 'path', 'pattern')
      if (target) return `${role} is reading ${relative(target, folder)}`
    } else if (name === 'Bash') {
      const command = text(event.input, 'command')
      if (command) return `${role} is running ${command.length > 60 ? `${command.slice(0, 59)}…` : command}`
    }
    break
  }
  return `${role} is working…`
}

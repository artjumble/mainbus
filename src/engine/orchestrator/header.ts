import type { Workspace } from '../../shared/domain'
import { oneLine } from '../roles/prompt'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const two = (n: number) => String(n).padStart(2, '0')

/** The user's local date and time, as `2026-11-01 14:05, Sunday`. */
export function localTime(d: Date): string {
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
  return `${date} ${two(d.getHours())}:${two(d.getMinutes())}, ${DAYS[d.getDay()]}`
}

/** The line Mainbus puts before each user message: the focused workspace and the local time. The panel doesn't show it. */
export function messageHeader(ws: Pick<Workspace, 'name' | 'repoPath'>, now: Date): string {
  return `[Mainbus] Focused workspace: ${oneLine(ws.name)} (${oneLine(ws.repoPath)}) · Local time: ${localTime(now)}`
}

export function withHeader(ws: Pick<Workspace, 'name' | 'repoPath'>, now: Date, text: string): string {
  return `${messageHeader(ws, now)}\n\n${text}`
}

import type { Arrival } from './activity'

/** The tray icon's tooltip: "Mainbus: 2 working, 1 needs you". */
export function tooltipText(working: number, needsYou: number): string {
  const parts: string[] = []
  if (working > 0) parts.push(`${working} working`)
  if (needsYou > 0) parts.push(`${needsYou} needs you`)
  return parts.length ? `Mainbus: ${parts.join(', ')}` : 'Mainbus: nothing running'
}

/** The text on the taskbar button's overlay badge; null when nothing needs the user. */
export function badgeText(needsYou: number): string | null {
  if (needsYou <= 0) return null
  return needsYou > 9 ? '9+' : String(needsYou)
}

export function badgeDescription(needsYou: number): string {
  return needsYou > 0 ? `${needsYou} ${needsYou === 1 ? 'ticket needs' : 'tickets need'} you` : ''
}

/** The tray menu's needs-you entry. */
export function needsYouLabel(needsYou: number): string {
  if (needsYou <= 0) return 'Nothing needs you'
  return needsYou === 1 ? '1 needs you' : `${needsYou} need you`
}

export interface ToastText {
  title: string
  body: string
}

const MAX_LINES = 3

/**
 * The toast for a batch of arrivals. One ticket gets its own wording; several are one toast ("3 tickets need you",
 * a mixed batch too). `workspaceNames` (when more than one workspace is open) names the workspace on each line.
 */
export function toastText(batch: Arrival[], workspaceNames: Map<string, string> | null = null): ToastText {
  if (batch.length === 1) {
    const a = batch[0]!
    const where = workspaceNames?.get(a.workspaceId)
    const prefix = where ? `${where}: ` : ''
    if (a.column === 'needs_you') {
      return { title: `#${a.number} needs you`, body: `${prefix}${[a.title, a.summary].filter(Boolean).join(' - ')}` }
    }
    return { title: `#${a.number} is ready for review`, body: `${prefix}${a.title}` }
  }
  const lines = batch.slice(0, MAX_LINES).map((a) => {
    const where = workspaceNames?.get(a.workspaceId)
    return `${where ? `${where}: ` : ''}#${a.number} ${a.title}`
  })
  if (batch.length > MAX_LINES) lines.push(`and ${batch.length - MAX_LINES} more`)
  return { title: `${batch.length} tickets need you`, body: lines.join('\n') }
}

export const STILL_RUNNING: ToastText = {
  title: 'Mainbus is still running',
  body: 'Agents keep working. Quit from the tray icon.'
}

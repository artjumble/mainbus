import { oneLine } from '../roles/prompt'
import { wsTag } from './workspaceRef'

export const UNBLOCKED_HEADING = '[Mainbus] Since your last turn, these tickets were unblocked:'

/** A ticket whose last open blocker reached Done since the orchestrator's last turn. */
export interface UnblockedTicket {
  number: number
  title: string
  workspace?: string
  blockers: { number: number; title: string }[]
}

/** The block that opens the orchestrator's next message, or null when no ticket was unblocked. */
export function unblockedBlock(unblocked: UnblockedTicket[]): string | null {
  if (unblocked.length === 0) return null
  const lines = unblocked.map((t) => {
    const done = t.blockers.map((b) => `#${b.number}`).join(', ')
    return `- #${t.number} ${JSON.stringify(oneLine(t.title))}${wsTag(t.workspace)} is no longer blocked: ${done} ${t.blockers.length === 1 ? 'is' : 'are'} Done. It can be started now.`
  })
  return [UNBLOCKED_HEADING, ...lines].join('\n')
}

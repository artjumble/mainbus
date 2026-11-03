import { oneLine } from '../roles/prompt'
import { wsTag } from './workspaceRef'

export const RELEASED_HEADING = '[Mainbus] Since your last turn, these held tickets were released:'

/** A ticket whose hold was released since the orchestrator's last turn. */
export interface ReleasedHold {
  number: number
  title: string
  workspace?: string
  /** The date the hold was to end on, or null for a hold with no date. */
  until: string | null
  releasedAt: string
}

/** The block that opens the orchestrator's next message, or null when no hold was released. */
export function releasedHoldsBlock(released: ReleasedHold[]): string | null {
  if (released.length === 0) return null
  const lines = released.map((h) => {
    const due = h.until !== null && h.until <= h.releasedAt ? ` (its date, ${h.until.slice(0, 10)}, came)` : ''
    return `- #${h.number} ${JSON.stringify(oneLine(h.title))}${wsTag(h.workspace)} is no longer held${due}. It can be started again.`
  })
  return [RELEASED_HEADING, ...lines].join('\n')
}

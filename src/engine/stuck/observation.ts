import type { DeclaredWait, TicketState } from '../../shared/domain'
import type { StoredEvent } from '../../shared/events'

/** What the runner tells the stuck detector about a ticket's open run. Times are ms since the epoch. */
export interface RunObservation {
  runId: string
  ticketId: string
  workspaceId: string
  role: string
  /** The ticket's worktree, or null before it has one. */
  worktreePath: string | null
  /** The ticket's state: the detector only looks at a run that is `working`. */
  state: TicketState
  /** The ticket is being launched: its process is not up yet. */
  launching: boolean
  /** A usage limit stopped the agent, or its process ended on one. */
  usageLimited: boolean
  declaredWait: DeclaredWait | null
  events: StoredEvent[]
  /** The agent's live process and what it has been doing; null when no process is running. */
  live: {
    /** The last event of any kind (streaming previews too), input delivered, or the launch. */
    lastActivityAt: number
    startedAt: number
    turnStartedAt: number
    /** True until the turn ends. */
    inTurn: boolean
  } | null
}

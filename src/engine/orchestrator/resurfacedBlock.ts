import { oneLine } from '../roles/prompt'

export const RESURFACED_HEADING = '[Mainbus] Since your last turn, these decisions the user put off came back:'

/** A deferred decision whose date came since the orchestrator's last turn. */
export interface ResurfacedDecision {
  number: number
  title: string
  question: string
  /** The date the user deferred it to. */
  until: string
}

/** The block that opens the orchestrator's next message, or null when no deferred decision came back. */
export function resurfacedBlock(resurfaced: ResurfacedDecision[]): string | null {
  if (resurfaced.length === 0) return null
  const lines = resurfaced.map(
    (d) =>
      `- #${d.number} ${JSON.stringify(oneLine(d.title))}: ${JSON.stringify(oneLine(d.question))} (deferred until ${d.until.slice(0, 10)}) is waiting on the user again.`
  )
  return [RESURFACED_HEADING, ...lines].join('\n')
}

import { data, oneLine } from '../roles/prompt'

export const STUCK_HEADING = '[Mainbus] Since your last turn, these agents look stuck:'

/** A stuck episode opened or escalated since the orchestrator's last turn, and still open. */
export interface StuckReport {
  number: number
  title: string
  role: string
  /** What the detector saw, one line each: text from the agent's log, so it is data. */
  evidence: string[]
  hitCount: number
  /** The episode reached its escalation count: it asks for a closer look. */
  needsCloserLook: boolean
  /** The episode was already redirected once. */
  redirected?: boolean
  /** It was redirected and has fired again since: the next step is a replacement. */
  firedAgain?: boolean
}

/** One stuck episode as the orchestrator is told of it: the ticket, the role, the advice for the next step and the evidence. */
export function stuckLine(r: StuckReport): string {
  const look = r.needsCloserLook ? ` It has now been flagged ${r.hitCount} times and needs a closer look.` : ''
  const evidence = r.evidence.map((e) => `  - ${data('stuck-evidence', oneLine(e), true)}`).join('\n')
  const redirected = r.firedAgain
    ? ' It was redirected once and has fired again: propose a replacement, not another redirect.'
    : r.redirected
      ? ' It was already redirected once, and has not fired again since: propose neither a redirect nor a replacement yet.'
      : ''
  return `- #${r.number} ${JSON.stringify(oneLine(r.title))}: the ${oneLine(r.role)} looks stuck.${look}${redirected} Evidence (from the agent's log):\n${evidence}`
}

/** The block that opens the orchestrator's next message, or null when no episode opened or escalated. */
export function stuckBlock(reports: StuckReport[]): string | null {
  if (reports.length === 0) return null
  const lines = reports.map(stuckLine)
  return [STUCK_HEADING, ...lines].join('\n')
}

import { data, oneLine } from '../roles/prompt'
import { wsTag } from './workspaceRef'
import { stuckLine, type StuckReport } from './stuckBlock'

export const WAKE_HEADING = '[Mainbus] Things to look at (Mainbus started this turn; the user did not write it):'

/** A piece of news a wake turn presents, with what Mainbus knows of it now. */
export type WakeItem =
  | { kind: 'failure'; workspace?: string; number: number; title: string; role: string; error: string | null }
  | { kind: 'stuck'; report: StuckReport; open: boolean }
  | { kind: 'released_hold'; workspace?: string; number: number; title: string; until: string | null }
  | { kind: 'resurfaced'; workspace?: string; number: number; title: string; question: string; decisionId: string; stillOpen: boolean }

/** A decision still waiting on the user, or put off. */
export interface OpenDecision {
  workspace?: string
  id: string
  number: number
  title: string
  question: string
  status: 'pending' | 'deferred'
  deferredUntil: string | null
}

const name = (number: number, title: string, workspace?: string): string => `#${number} ${JSON.stringify(oneLine(title))}${wsTag(workspace)}`

/** The one plain line of an item, as the panel lists it. */
export function wakeLine(item: WakeItem): string {
  switch (item.kind) {
    case 'failure':
      return `${name(item.number, item.title, item.workspace)}: the ${oneLine(item.role)} failed`
    case 'stuck':
      return `${name(item.report.number, item.report.title, item.report.workspace)}: the ${oneLine(item.report.role)} looks stuck`
    case 'released_hold':
      return `${name(item.number, item.title, item.workspace)}: its hold ran out`
    case 'resurfaced':
      return `${name(item.number, item.title, item.workspace)}: a question you put off is back`
  }
}

function itemText(item: WakeItem): string {
  switch (item.kind) {
    case 'failure': {
      const why = item.error === null ? '' : ` Its last error (from the agent's log): ${data('failure-error', oneLine(item.error), true)}.`
      return `- ${name(item.number, item.title, item.workspace)}: the ${oneLine(item.role)}'s run failed and the ticket moved to Needs you.${why}`
    }
    case 'stuck':
      return item.open
        ? stuckLine(item.report)
        : `- ${name(item.report.number, item.report.title, item.report.workspace)}: the ${oneLine(item.report.role)} looked stuck, but no longer does.`
    case 'released_hold': {
      const date = item.until === null ? '' : ` (its date, ${item.until.slice(0, 10)}, came)`
      return `- ${name(item.number, item.title, item.workspace)} is no longer held${date}. It can be started again.`
    }
    case 'resurfaced':
      return item.stillOpen
        ? `- ${name(item.number, item.title, item.workspace)}: ${data('question', oneLine(item.question), true)} is waiting on the user again (decision ${item.decisionId}).`
        : `- ${name(item.number, item.title, item.workspace)}: a question the user put off came back, but it has been settled since.`
  }
}

function decisionText(d: OpenDecision): string {
  const state = d.status === 'deferred' ? `deferred until ${(d.deferredUntil ?? 'further notice').slice(0, 10)}` : 'waiting on the user'
  return `- ${name(d.number, d.title, d.workspace)} (decision ${d.id}, ${state}): ${data('question', oneLine(d.question), true)}`
}

/**
 * The text a wake turn starts with (after the header line): what came up, then every open decision of every
 * workspace, then how to behave. It is written by the engine; the evidence quoted in it is data.
 */
export function wakeDigest(items: WakeItem[], open: OpenDecision[]): string {
  return [
    WAKE_HEADING,
    ...items.map(itemText),
    '',
    open.length === 0 ? 'Open decisions: none.' : ['Open decisions (all that are waiting or put off):', ...open.map(decisionText)].join('\n'),
    '',
    'These items can repeat after a crash or restart: handle each one idempotently, and do not propose again anything that is already pending (a proposal for the same ticket and kind that is still pending is returned as it is). Tickets cannot be drafted in this turn. Act through proposals, or write the user a short message when they need to know. End your turn when you are done.'
  ].join('\n')
}

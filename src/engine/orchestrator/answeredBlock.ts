import { ANSWERED_VIA_PHRASES, type Decision } from '../../shared/domain'
import { oneLine } from '../roles/prompt'
import { wsTag } from './workspaceRef'

export const ANSWERED_HEADING = '[Mainbus] Since your last turn, the user answered these questions from their agents:'

/** A decision answered since the orchestrator's last turn, with the ticket it was asked on. */
export interface AnsweredDecision {
  number: number
  title: string
  /** The ticket's workspace, named when there are several. */
  workspace?: string
  decision: Decision
}

function answerText(d: Decision): string {
  const a = d.answer
  if (a === null) return 'answered'
  if (a.kind === 'message') return `answered in a message ${JSON.stringify(oneLine(a.text))}`
  const note = a.note ? ` with the note ${JSON.stringify(oneLine(a.note))}` : ''
  if (a.kind === 'option') return `chose ${JSON.stringify(oneLine(d.options[a.index] ?? `option ${a.index + 1}`))}${note}`
  const choice = { allow_once: 'allowed once', always_allow: 'always allowed', deny: 'denied' }[a.choice]
  return `${choice}${note}`
}

/** The block that opens the orchestrator's next message, or null when nothing was answered. */
export function answeredBlock(answered: AnsweredDecision[]): string | null {
  if (answered.length === 0) return null
  const lines = answered.map(({ number, title, workspace, decision: d }) => {
    // A message's answer text already says "in a message".
    const from = d.answeredVia && d.answeredVia !== 'message' ? ` ${ANSWERED_VIA_PHRASES[d.answeredVia]}` : ''
    return `- #${number} ${JSON.stringify(oneLine(title))}${wsTag(workspace)}, asked ${JSON.stringify(oneLine(d.question))}: the user ${answerText(d)}${from}. Don't propose an answer to it.`
  })
  return [ANSWERED_HEADING, ...lines].join('\n')
}

import { VisuallyHidden } from '@mantine/core'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useMainbus, type BoardTicket } from './store'

/** What a screen reader hears for decisions that are new since `seen`; `seen` gains them. Empty when none are. */
export function newDecisionMessages(tickets: BoardTicket[], seen: Set<string>): string[] {
  const messages: string[] = []
  for (const t of tickets) {
    for (const d of t.pendingDecisions) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      messages.push(`#${t.number} ${t.title} needs you: ${d.question}`)
    }
  }
  return messages
}

/**
 * A visually hidden, polite live region that announces each decision that newly needs the person, once. What is
 * on the board when it loads, or when the workspace changes, is not announced; the board shows that.
 */
export function Announcer(): ReactElement {
  const tickets = useMainbus((s) => s.tickets)
  const boardLoaded = useMainbus((s) => s.boardLoaded)
  const workspaceId = useMainbus((s) => s.workspace?.id ?? null)
  const seen = useRef(new Set<string>())
  const seededFor = useRef<string | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!boardLoaded || workspaceId === null) {
      seededFor.current = null
      return
    }
    if (seededFor.current !== workspaceId) {
      seen.current = new Set()
      newDecisionMessages(tickets, seen.current)
      seededFor.current = workspaceId
      setMessage('')
      return
    }
    const messages = newDecisionMessages(tickets, seen.current)
    if (messages.length > 0) setMessage(messages.join('. '))
  }, [tickets, boardLoaded, workspaceId])

  return (
    <VisuallyHidden role="status" aria-live="polite" aria-atomic data-testid="announcer">
      {message}
    </VisuallyHidden>
  )
}

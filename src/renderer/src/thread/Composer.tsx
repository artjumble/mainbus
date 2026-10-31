import { Button, Textarea } from '@mantine/core'
import { useState, type KeyboardEvent, type ReactElement } from 'react'

interface Props {
  /** Rejects when the message could not be sent; the text then stays in the box. */
  onSend: (text: string) => Promise<void>
  placeholder?: string
}

/** A message box with Send inside it (not beside it). Ctrl+Enter sends. */
export function Composer({ onSend, placeholder = 'Message' }: Props): ReactElement {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const canSend = text.trim() !== '' && !sending

  async function send(): Promise<void> {
    if (!canSend) return
    setSending(true)
    try {
      await onSend(text.trim())
      setText('')
    } catch {
      // The caller reported the failure; keep the text so nothing typed is lost.
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <Textarea
      aria-label={placeholder}
      placeholder={placeholder}
      autosize
      minRows={2}
      maxRows={8}
      value={text}
      onChange={(e) => setText(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      rightSectionWidth={72}
      rightSectionProps={{ style: { alignItems: 'flex-end', padding: 6 } }}
      rightSection={
        <Button size="compact-sm" disabled={!canSend} loading={sending} onClick={() => void send()}>
          Send
        </Button>
      }
    />
  )
}

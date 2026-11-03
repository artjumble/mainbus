import { Button, Textarea } from '@mantine/core'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

interface Props {
  /** Rejects when the message could not be sent; the text then stays in the box. */
  onSend: (text: string) => Promise<void>
  placeholder?: string
  /** Enter sends and Shift+Enter starts a new line, instead of Ctrl+Enter sending. */
  enterSends?: boolean
  /** A turn is running: the button inside the box is Stop (calls `onStop`), and typing goes on. */
  working?: boolean
  onStop?: () => Promise<void>
  /** Text to put in the box, then focus it with the caret at the end; applied again whenever `n` changes. */
  prefill?: { text: string; n: number } | null
  /** Called once the prefill is in the box. */
  onPrefilled?: () => void
}

/** A message box with Send inside it (not beside it). Ctrl+Enter sends, or Enter with `enterSends`. */
export function Composer({
  onSend,
  placeholder = 'Message',
  enterSends = false,
  working = false,
  onStop,
  prefill = null,
  onPrefilled
}: Props): ReactElement {
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!prefill) return
    setText(prefill.text)
    const box = input.current
    if (box) {
      box.focus()
      box.setSelectionRange(prefill.text.length, prefill.text.length)
    }
    onPrefilled?.()
    // Only a new ask (n) applies; the callback changing is not one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.n])
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const canSend = text.trim() !== '' && !sending && !working

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

  async function stop(): Promise<void> {
    if (!onStop || stopping) return
    setStopping(true)
    try {
      await onStop()
    } catch {
      // The caller reported the failure.
    } finally {
      setStopping(false)
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return
    if (e.ctrlKey || e.metaKey || (enterSends && !e.shiftKey && !e.nativeEvent.isComposing)) {
      e.preventDefault()
      void send()
    }
  }

  const showStop = working && onStop !== undefined

  return (
    <Textarea
      ref={input}
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
        showStop ? (
          <Button size="compact-sm" variant="default" loading={stopping} onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button size="compact-sm" disabled={!canSend} loading={sending} onClick={() => void send()}>
            Send
          </Button>
        )
      }
    />
  )
}

import { Button, Textarea } from '@mantine/core'
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'
import { dragHasFiles, filesOf } from '../attachments/files'

interface Props {
  /** Rejects when the message could not be sent; the text then stays in the box. */
  onSend: (text: string) => Promise<void>
  placeholder?: string
  /** A visible label above the box, which is also its accessible name; without one the placeholder names it. */
  label?: string
  /** What the button reads; its accessible name begins with "Send" either way. */
  sendLabel?: string
  /** Enter sends and Shift+Enter starts a new line, instead of Ctrl+Enter sending. */
  enterSends?: boolean
  /** A turn is running: the button inside the box is Stop (calls `onStop`), and typing goes on. */
  working?: boolean
  onStop?: () => Promise<void>
  /** Text to put in the box, then focus it with the caret at the end; applied again whenever `n` changes. */
  prefill?: { text: string; n: number } | null
  /** Called once the prefill is in the box. */
  onPrefilled?: () => void
  /** Images pasted or dropped into the box; without it they are left to the browser. */
  onAttach?: (files: File[]) => void
}

/** A message box with Send inside it (not beside it). Ctrl+Enter sends, or Enter with `enterSends`. */
export function Composer({
  onSend,
  placeholder = 'Message',
  label,
  sendLabel = 'Send',
  enterSends = false,
  working = false,
  onStop,
  prefill = null,
  onPrefilled,
  onAttach
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

  // A pasted image is attached; text pasted with it still goes into the box.
  function onPaste(e: ClipboardEvent): void {
    const files = onAttach ? filesOf(e.clipboardData) : []
    if (files.length === 0) return
    if (e.clipboardData.getData('text/plain') === '') e.preventDefault()
    onAttach?.(files)
  }

  function onDragOver(e: DragEvent): void {
    if (onAttach && dragHasFiles(e.dataTransfer)) e.preventDefault()
  }

  function onDrop(e: DragEvent): void {
    const files = onAttach ? filesOf(e.dataTransfer) : []
    if (files.length === 0) return
    e.preventDefault()
    onAttach?.(files)
  }

  return (
    <Textarea
      ref={input}
      label={label}
      labelProps={{ fz: 'xs', c: 'dimmed', mb: 4 }}
      aria-label={label === undefined ? placeholder : undefined}
      placeholder={placeholder}
      autosize
      minRows={2}
      maxRows={8}
      value={text}
      onChange={(e) => setText(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
      rightSectionWidth={sendLabel === 'Send' ? 72 : 130}
      rightSectionProps={{ style: { alignItems: 'flex-end', padding: 6 } }}
      rightSection={
        showStop ? (
          <Button size="compact-sm" variant="default" loading={stopping} onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button size="compact-sm" disabled={!canSend} loading={sending} onClick={() => void send()}>
            {sendLabel}
          </Button>
        )
      }
    />
  )
}

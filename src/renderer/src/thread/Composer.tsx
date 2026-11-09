import { Box, Button, Combobox, Group, Text, Textarea, useCombobox } from '@mantine/core'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import { activeMention, findMentions, mentionText } from '../../../shared/mentions'
import { dragHasFiles, filesOf } from '../attachments/files'
import { caretPosition } from './caretPosition'

export interface MentionOption {
  id: string
  name: string
  /** Shown dimmed beside the name: the repo path. */
  detail: string
  /** The one the user is focused on, marked in the list. */
  current?: boolean
}

/**
 * The options matching what was typed after the @: names starting with it first, then names with a word starting with it,
 * then names containing it. Case-insensitive; each group keeps the order given. An empty query keeps them all.
 */
export function filterMentionOptions(options: MentionOption[], query: string): MentionOption[] {
  const q = query.toLowerCase()
  if (q === '') return options
  const lower = (o: MentionOption): string => o.name.toLowerCase()
  const prefix = options.filter((o) => lower(o).startsWith(q))
  const word = options.filter((o) => !prefix.includes(o) && lower(o).split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q)))
  const inside = options.filter((o) => !prefix.includes(o) && !word.includes(o) && lower(o).includes(q))
  return [...prefix, ...word, ...inside]
}

interface Props {
  /** Rejects when the message could not be sent; the text then stays in the box. `mentions` is passed only with the `mentions` prop. */
  onSend: (text: string, mentions?: string[]) => Promise<void>
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
  /** Send works with the box empty: the message has images of its own. */
  canSendEmpty?: boolean
  /**
   * Typing @ at a word start offers these (`label` names the list); the ids of the ones picked go to `onSend` as its second
   * argument. Without it the box has no mentions.
   */
  mentions?: { options: MentionOption[]; label: string }
}

const MENTION_LIST_WIDTH = 260

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
  onAttach,
  canSendEmpty = false,
  mentions
}: Props): ReactElement {
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const [picked, setPicked] = useState<{ id: string; token: string }[]>([])
  const [active, setActive] = useState<{ start: number; query: string } | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [anchor, setAnchor] = useState({ left: 0, top: 0, height: 0 })
  const frame = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const caretAfter = useRef<number | null>(null)
  const combobox = useCombobox()
  const filtered = useMemo(
    () => (mentions && active ? filterMentionOptions(mentions.options, active.query) : []),
    [mentions, active]
  )
  const open = active !== null && dismissed !== active.start && filtered.length > 0
  const query = active?.query

  useEffect(() => {
    if (open) {
      combobox.openDropdown()
      setActiveId(combobox.selectFirstOption())
    } else combobox.closeDropdown()
    // The store's functions are stable; the list opening or its query changing is what re-selects the first option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query])

  useLayoutEffect(() => {
    if (caretAfter.current === null) return
    input.current?.setSelectionRange(caretAfter.current, caretAfter.current)
    caretAfter.current = null
  }, [text])

  useEffect(() => {
    if (!prefill) return
    setText(prefill.text)
    setPicked([])
    setActive(null)
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
  const canSend = (text.trim() !== '' || canSendEmpty) && !sending && !working

  /** Looks at where the caret is: whether an @ is being typed there. */
  function track(value: string, caret: number): void {
    if (!mentions) return
    const now = activeMention(value, caret)
    setActive(now)
    if (now === null) setDismissed(null)
    else if (input.current && frame.current) {
      const at = caretPosition(input.current, caret)
      const from = input.current.getBoundingClientRect()
      const into = frame.current.getBoundingClientRect()
      const line = parseFloat(getComputedStyle(input.current).lineHeight) || 20
      // The target is the caret's whole line, so the list opens clear of it whichever way it goes.
      setAnchor({ left: at.left + from.left - into.left, top: at.top - line + from.top - into.top, height: line })
    }
  }

  function pick(id: string): void {
    const option = filtered.find((o) => o.id === id)
    const box = input.current
    if (!option || !active || !box) return
    const token = mentionText(option.name)
    const next = `${text.slice(0, active.start)}${token} ${text.slice(box.selectionStart)}`
    caretAfter.current = active.start + token.length + 1
    setText(next)
    setPicked((now) => [...now, { id, token }])
    setDismissed(active.start)
  }

  async function send(): Promise<void> {
    if (!canSend) return
    setSending(true)
    try {
      // Only the ones still in the text: a mention that was deleted afterwards doesn't count.
      const tokens = new Set(findMentions(text).map((m) => m.raw))
      const ids = [...new Set(picked.filter((p) => tokens.has(p.token)).map((p) => p.id))]
      await (mentions ? onSend(text.trim(), ids) : onSend(text.trim()))
      setText('')
      setPicked([])
      setActive(null)
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
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveId(e.key === 'ArrowDown' ? combobox.selectNextOption() : combobox.selectPreviousOption())
        return
      }
      // While the list is open, Enter picks rather than sends.
      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        combobox.clickSelectedOption()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(active!.start)
        return
      }
    }
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

  const box = (
    <Textarea
      ref={input}
      label={label}
      labelProps={{ fz: 'xs', c: 'dimmed', mb: 4 }}
      aria-label={label === undefined ? placeholder : undefined}
      aria-autocomplete={mentions ? 'list' : undefined}
      placeholder={placeholder}
      autosize
      minRows={2}
      maxRows={8}
      value={text}
      onChange={(e) => {
        setText(e.currentTarget.value)
        track(e.currentTarget.value, e.currentTarget.selectionStart)
      }}
      onSelect={mentions ? (e) => track(e.currentTarget.value, e.currentTarget.selectionStart) : undefined}
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

  if (!mentions) return box
  return (
    <Box pos="relative" ref={frame}>
      <Combobox store={combobox} onOptionSubmit={pick} position="top-start"
        width={MENTION_LIST_WIDTH}
        shadow="md"
        withinPortal
        zIndex={400}
        middlewares={{ shift: { boundary: frame.current ?? undefined, padding: 0 } }}
      >
        {/* The target is a zero-size caret marker, so the list needs a width of its own rather than the target's. */}
        <Combobox.DropdownTarget>
          <span aria-hidden style={{ position: 'absolute', left: anchor.left, top: anchor.top, width: 0, height: anchor.height }} />
        </Combobox.DropdownTarget>
        {/* Mantine's own aria-activedescendant follows its keyboard navigation, which is off here, so ours is passed to override it. */}
        <Combobox.EventsTarget
          withKeyboardNavigation={false}
          withExpandedAttribute={false}
          aria-activedescendant={open ? (activeId ?? undefined) : undefined}
        >
          {box}
        </Combobox.EventsTarget>
        <Combobox.Dropdown hidden={!open}>
          <Combobox.Options aria-label={mentions.label} onMouseDown={(e) => e.preventDefault()}>
            {filtered.map((o) => (
              <Combobox.Option key={o.id} value={o.id}>
                <Group gap="xs" wrap="nowrap">
                  <Text size="sm" fw={500} truncate style={{ flexShrink: 0, maxWidth: '60%' }}>
                    {o.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
                    {o.detail}
                  </Text>
                  {o.current && (
                    <Text size="xs" c="dimmed">
                      focused
                    </Text>
                  )}
                </Group>
              </Combobox.Option>
            ))}
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>
    </Box>
  )
}

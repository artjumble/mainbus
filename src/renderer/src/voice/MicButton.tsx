import { ActionIcon, Group, Loader, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { DICTATION_SHORTCUT } from '../../../shared/voice'
import { formatElapsed, type DictationState } from './dictation'

const onWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

const TIP = `Dictate (${DICTATION_SHORTCUT}). Speech is turned into text on this computer; nothing is uploaded.${onWindows ? ' Windows voice typing (Win+H) also works in any field.' : ''}`

function MicIcon({ recording }: { recording: boolean }): ReactElement {
  return recording ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </svg>
  )
}

/** The mic button inside a field's corner. Pressed while recording; it is the same control that stops. */
export function MicButton({
  state,
  fieldLabel,
  onToggle,
  onKeyDown
}: {
  state: DictationState
  fieldLabel: string
  onToggle: () => void
  onKeyDown: (e: KeyboardEvent<Element>) => void
}): ReactElement {
  const recording = state.kind === 'recording'
  const busy = state.kind === 'starting' || recording || state.kind === 'transcribing'
  return (
    <Tooltip label={TIP} multiline w={260} openDelay={400} withArrow>
      <ActionIcon
        variant={recording ? 'filled' : 'subtle'}
        color={recording ? 'red' : 'gray'}
        size="md"
        aria-label="Dictate"
        // Which field it types into, as a description: a name that held the field's label would answer a search for that label.
        aria-description={`Into: ${fieldLabel}`}
        aria-pressed={recording}
        aria-keyshortcuts="Control+Shift+Space"
        // A dialog or drawer around the field closes on Esc unless the key's target says it uses it; here Esc cancels the dictation.
        data-mantine-stop-propagation={busy ? 'true' : undefined}
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        {state.kind === 'transcribing' || state.kind === 'starting' ? <Loader size={14} /> : <MicIcon recording={recording} />}
      </ActionIcon>
    </Tooltip>
  )
}

const BARS = 5

/** A few bars that follow the loudness. No transitions; with reduced motion it moves in coarse steps a few times a second. */
function LevelMeter({ level }: { level: () => number }): ReactElement {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (reduced) {
      const timer = setInterval(() => setValue(Math.round(level() * 4) / 4), 250)
      return () => clearInterval(timer)
    }
    let frame = requestAnimationFrame(function tick() {
      setValue(level())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [reduced, level])
  const lit = Math.round(value * BARS)
  return (
    <span aria-hidden="true" data-testid="level-meter" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14 }}>
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          style={{ width: 3, height: 4 + i * 2.5, background: i < lit ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-gray-5)', opacity: i < lit ? 1 : 0.5 }}
        />
      ))}
    </span>
  )
}

function Elapsed(): ReactElement {
  const started = useRef(Date.now())
  const [ms, setMs] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setMs(Date.now() - started.current), 250)
    return () => clearInterval(timer)
  }, [])
  return <Text size="xs" fw={500} aria-hidden="true">{formatElapsed(ms)}</Text>
}

/**
 * What is going on under the field: the level meter and the time while recording, "Transcribing…", or the error in red.
 * Its own timers keep the field itself from re-rendering several times a second. The hidden live region speaks the
 * changes politely; the ticking time is never in it.
 */
export function DictationStatus({ state, level, announcement }: { state: DictationState; level: () => number; announcement: string }): ReactElement {
  return (
    <>
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
      {state.kind === 'recording' && (
        <Group gap="xs" mt={4} wrap="nowrap">
          <LevelMeter level={level} />
          <Elapsed />
          <Text size="xs" c="dimmed">
            Enter to stop, Esc to cancel
          </Text>
        </Group>
      )}
      {state.kind === 'transcribing' && (
        <Group gap="xs" mt={4} wrap="nowrap">
          <Loader size={12} />
          <Text size="xs" c="dimmed">
            Transcribing…
          </Text>
        </Group>
      )}
      {state.kind === 'error' && (
        <Text size="xs" c="red" mt={4}>
          {state.message}
        </Text>
      )}
    </>
  )
}

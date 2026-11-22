import { ActionIcon, Tooltip } from '@mantine/core'
import { useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import styles from './FieldLabel.module.css'
import targets from './targets.module.css'

/**
 * A field's label on one line, with a small (?) button beside it that shows the field's description: on hover and on
 * focus, and pinned open by a click, Enter or Space. Escape or a click elsewhere closes it.
 */
export function FieldLabel({ label, info, textId }: { label: ReactNode; info: string; textId?: string }): ReactElement {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [pinned, setPinned] = useState(false)
  const opened = hover || focus || pinned
  const name = typeof label === 'string' ? label : 'this field'

  function close(): void {
    setHover(false)
    setFocus(false)
    setPinned(false)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && opened) {
      // Close the tooltip only, not the drawer around the field.
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      close()
    }
  }

  return (
    <span className={styles.label}>
      <span id={textId} className={styles.text}>{label}</span>
      <Tooltip label={info} multiline w={280} withArrow opened={opened} events={{ hover: false, focus: false, touch: false }}>
        <ActionIcon
          type="button"
          variant="subtle"
          color="gray"
          size="xs"
          radius="xl"
          className={`${targets.target} ${styles.info}`}
          aria-label={`About ${name}`}
          aria-expanded={opened}
          data-mantine-stop-propagation={opened ? 'true' : undefined}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onFocus={() => setFocus(true)}
          onBlur={() => {
            setFocus(false)
            setPinned(false)
          }}
          onClick={(e) => {
            e.preventDefault()
            setPinned((p) => !p)
            // A click that closes it must not leave hover or focus holding it open.
            if (pinned) close()
          }}
          onKeyDown={onKeyDown}
        >
          <span aria-hidden="true" className={styles.mark}>
            ?
          </span>
        </ActionIcon>
      </Tooltip>
    </span>
  )
}

/**
 * The props that give a Mantine input a one-line label with an info button, and keep its description for screen
 * readers: it stays the input's description (aria-describedby) but is hidden visually.
 */
export function fieldInfo(label: string, info: string): {
  label: ReactElement
  description: string
  classNames: { label: string; description: string }
  'aria-labelledby': string
} {
  // The info button sits inside the label element, so point the input's name at the label text alone.
  const textId = `field-label-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return {
    label: <FieldLabel label={label} info={info} textId={textId} />,
    'aria-labelledby': textId,
    description: info,
    classNames: { label: styles.fieldLabel, description: styles.hidden }
  }
}

import { CodeHighlight } from '@mantine/code-highlight'
import { Button, CopyButton } from '@mantine/core'
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import classes from './CodeBlock.module.css'

// The line height of the block (xs font, 1.7) and its padding, for the height a capped block shows.
const LINE_PX = 13 * 1.7
const PADDING_PX = 20

/**
 * Code as a block: highlighted by `language` (plain when it is missing or unknown), monospaced, with its language
 * above, a Copy button, and horizontal scrolling rather than wrapping. A block of more than `maxLines` lines is
 * capped in height, with Show all. When it scrolls, the keyboard can scroll it.
 * `copyLabel` is the Copy button's accessible name ("Copy command").
 */
export function CodeBlock({
  code,
  language,
  label = language,
  copyLabel = 'Copy code',
  maxLines
}: {
  code: string
  language?: string
  /** What the header says; the language by default. */
  label?: string
  copyLabel?: string
  maxLines?: number
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const lines = code.split('\n').length
  const capped = maxLines !== undefined && lines > maxLines
  const collapsed = capped && !expanded
  // The block scrolls sideways when its lines are wider than it (checked as it resizes, and as highlighting fills it).
  const rootRef = useRef<HTMLDivElement>(null)
  const [scrollsSideways, setScrollsSideways] = useState(false)
  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>('.mantine-ScrollArea-viewport')
    if (!viewport) return undefined
    const measure = (): void => setScrollsSideways(viewport.scrollWidth > viewport.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    for (const child of Array.from(viewport.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [code])

  return (
    <div className={classes.root} ref={rootRef}>
      <div className={classes.header}>
        <span className={classes.label}>{label ?? ''}</span>
        <span className={classes.actions}>
          {capped && (
            <Button size="compact-xs" variant="subtle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={id}>
              {expanded ? 'Show less' : 'Show all'}
            </Button>
          )}
          <CopyButton value={code}>
            {({ copied, copy }) => (
              <Button size="compact-xs" variant="subtle" onClick={copy} aria-label={copied ? 'Copied' : copyLabel}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        </span>
      </div>
      <CodeHighlight
        id={id}
        code={code}
        language={language}
        withCopyButton={false}
        withExpandButton={false}
        withFirstLineIndentation
        expanded={!collapsed}
        maxCollapsedHeight={maxLines === undefined ? undefined : maxLines * LINE_PX + PADDING_PX}
        background="transparent"
        // Mantine's own Expand button is always in the DOM; ours is in the header.
        styles={{ showCodeButton: { display: 'none' } }}
        attributes={{ pre: { tabIndex: collapsed || scrollsSideways ? 0 : undefined } }}
      />
    </div>
  )
}

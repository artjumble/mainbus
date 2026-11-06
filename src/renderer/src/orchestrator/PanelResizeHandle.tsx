import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import classes from './PanelResizeHandle.module.css'
import { DEFAULT_PANEL_WIDTH, MIN_PANEL_WIDTH } from './panelState'

interface Props {
  width: number
  max: number
  /** `done` is false while a drag is under way and true for the final value. */
  onChange: (width: number, done: boolean) => void
  onDraggingChange?: (dragging: boolean) => void
}

const STEP = 16

/** A separator on the panel's left edge: drag it, or use the keyboard. */
export function PanelResizeHandle({ width, max, onChange, onDraggingChange }: Props): ReactElement {
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; width: number } | null>(null)
  const latest = useRef(width)

  const clamp = (w: number): number => Math.min(Math.max(w, MIN_PANEL_WIDTH), max)

  function setDrag(on: boolean): void {
    setDragging(on)
    onDraggingChange?.(on)
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    e.preventDefault() // no text selection while dragging
    e.currentTarget.setPointerCapture?.(e.pointerId)
    start.current = { x: e.clientX, width }
    latest.current = width
    setDrag(true)
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    if (!start.current) return
    // The panel is on the right, so moving left widens it.
    latest.current = clamp(start.current.width + (start.current.x - e.clientX))
    onChange(latest.current, false)
  }

  function endDrag(): void {
    if (!start.current) return
    start.current = null
    setDrag(false)
    onChange(latest.current, true)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const step = e.shiftKey ? STEP * 4 : STEP
    let next: number
    // The edge moves the way the arrow points: Left widens the panel.
    if (e.key === 'ArrowLeft') next = width + step
    else if (e.key === 'ArrowRight') next = width - step
    else if (e.key === 'Home') next = MIN_PANEL_WIDTH
    else if (e.key === 'End') next = max
    else if (e.key === 'Enter') next = DEFAULT_PANEL_WIDTH
    else return
    e.preventDefault()
    onChange(clamp(next), true)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize orchestrator panel"
      aria-valuenow={width}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={max}
      tabIndex={0}
      className={classes.handle}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onChange(clamp(DEFAULT_PANEL_WIDTH), true)}
      onKeyDown={onKeyDown}
    />
  )
}

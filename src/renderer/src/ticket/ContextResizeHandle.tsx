import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import classes from './ContextResizeHandle.module.css'
import { DEFAULT_CONTEXT_WIDTH, MIN_CONTEXT_WIDTH } from './contextWidth'

interface Props {
  width: number
  max: number
  /** `done` is false while a drag is under way and true for the final value. */
  onChange: (width: number, done: boolean) => void
}

const STEP = 16

/** A separator on the left column's right edge: drag it, or use the keyboard. Double-click resets. */
export function ContextResizeHandle({ width, max, onChange }: Props): ReactElement {
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; width: number } | null>(null)
  const latest = useRef(width)

  const clamp = (w: number): number => Math.min(Math.max(w, MIN_CONTEXT_WIDTH), max)

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    e.preventDefault() // no text selection while dragging
    e.currentTarget.setPointerCapture?.(e.pointerId)
    start.current = { x: e.clientX, width }
    latest.current = width
    setDragging(true)
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    if (!start.current) return
    latest.current = clamp(start.current.width + (e.clientX - start.current.x))
    onChange(latest.current, false)
  }

  function endDrag(): void {
    if (!start.current) return
    start.current = null
    setDragging(false)
    onChange(latest.current, true)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const step = e.shiftKey ? STEP * 4 : STEP
    let next: number
    if (e.key === 'ArrowRight') next = width + step
    else if (e.key === 'ArrowLeft') next = width - step
    else if (e.key === 'Home') next = MIN_CONTEXT_WIDTH
    else if (e.key === 'End') next = max
    else if (e.key === 'Enter') next = DEFAULT_CONTEXT_WIDTH
    else return
    e.preventDefault()
    onChange(clamp(next), true)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize ticket details"
      aria-valuenow={width}
      aria-valuemin={MIN_CONTEXT_WIDTH}
      aria-valuemax={max}
      tabIndex={0}
      className={classes.handle}
      style={{ left: width }}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onChange(clamp(DEFAULT_CONTEXT_WIDTH), true)}
      onKeyDown={onKeyDown}
    />
  )
}

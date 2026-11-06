import { useEffect, useState } from 'react'

/** Hovering expands a panel after this long, so passing over it on the way elsewhere doesn't. */
export const EXPAND_OPEN_MS = 150
/** It collapses this long after nothing holds it open any more, so it doesn't flicker. */
export const EXPAND_CLOSE_MS = 300

/**
 * Whether a collapsed panel is expanded: at once while `now` holds (focus inside, a drag over it), since its
 * contents must be reachable before the next key press; after a delay for a hover; and a little after both end.
 */
export function useExpandOnHover(now: boolean, hovered: boolean): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (now) {
      setOpen(true)
      return
    }
    const timer = setTimeout(() => setOpen(hovered), hovered ? EXPAND_OPEN_MS : EXPAND_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [now, hovered])
  return open || now
}

/** Whether focus on `el` came from the keyboard (the browser's own rule for showing a focus ring). */
export function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

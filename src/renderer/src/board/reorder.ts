import { KeyboardCode, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { isRanked } from '../../../shared/boardOrder'
import type { Column } from '../../../shared/domain'

interface Box {
  top: number
  bottom: number
}

const centerOf = (r: Box): number => (r.top + r.bottom) / 2

/**
 * The slot a card held with its centre at `centerY` takes among the other cards (rects top to bottom, the held card
 * left out): the number of cards whose centre is above it. 0 is the top; `others.length` is the bottom.
 */
export function slotIn(centerY: number, others: Box[]): number {
  return others.filter((r) => centerOf(r) < centerY).length
}

/** The y of a card's centre when it sits in `slot` among `others`: the boundary the slot's drop line is drawn at. */
export function slotCenter(slot: number, others: Box[]): number {
  if (others.length === 0) return 0
  if (slot <= 0) return others[0]!.top
  if (slot >= others.length) return others[others.length - 1]!.bottom
  return (centerOf(others[slot - 1]!) + centerOf(others[slot]!)) / 2
}

/** The cards of a column, top to bottom, with their rects, leaving out the one held. */
export function cardRects(column: Element | null, heldId: string): { id: string; top: number; bottom: number }[] {
  if (!column) return []
  return [...column.querySelectorAll<HTMLElement>('[data-ticket-id]')]
    .filter((el) => el.dataset.ticketId !== heldId)
    .map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.ticketId!, top: r.top, bottom: r.bottom }
    })
    .sort((a, b) => a.top - b.top)
}

/** The lane (`section`) of a column, found by its heading. */
export const laneOf = (columnId: string): Element | null =>
  document.querySelector(`section[aria-labelledby="column-${columnId}"]`)

/** The column a card is in, from where its element sits. */
function columnOfCard(id: string): Column | null {
  const heading = document
    .querySelector(`[data-ticket-id="${id}"]`)
    ?.closest('section[aria-labelledby]')
    ?.getAttribute('aria-labelledby')
  return heading?.startsWith('column-') ? (heading.slice('column-'.length) as Column) : null
}

/**
 * Arrow Left and Right carry a card being moved by keyboard to the next column that takes drops, skipping the ones
 * that don't. Up and Down move it one place up or down inside Backlog and Ready, and do nothing elsewhere, or while
 * `reorderOff()` says a search is on.
 */
export function makeCoordinates(reorderOff: () => boolean): KeyboardCoordinateGetter {
  return (event, { active, context, currentCoordinates }) => {
    if (event.code === KeyboardCode.Up || event.code === KeyboardCode.Down) {
      if (reorderOff() || active === null) return undefined
      const column = columnOfCard(String(active))
      if (column === null || !isRanked(column)) return undefined
      const others = cardRects(laneOf(column), String(active))
      const height = context.collisionRect?.height ?? context.activeNode?.getBoundingClientRect().height ?? 0
      const slot = slotIn(currentCoordinates.y + height / 2, others)
      const next = Math.min(others.length, Math.max(0, slot + (event.code === KeyboardCode.Down ? 1 : -1)))
      if (next === slot) return undefined
      return { x: currentCoordinates.x, y: slotCenter(next, others) - height / 2 }
    }
    if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) return undefined
    const rects = context.droppableContainers
      .getEnabled()
      .map((c) => context.droppableRects.get(c.id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .sort((a, b) => a.left - b.left)
    const next =
      event.code === KeyboardCode.Right
        ? rects.find((r) => r.left > currentCoordinates.x)
        : rects.findLast((r) => r.right <= currentCoordinates.x)
    if (!next) return undefined
    // Inside the column, near its top, so the card's rectangle overlaps that column and no other.
    return { x: next.left + 8, y: next.top + 48 }
  }
}

/** The rank a card shows at before the engine has answered: between its neighbours, or after the last one. */
export function displayRank(column: { id: string; rank: number }[], movingId: string, before: string | null): number {
  const others = column.filter((t) => t.id !== movingId)
  const bottom = others.length === 0 ? 1 : others[others.length - 1]!.rank + 1
  if (before === null) return bottom
  const i = others.findIndex((t) => t.id === before)
  if (i < 0) return bottom
  return i === 0 ? others[0]!.rank - 1 : (others[i - 1]!.rank + others[i]!.rank) / 2
}

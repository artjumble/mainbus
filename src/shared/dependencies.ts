// Shared by the engine and the renderer: the words used for a ticket's blockers.
import type { Blocker } from './domain'

/** The blockers that aren't Done, in number order. */
export function openBlockers<T extends { done: boolean; number: number }>(blockedBy: T[]): T[] {
  return blockedBy.filter((b) => !b.done).sort((a, b) => a.number - b.number)
}

function joinNumbers(numbers: number[]): string {
  const tags = numbers.map((n) => `#${n}`)
  return tags.length <= 1 ? tags.join('') : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`
}

/** "Blocked by #39", "Blocked by #39 and #40", "Blocked by #39, #40 and #41", then "Blocked by #39, #40, #41 +2". */
export function blockedLabel(open: Pick<Blocker, 'number'>[]): string {
  const shown = open.slice(0, 3).map((b) => b.number)
  if (open.length <= 3) return `Blocked by ${joinNumbers(shown)}`
  return `Blocked by ${shown.map((n) => `#${n}`).join(', ')} +${open.length - 3}`
}

/** "#39 isn't Done yet" or "#39 and #40 aren't Done yet". */
export function notDoneYetText(open: Pick<Blocker, 'number'>[]): string {
  return `${joinNumbers(open.map((b) => b.number))} ${open.length === 1 ? "isn't" : "aren't"} Done yet`
}

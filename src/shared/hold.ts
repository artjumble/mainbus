// Shared by the engine and the renderer: pure functions of a date, in the local time zone. No Node imports.
import type { Hold } from './domain'

const DAY_MS = 24 * 60 * 60 * 1000

/** The start of the local day `date` falls on. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** The start of tomorrow, local time: the "Tomorrow" quick pick. */
export function tomorrow(now: Date): Date {
  const d = startOfDay(now)
  d.setDate(d.getDate() + 1)
  return d
}

/** The start of the next Monday after today (a week ahead when today is a Monday): the "Monday" quick pick. */
export function nextMonday(now: Date): Date {
  const d = startOfDay(now)
  d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7))
  return d
}

/** "2026-11-04", the value of a date input, for the local day `date` falls on. */
export function dateInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The start of the local day a date input's value names, or null when it isn't a date. */
export function fromDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) || dateInputValue(d) !== value ? null : d
}

/** "Tue" for a date within the week of `now`, else "Nov 12". */
export function shortDay(until: string, now: Date): string {
  const date = new Date(until)
  const withinWeek = date.getTime() - now.getTime() < 7 * DAY_MS
  return withinWeek
    ? date.toLocaleDateString('en-US', { weekday: 'short' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * What the ticket's hold says: "Held by you", "Held until Tue" for a date within the week, and "Held until Nov 12"
 * beyond it.
 */
export function holdLabel(hold: Pick<Hold, 'until'>, now: Date): string {
  return hold.until === null ? 'Held by you' : `Held until ${shortDay(hold.until, now)}`
}

/** 09:00 local on the day `day` falls on: when a deferred decision comes back. */
export function atNine(day: Date): Date {
  const d = startOfDay(day)
  d.setHours(9)
  return d
}

/** Later… → Tomorrow: 09:00 tomorrow, local time. */
export function laterTomorrow(now: Date): Date {
  return atNine(tomorrow(now))
}

/** Later… → Monday: 09:00 on the next Monday (a week ahead when today is a Monday). */
export function laterMonday(now: Date): Date {
  return atNine(nextMonday(now))
}

/** "Deferred until Tue", on a deferred decision's card. */
export function deferredLabel(until: string, now: Date): string {
  return `Deferred until ${shortDay(until, now)}`
}

/** "Waiting on you · until Tue", the chip of a ticket whose only open decisions are deferred. */
export function waitingLabel(until: string, now: Date): string {
  return `Waiting on you · until ${shortDay(until, now)}`
}

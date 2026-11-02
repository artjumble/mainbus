// Shared by the engine and the renderer: pure functions only, no Node imports.

/** The local time of day of an ISO date-time, as "14:30". */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** What the thread says when a role declares a wait: "Implementer is waiting: the full test suite, until 14:30". */
export function waitingText(role: string, reason: string, until: string): string {
  return `${role} is waiting: ${reason}, until ${clockTime(until)}`
}

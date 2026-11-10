/**
 * What the thread and the digests say a wake turn is about: "Mainbus: 2 things to look at", "Mainbus: reviewing 2 finished
 * tickets", or both. `items` are the plain lines of everything it presented; `reviews` how many of those are finished tickets.
 */
export function wakeEventText(items: string[], reviews = 0): string {
  const other = items.length - reviews
  const things = `${other} ${other === 1 ? 'thing' : 'things'} to look at`
  const review = `reviewing ${reviews} finished ${reviews === 1 ? 'ticket' : 'tickets'}`
  if (reviews <= 0) return `Mainbus: ${things}`
  return other <= 0 ? `Mainbus: ${review}` : `Mainbus: ${things}, and ${review}`
}

/** How a ticket's Activity and the thread tell the orchestrator's review of it after it reached Done. */
export function doneReviewedText(followUps: number): string {
  if (followUps <= 0) return 'Reviewed by the orchestrator: no follow-ups proposed'
  return `Reviewed by the orchestrator: ${followUps} ${followUps === 1 ? 'follow-up' : 'follow-ups'} proposed`
}

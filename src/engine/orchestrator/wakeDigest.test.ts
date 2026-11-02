import { describe, expect, test } from 'vitest'
import { WAKE_HEADING, wakeDigest, wakeLine, type OpenDecision, type WakeItem } from './wakeDigest'

const report = { number: 7, title: 'Login', role: 'Planner', evidence: ['No events for 10 minutes'], hitCount: 1, needsCloserLook: false }

const items: WakeItem[] = [
  { kind: 'failure', number: 3, title: 'Checkout', role: 'Implementer', error: 'The agent ended two turns in a row\nwithout a result' },
  { kind: 'stuck', report, open: true },
  { kind: 'released_hold', number: 5, title: 'Search', until: '2026-11-02T09:00:00.000Z' },
  { kind: 'resurfaced', number: 6, title: 'Profile', question: 'Keep the old URLs?', decisionId: 'd-6', stillOpen: true }
]

const open: OpenDecision[] = [
  { id: 'd-6', number: 6, title: 'Profile', question: 'Keep the old URLs?', status: 'pending', deferredUntil: null },
  { id: 'd-8', number: 8, title: 'Billing', question: 'Which provider?', status: 'deferred', deferredUntil: '2026-11-09T09:00:00.000Z' }
]

describe('wakeDigest', () => {
  const text = wakeDigest(items, open)

  test('starts by saying Mainbus started the turn, not the user', () => {
    expect(text.split('\n')[0]).toBe(WAKE_HEADING)
    expect(WAKE_HEADING).toContain('the user did not write it')
  })

  test('lists each item with its ticket, title and plain evidence', () => {
    expect(text).toContain('- #3 "Checkout": the Implementer\'s run failed and the ticket moved to Needs you.')
    expect(text).toContain('<ticket-data field="failure-error">The agent ended two turns in a row without a result</ticket-data>')
    expect(text).toContain('- #7 "Login": the Planner looks stuck.')
    expect(text).toContain('<ticket-data field="stuck-evidence">No events for 10 minutes</ticket-data>')
    expect(text).toContain('- #5 "Search" is no longer held (its date, 2026-11-02, came). It can be started again.')
    expect(text).toContain('- #6 "Profile": <ticket-data field="question">Keep the old URLs?</ticket-data> is waiting on the user again (decision d-6).')
  })

  test('lists every open decision of the workspace, the deferred ones with their date', () => {
    expect(text).toContain('Open decisions (all that are waiting or put off):')
    expect(text).toContain('- #6 "Profile" (decision d-6, waiting on the user): <ticket-data field="question">Keep the old URLs?</ticket-data>')
    expect(text).toContain('- #8 "Billing" (decision d-8, deferred until 2026-11-09): <ticket-data field="question">Which provider?</ticket-data>')
    expect(wakeDigest(items, [])).toContain('Open decisions: none.')
  })

  test('says the items may repeat, to be handled idempotently, and not to propose what is pending again', () => {
    expect(text).toContain('can repeat after a crash or restart')
    expect(text).toContain('idempotently')
    expect(text).toContain('do not propose again anything that is already pending')
    expect(text).toContain('Tickets cannot be drafted in this turn')
  })

  test('says so when an item has settled since', () => {
    const settled = wakeDigest(
      [
        { kind: 'stuck', report, open: false },
        { kind: 'resurfaced', number: 6, title: 'Profile', question: 'q', decisionId: 'd-6', stillOpen: false }
      ],
      []
    )
    expect(settled).toContain('- #7 "Login": the Planner looked stuck, but no longer does.')
    expect(settled).not.toContain('Evidence')
    expect(settled).toContain('has been settled since')
  })

  test('a failure with no recorded error still names the run', () => {
    expect(wakeDigest([{ kind: 'failure', number: 3, title: 'T', role: 'Tester', error: null }], [])).toContain(
      "- #3 \"T\": the Tester's run failed and the ticket moved to Needs you.\n"
    )
  })

  test('one plain line per item for the panel', () => {
    expect(items.map(wakeLine)).toEqual([
      '#3 "Checkout": the Implementer failed',
      '#7 "Login": the Planner looks stuck',
      '#5 "Search": its hold ran out',
      '#6 "Profile": a question you put off is back'
    ])
  })
})

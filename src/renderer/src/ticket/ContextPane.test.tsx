import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeDecision, makeEvent, makeTicket, renderWithMantine } from '../test-utils'
import { ContextPane, entryTime } from './ContextPane'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

const ticket = makeTicket({
  intent: [
    { text: 'I want dark mode,\n  exactly like this.', at: '2026-10-30T09:00:00.000Z' },
    { text: 'Also keep the contrast high', at: '2026-10-30T11:30:00.000Z' }
  ],
  spec: 'Add a theme toggle',
  criteria: [
    { position: 0, text: 'Toggle works', checked: false },
    { position: 1, text: 'Persists', checked: true }
  ],
  labels: ['ui', 'theme']
})

test('ContextPane shows "Your words" read-only with timestamps for later additions, and an editable spec', async () => {
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  const words = screen.getByRole('region', { name: 'Your words' })
  // Verbatim, whitespace included, and not editable.
  expect(within(words).getByText(/I want dark mode,/).textContent).toBe('I want dark mode,\n  exactly like this.')
  expect(within(words).queryByRole('textbox', { name: /I want dark mode/ })).not.toBeInTheDocument()
  // Only the later addition carries a timestamp.
  expect(within(words).getAllByRole('time')).toHaveLength(1)
  expect(within(words).getByRole('time')).toHaveAttribute('datetime', '2026-10-30T11:30:00.000Z')
  expect(within(words).getByText('Also keep the contrast high')).toBeInTheDocument()

  // The spec edits through ticket.update.
  const spec = screen.getByRole('textbox', { name: 'Spec' })
  expect(spec).toHaveValue('Add a theme toggle')
  const save = screen.getByRole('button', { name: 'Save spec' })
  expect(save).toBeDisabled()
  await userEvent.type(spec, ' with a switch')
  await userEvent.click(save)
  expect(mockInvoke).toHaveBeenCalledWith('ticket.update', ticket.id, { spec: 'Add a theme toggle with a switch' })
})

test('adding to your words appends intent and clears the box', async () => {
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  const add = screen.getByRole('button', { name: 'Add' })
  expect(add).toBeDisabled()
  await userEvent.type(screen.getByRole('textbox', { name: 'Add to your words' }), 'And a toggle in the header')
  await userEvent.click(add)
  expect(mockInvoke).toHaveBeenCalledWith('ticket.appendIntent', ticket.id, 'And a toggle in the header')
  expect(screen.getByRole('textbox', { name: 'Add to your words' })).toHaveValue('')
})

test('criteria are a checklist that saves on toggle; labels are shown', async () => {
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  expect(screen.getByRole('checkbox', { name: 'Persists' })).toBeChecked()
  await userEvent.click(screen.getByRole('checkbox', { name: 'Toggle works' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.update', ticket.id, {
    criteria: [
      { position: 0, text: 'Toggle works', checked: true },
      { position: 1, text: 'Persists', checked: true }
    ]
  })
  expect(screen.getByText('ui')).toBeInTheDocument()
  expect(screen.getByText('theme')).toBeInTheDocument()
})

test('the activity timeline lists run start, handoff, stop and answered decisions', () => {
  const events = [
    makeEvent({ kind: 'message', text: 'hi' }, { runId: 'a', at: '2026-10-30T10:00:00.000Z' }),
    makeEvent({ kind: 'handoff', summary: 'All done', outcome: 'done' }, { runId: 'a', at: '2026-10-30T10:30:00.000Z' }),
    makeEvent({ kind: 'message', text: 'again' }, { runId: 'b', at: '2026-10-30T12:00:00.000Z' }),
    makeEvent({ kind: 'stopped' }, { runId: 'b', at: '2026-10-30T12:10:00.000Z' })
  ]
  const decisions = [
    makeDecision({
      status: 'answered',
      answer: { kind: 'option', index: 0 },
      answeredAt: '2026-10-30T10:15:00.000Z',
      answeredBy: 'user',
      answeredVia: 'board'
    })
  ]
  renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={decisions} runs={{ a: { id: 'a', ticketRunId: 't', role: 'Implementer' } }} />)
  const activity = screen.getByRole('region', { name: 'Activity' })
  const items = within(activity)
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '')
  expect(items).toHaveLength(6)
  expect(items[0]).toMatch(/Created by you/)
  expect(items[1]).toMatch(/Started with the workspace lineup/)
  expect(items[2]).toMatch(/Decision: Which database\? → SQLite \(you, from the board\)/)
  expect(items[3]).toMatch(/Implementer handed off.*All done/)
  expect(items[4]).toMatch(/Started with the workspace lineup/)
  expect(items[5]).toMatch(/Stopped/)
})

test("the ticket's branch is shown once it has one, so the person knows what to merge", () => {
  const { unmount } = renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  expect(screen.queryByRole('region', { name: 'Branch' })).not.toBeInTheDocument()
  unmount()

  renderWithMantine(
    <ContextPane ticket={{ ...ticket, branch: 'mainbus/7-dark-mode' }} events={[]} decisions={[]} />
  )
  const branch = screen.getByRole('region', { name: 'Branch' })
  expect(within(branch).getByText('mainbus/7-dark-mode')).toBeInTheDocument()
})

test('the timeline begins with who created the ticket, and a ticket an agent filed says which', () => {
  const { unmount } = renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  expect(within(screen.getByRole('region', { name: 'Activity' })).getByText('Created by you')).toBeInTheDocument()
  unmount()
  const filed = makeTicket({ intent: [{ text: 'x', at: '2026-10-30T09:00:00.000Z', source: { kind: 'agent', agent: 'codex', cwd: '' } }] })
  renderWithMantine(<ContextPane ticket={filed} events={[]} decisions={[]} />)
  expect(within(screen.getByRole('region', { name: 'Activity' })).getByText('Filed by codex')).toBeInTheDocument()
})

test('entry times are the time of day, with the date when it is not today', () => {
  const now = new Date(2026, 10, 3, 15, 0)
  expect(entryTime(new Date(2026, 10, 3, 9, 5).toISOString(), now)).toBe('09:05')
  expect(entryTime(new Date(2026, 10, 2, 14, 5).toISOString(), now)).toMatch(/^Nov 2, 14:05$/)
})

test('words an agent filed sit apart from "Your words", with its reported name and folder', async () => {
  const filed = makeTicket({
    intent: [
      { text: 'The parser drops tabs.', at: '2026-10-30T09:00:00.000Z', source: { kind: 'agent', agent: 'codex', cwd: '/home/me/tools' } },
      { text: 'Only the parser, please', at: '2026-10-30T10:00:00.000Z' }
    ]
  })
  renderWithMantine(<ContextPane ticket={filed} events={[]} decisions={[]} />)
  const fromAgent = screen.getByRole('region', { name: 'From an agent' })
  expect(within(fromAgent).getByText('The parser drops tabs.')).toBeInTheDocument()
  const badge = within(fromAgent).getByText('from codex (reported)')
  await userEvent.hover(badge)
  expect(await screen.findByText('Filed from /home/me/tools')).toBeInTheDocument()

  const words = screen.getByRole('region', { name: 'Your words' })
  expect(within(words).getByText('Only the parser, please')).toBeInTheDocument()
  expect(within(words).queryByText('The parser drops tabs.')).not.toBeInTheDocument()
  expect(within(words).queryByText(/haven't added/)).not.toBeInTheDocument()
})

test('a ticket only an agent wrote says the user has not added their own words', () => {
  const filed = makeTicket({
    intent: [{ text: 'Agent words', at: '2026-10-30T09:00:00.000Z', source: { kind: 'agent', agent: 'cli', cwd: '' } }]
  })
  renderWithMantine(<ContextPane ticket={filed} events={[]} decisions={[]} />)
  expect(within(screen.getByRole('region', { name: 'Your words' })).getByText("You haven't added your own words yet.")).toBeInTheDocument()
})

test("the user's own tickets show no agent section or badge", () => {
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  expect(screen.queryByRole('region', { name: 'From an agent' })).not.toBeInTheDocument()
  expect(screen.queryByText(/\(reported\)/)).not.toBeInTheDocument()
})

test.each([
  ['board', 'the board'],
  ['orchestrator', 'the orchestrator panel'],
  ['thread', 'the thread']
] as const)('the activity entry for an answer from %s says so', (answeredVia, from) => {
  const decision = makeDecision({
    status: 'answered',
    answer: { kind: 'option', index: 1, note: 'scale' },
    answeredAt: '2026-10-30T10:15:00.000Z',
    answeredBy: 'user',
    answeredVia
  })
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[decision]} />)
  const item = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('listitem').at(-1)!
  expect(item.textContent).toContain(`Decision: Which database? → Postgres (you, from ${from})`)
  expect(item.textContent).toContain('scale')
})

test('the activity entry for a question settled by a message says so, with the message as its detail', () => {
  const decision = makeDecision({
    status: 'answered',
    answer: { kind: 'message', text: 'Merged #39, carry on' },
    answeredAt: '2026-10-30T10:15:00.000Z',
    answeredBy: 'user',
    answeredVia: 'message'
  })
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[decision]} />)
  const item = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('listitem').at(-1)!
  expect(item.textContent).toContain('Decision: Which database? → answered in a message (you)')
  expect(item.textContent).toContain('Merged #39, carry on')
})

test('the activity entry for an answered permission names the choice and where it came from', () => {
  const decision = makeDecision({
    kind: 'permission',
    question: 'Run pnpm install',
    options: [],
    status: 'answered',
    answer: { kind: 'permission', choice: 'deny' },
    answeredAt: '2026-10-30T10:15:00.000Z',
    answeredBy: 'user',
    answeredVia: 'board'
  })
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[decision]} />)
  const item = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('listitem').at(-1)!
  expect(item.textContent).toContain('Decision: Run pnpm install → Denied (you, from the board)')
})

test('the Activity records a redirect with who suggested and who confirmed it', () => {
  const events = [
    makeEvent({ kind: 'redirected', role: 'Implementer', text: 'Timeouts are ruled out; check the shared fixtures instead.' }, { at: '2026-10-30T10:05:00.000Z' })
  ]
  renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={[]} />)
  const activity = screen.getByRole('region', { name: 'Activity' })
  expect(
    within(activity).getByText('Redirected Implementer: Timeouts are ruled out; check the shared fixtures instead. (suggested by the orchestrator, confirmed by you)')
  ).toBeInTheDocument()
})

describe('the Activity of a stuck agent', () => {
  const at = (minute: number) => ({ at: `2026-10-30T10:0${minute}:00.000Z`, runId: 'r1' })
  const stuck = (change: 'opened' | 'escalated' | 'fired_again', over = {}) =>
    makeEvent({ kind: 'stuck', role: 'Implementer', change, episodeId: 'e1', rule: 'repeated_failure', evidence: ['x'], count: 5, ...over }, at(1))
  const activity = () => screen.getByRole('region', { name: 'Activity' })

  test('says when an episode opened, escalated and fired again after the redirect, as detected by Mainbus', () => {
    const events = [stuck('opened'), stuck('escalated', { rule: 'no_progress', count: undefined }), stuck('fired_again')]
    renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={[]} />)
    expect(within(activity()).getByText('Implementer looks stuck: same failing command 5 times (detected by Mainbus)')).toBeInTheDocument()
    expect(
      within(activity()).getByText('Implementer still looks stuck: no progress for a while, needs a closer look (detected by Mainbus)')
    ).toBeInTheDocument()
    expect(
      within(activity()).getByText('Implementer still looks stuck after the redirect: same failing command 5 times (detected by Mainbus)')
    ).toBeInTheDocument()
  })

  test('a replacement says who suggested it and that you confirmed it, with links to the run and the proposal', async () => {
    const onViewRun = vi.fn()
    useMainbus.setState({ revealedProposal: null })
    const events = [
      makeEvent({ kind: 'replaced', role: 'Implementer', summary: 'It tried X; Y failed.', source: 'summary', suggestedBy: 'orchestrator', proposalId: 'p9' }, at(5))
    ]
    renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={[]} onViewRun={onViewRun} />)
    expect(within(activity()).getByText('Implementer replaced')).toBeInTheDocument()
    expect(within(activity()).getByText('Suggested by orchestrator, confirmed by you')).toBeInTheDocument()
    await userEvent.click(within(activity()).getByRole('button', { name: 'View previous run' }))
    expect(onViewRun).toHaveBeenCalledWith('r1')
    await userEvent.click(within(activity()).getByRole('button', { name: 'View proposal' }))
    expect(useMainbus.getState().revealedProposal).toMatchObject({ id: 'p9' })
  })

  test('a replacement from the Replace… button says you suggested it; an old one only that you confirmed it', () => {
    const events = [
      makeEvent({ kind: 'replaced', role: 'Planner', summary: 's', source: 'summary', suggestedBy: 'user' }, at(2)),
      makeEvent({ kind: 'replaced', role: 'Reviewer', summary: 's', source: 'summary' }, at(3))
    ]
    renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={[]} />)
    expect(within(activity()).getByText('Planner replaced')).toBeInTheDocument()
    expect(within(activity()).getByText('Suggested by you with Replace…, confirmed by you')).toBeInTheDocument()
    expect(within(activity()).getByText('Reviewer replaced')).toBeInTheDocument()
    expect(within(activity()).getByText('Confirmed by you')).toBeInTheDocument()

  })

  test('a redirect links to its proposal; the Failed outcome is recorded, with a link to the run', async () => {
    const onViewRun = vi.fn()
    useMainbus.setState({ revealedProposal: null })
    const events = [
      makeEvent({ kind: 'redirected', role: 'Implementer', text: 'Try again.', proposalId: 'p3' }, at(2)),
      makeEvent({ kind: 'stuck_failed', role: 'Implementer', replacements: 2 }, at(4))
    ]
    renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={[]} onViewRun={onViewRun} />)
    expect(within(activity()).getByText('Redirected Implementer: Try again. (suggested by the orchestrator, confirmed by you)')).toBeInTheDocument()
    expect(within(activity()).getByText('Implementer marked Failed: stuck again after being replaced 2 times (by Mainbus)')).toBeInTheDocument()
    await userEvent.click(within(activity()).getByRole('button', { name: 'View proposal' }))
    expect(useMainbus.getState().revealedProposal).toMatchObject({ id: 'p3' })
    await userEvent.click(within(activity()).getByRole('button', { name: 'View run' }))
    expect(onViewRun).toHaveBeenCalledWith('r1')
  })
})

test('the context pane has no axe violations', async () => {
  const ticket = makeTicket({ title: 'Add dark mode', spec: 'The spec.', criteria: [{ position: 1, text: 'It works', checked: false }], labels: ['ui'], branch: 'mainbus/1-x' })
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  await expectNoAxeViolations()
})

test("the timeline says the lineup started once per ticket run, and a replacement's successor started from the plan", () => {
  const events = [
    makeEvent({ kind: 'message', text: 'plan' }, { runId: 'a', at: '2026-10-30T10:00:00.000Z' }),
    makeEvent({ kind: 'handoff', summary: 'Plan done', outcome: 'done', to: 'Implementer' }, { runId: 'a', at: '2026-10-30T10:05:00.000Z' }),
    makeEvent({ kind: 'message', text: 'build' }, { runId: 'b', at: '2026-10-30T10:06:00.000Z' }),
    makeEvent({ kind: 'replaced', role: 'Implementer', summary: 's', source: 'summary' }, { runId: 'b', at: '2026-10-30T10:30:00.000Z' }),
    makeEvent({ kind: 'message', text: 'again' }, { runId: 'c', at: '2026-10-30T10:31:00.000Z' })
  ]
  const runs = {
    a: { id: 'a', ticketRunId: 't1', role: 'Planner' },
    b: { id: 'b', ticketRunId: 't1', role: 'Implementer' },
    c: { id: 'c', ticketRunId: 't1', role: 'Implementer' }
  }
  renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={[]} runs={runs} />)
  const activity = screen.getByRole('region', { name: 'Activity' })
  expect(within(activity).getAllByText('Started with the workspace lineup')).toHaveLength(1)
  expect(within(activity).getByText('Planner handed off to the Implementer')).toBeInTheDocument()
  expect(within(activity).getByText('New Implementer started from the plan')).toBeInTheDocument()
})

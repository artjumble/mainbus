import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { makeDecision, makeEvent, makeTicket, renderWithMantine } from '../test-utils'
import { ContextPane } from './ContextPane'

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
  renderWithMantine(<ContextPane ticket={ticket} events={events} decisions={decisions} />)
  const activity = screen.getByRole('region', { name: 'Activity' })
  const items = within(activity)
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '')
  expect(items).toHaveLength(5)
  expect(items[0]).toMatch(/Run started/)
  expect(items[1]).toMatch(/Decision: Which database\? → SQLite \(you, from the board\)/)
  expect(items[2]).toMatch(/Handed off.*All done/)
  expect(items[3]).toMatch(/Run started/)
  expect(items[4]).toMatch(/Stopped/)
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

test('without activity the timeline says so', () => {
  renderWithMantine(<ContextPane ticket={ticket} events={[]} decisions={[]} />)
  expect(screen.getByText('Nothing has happened yet.')).toBeInTheDocument()
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
  const item = within(screen.getByRole('region', { name: 'Activity' })).getByRole('listitem')
  expect(item.textContent).toContain(`Decision: Which database? → Postgres (you, from ${from})`)
  expect(item.textContent).toContain('scale')
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
  const item = within(screen.getByRole('region', { name: 'Activity' })).getByRole('listitem')
  expect(item.textContent).toContain('Decision: Run pnpm install → Denied (you, from the board)')
})

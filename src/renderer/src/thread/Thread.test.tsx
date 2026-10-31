import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { StoredEvent, ThreadEvent } from '../../../shared/events'
import { makeDecision, makeEvent, renderWithMantine } from '../test-utils'
import { mergeEvent } from './merge'
import { Thread } from './Thread'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))

const ev = (event: ThreadEvent): StoredEvent => makeEvent(event)

test('Thread renders each event kind', () => {
  const events = [
    ev({ kind: 'user_message', text: 'Please add dark mode' }),
    ev({ kind: 'message', text: 'On it.' }),
    ev({ kind: 'thinking', text: null, durationMs: 4200 }),
    ev({ kind: 'thinking', text: 'Considering CSS variables' }),
    ev({ kind: 'tool_call', id: 'c1', name: 'Edit', input: { file_path: 'theme.ts' } }),
    ev({ kind: 'tool_result', id: 'c1', ok: true, summary: 'Edited theme.ts' }),
    ev({ kind: 'nudge', text: 'You ended your turn without asking' }),
    ev({ kind: 'handoff', summary: 'Dark mode is done', outcome: 'done' }),
    ev({ kind: 'stopped' }),
    ev({ kind: 'decision', decisionId: 'dq' }),
    ev({ kind: 'decision', decisionId: 'dp' }),
    ev({ kind: 'error', message: 'Something broke' })
  ]
  const decisions = [
    makeDecision({ id: 'dq', question: 'Which palette?' }),
    makeDecision({ id: 'dp', kind: 'permission', question: 'Run pnpm install?', options: [] })
  ]
  renderWithMantine(<Thread events={events} decisions={decisions} />)

  // The role tag sits on the agent's message.
  const message = screen.getByText('On it.').closest('[data-event="message"]') as HTMLElement
  expect(within(message).getByText('IMPLEMENTER')).toBeInTheDocument()

  // The person's message is right-aligned.
  const user = screen.getByText('Please add dark mode').closest('[data-event="user_message"]')
  expect(user).toHaveStyle({ alignSelf: 'flex-end' })

  // A tool call and its result are one row, collapsed.
  expect(screen.getAllByRole('button', { name: /Edit/ })).toHaveLength(1)
  expect(screen.getByRole('button', { name: /Edit/ })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Edited theme.ts')).toBeInTheDocument()

  expect(screen.getByText('Thought for 4s')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Thinking/ })).toBeInTheDocument()

  expect(screen.getByText('You ended your turn without asking').closest('[data-event="divider"]')).not.toBeNull()
  expect(screen.getByText('Dark mode is done').closest('[data-event="divider"]')).not.toBeNull()
  expect(screen.getByText('Stopped').closest('[data-event="divider"]')).not.toBeNull()

  expect(screen.getByText('Which palette?')).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'SQLite' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
  expect(screen.getByText('Something broke')).toBeInTheDocument()
})

test('a thread with several runs shows them in order, with a New run divider where each later run starts', () => {
  const history = [
    makeEvent({ kind: 'message', text: 'First attempt' }, { runId: 'r1', seq: 1 }),
    makeEvent({ kind: 'handoff', summary: 'Done once', outcome: 'done' }, { runId: 'r1', seq: 2 }),
    makeEvent({ kind: 'message', text: 'Second attempt' }, { runId: 'r2', seq: 1 }),
    makeEvent({ kind: 'stopped' }, { runId: 'r2', seq: 2 }),
    makeEvent({ kind: 'message', text: 'Third attempt' }, { runId: 'r3', seq: 1 })
  ]
  // The live feed repeats a stored event: the merge keeps one copy per (runId, seq).
  const merged = [...history, makeEvent({ kind: 'message', text: 'Second attempt' }, { runId: 'r2', seq: 1 })].reduce<
    StoredEvent[]
  >(mergeEvent, [])
  const { container } = renderWithMantine(<Thread events={merged} decisions={[]} />)

  const rows = [...container.querySelectorAll('[data-event]')].map((el) => el.textContent)
  expect(rows).toEqual([
    'IMPLEMENTERFirst attempt',
    'Done once',
    'New run',
    'IMPLEMENTERSecond attempt',
    'Stopped',
    'New run',
    'IMPLEMENTERThird attempt'
  ])
})

test('a partial thinking event is a live indicator', () => {
  renderWithMantine(<Thread events={[makeEvent({ kind: 'thinking', text: null, partial: true }, { seq: 0 })]} decisions={[]} />)
  expect(screen.getByText('Thinking…')).toBeInTheDocument()
})

test('events the person does not need are not rendered', () => {
  const events = [
    ev({ kind: 'session', sessionId: 's1' }),
    ev({ kind: 'vcs_changed' }),
    ev({ kind: 'rate_limit', status: 'allowed', windows: {} }),
    ev({ kind: 'turn_end', ok: true })
  ]
  const { container } = renderWithMantine(<Thread events={events} decisions={[]} />)
  expect(container.querySelector('[data-event]')).toBeNull()
})

test('partial messages are replaced by the final message, not duplicated', () => {
  const partial = (text: string): StoredEvent => makeEvent({ kind: 'message', text, partial: true }, { seq: 0 })
  const stream = [partial('Hel'), partial('Hello'), ev({ kind: 'message', text: 'Hello world' })]
  renderWithMantine(<Thread events={stream.reduce<StoredEvent[]>(mergeEvent, [])} decisions={[]} />)
  expect(screen.getAllByText(/Hello/)).toHaveLength(1)
  expect(screen.getByText('Hello world')).toBeInTheDocument()
})

test('agent text is markdown without raw HTML, and links open outside the app', () => {
  const text = 'Read **this** <script>window.hacked = 1</script> <img src="x" onerror="1"> [docs](https://example.com/a) ![pic](https://evil.example/p.png)'
  const { container } = renderWithMantine(<Thread events={[ev({ kind: 'message', text })]} decisions={[]} />)
  expect(screen.getByText('this').tagName).toBe('STRONG')
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('img')).toBeNull()
  const link = screen.getByRole('link', { name: 'docs' })
  expect(link).toHaveAttribute('href', 'https://example.com/a')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')
})

test('a javascript: link is not made clickable', () => {
  const { container } = renderWithMantine(
    <Thread events={[ev({ kind: 'message', text: '[x](javascript:alert(1))' })]} decisions={[]} />
  )
  const link = container.querySelector('a')
  expect(link?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
})

test('a tool call without its result yet shows as running, and its result later joins the same row', async () => {
  const call = ev({ kind: 'tool_call', id: 'c9', name: 'Bash', input: { command: 'ls' } })
  const { rerender } = renderWithMantine(<Thread events={[call]} decisions={[]} />)
  expect(screen.getByText('Running…')).toBeInTheDocument()
  rerender(<Thread events={[call, ev({ kind: 'tool_result', id: 'c9', ok: true, summary: 'listed' })]} decisions={[]} />)
  expect(screen.getAllByRole('button', { name: /Bash/ })).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: /Bash/ }))
  expect(screen.getByText('listed')).toBeVisible()
})

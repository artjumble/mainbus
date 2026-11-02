import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import type { StoredEvent, ThreadEvent, ThreadRun } from '../../../shared/events'
import { makeDecision, makeEvent, renderWithMantine } from '../test-utils'
import { mergeEvent } from './merge'
import { Thread as ThreadView } from './Thread'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))

const ev = (event: ThreadEvent): StoredEvent => makeEvent(event)

/** Run r1 is the Implementer's, unless a test gives the runs. */
const IMPLEMENTER_RUN: Record<string, ThreadRun> = { r1: { id: 'r1', ticketRunId: 'tr1', role: 'Implementer' } }
function Thread({ runs = IMPLEMENTER_RUN, ...props }: Omit<ComponentProps<typeof ThreadView>, 'runs'> & { runs?: Record<string, ThreadRun> }) {
  return <ThreadView runs={runs} {...props} />
}

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
  // The last role's handoff names no next role; its summary is collapsed under it.
  expect(screen.getByText('Implementer handed off').closest('[data-event="handoff"]')).not.toBeNull()
  expect(screen.queryByText('Dark mode is done')).not.toBeInTheDocument()
  expect(screen.getByText('Stopped').closest('[data-event="divider"]')).not.toBeNull()

  expect(screen.getByText('Which palette?')).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'SQLite' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
  expect(screen.getByText('Something broke')).toBeInTheDocument()
})

test('a thread with several ticket runs shows them in order, with a New run divider where each later one starts', () => {
  const runs: Record<string, ThreadRun> = {
    r1: { id: 'r1', ticketRunId: 'tr1', role: 'Implementer' },
    r2: { id: 'r2', ticketRunId: 'tr2', role: 'Implementer' },
    r3: { id: 'r3', ticketRunId: 'tr3', role: 'Implementer' }
  }
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
  const { container } = renderWithMantine(<Thread events={merged} decisions={[]} runs={runs} />)

  const rows = [...container.querySelectorAll('[data-event]')].map((el) => el.textContent)
  expect(rows).toEqual([
    'IMPLEMENTERFirst attempt',
    'Implementer handed off',
    'New run',
    'IMPLEMENTERSecond attempt',
    'Stopped',
    'New run',
    'IMPLEMENTERThird attempt'
  ])
})

test('each role tags its messages and tool groups, and a handoff divider names both roles with the summary collapsed', async () => {
  const runs: Record<string, ThreadRun> = {
    p: { id: 'p', ticketRunId: 'tr1', role: 'Planner' },
    i: { id: 'i', ticketRunId: 'tr1', role: 'Implementer' }
  }
  const events = [
    makeEvent({ kind: 'message', text: 'Reading the ticket.' }, { runId: 'p', seq: 1 }),
    makeEvent({ kind: 'tool_call', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }, { runId: 'p', seq: 2 }),
    makeEvent({ kind: 'tool_result', id: 'c1', ok: true, summary: 'read' }, { runId: 'p', seq: 3 }),
    makeEvent({ kind: 'tool_call', id: 'c2', name: 'Grep', input: { pattern: 'x' } }, { runId: 'p', seq: 4 }),
    makeEvent({ kind: 'handoff', summary: 'The **plan**: add a.ts', outcome: 'done', to: 'Implementer' }, { runId: 'p', seq: 5 }),
    makeEvent({ kind: 'role_handoff', from: 'Planner', to: 'Implementer' }, { runId: 'i', seq: 1 }),
    makeEvent({ kind: 'tool_call', id: 'c3', name: 'Edit', input: { file_path: 'a.ts' } }, { runId: 'i', seq: 2 }),
    // The Planner's last turn ends after the Implementer has begun: no divider for it.
    makeEvent({ kind: 'turn_end', ok: true }, { runId: 'p', seq: 6 }),
    makeEvent({ kind: 'message', text: 'Added it.' }, { runId: 'i', seq: 3 })
  ]
  const { container } = renderWithMantine(<Thread events={events} decisions={[]} runs={runs} />)

  const tags = [...container.querySelectorAll('[data-role-tag]')].map((el) => el.textContent)
  // One tag per message and per group of tool rows (Read and Grep are one group).
  expect(tags).toEqual(['PLANNER', 'PLANNER', 'IMPLEMENTER', 'IMPLEMENTER'])
  expect(screen.queryByText('New run')).not.toBeInTheDocument()

  const divider = screen.getByText('Planner → Implementer')
  expect(divider.closest('[data-event="handoff"]')).not.toBeNull()
  expect(screen.queryByText('plan')).not.toBeInTheDocument()
  const toggle = screen.getByRole('button', { name: 'Show summary' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'Hide summary' })).toHaveAttribute('aria-expanded', 'true')
  // Agent text: markdown, sanitized.
  expect(screen.getByText('plan').tagName).toBe('STRONG')
})

test('a hand-back is a divider naming both roles with its details collapsed, and a checked criterion a dimmed line', async () => {
  const runs: Record<string, ThreadRun> = {
    r: { id: 'r', ticketRunId: 'tr1', role: 'Reviewer' },
    i: { id: 'i', ticketRunId: 'tr1', role: 'Implementer' }
  }
  const events = [
    makeEvent({ kind: 'criterion_checked', index: 0, text: 'Six attempts are refused' }, { runId: 'r', seq: 1 }),
    makeEvent(
      {
        kind: 'hand_back',
        from: 'Reviewer',
        to: 'Implementer',
        fromRoleId: 'role-r',
        toRoleId: 'role-i',
        details: 'The **limiter** is never applied'
      },
      { runId: 'r', seq: 2 }
    ),
    makeEvent({ kind: 'role_hand_back', from: 'Reviewer', to: 'Implementer' }, { runId: 'i', seq: 1 })
  ]
  const { container } = renderWithMantine(<Thread events={events} decisions={[]} runs={runs} />)

  expect(screen.getByText('Reviewer checked: Six attempts are refused').closest('[data-event="criterion_checked"]')).not.toBeNull()
  const divider = screen.getByText('Reviewer handed back to Implementer')
  expect(divider.closest('[data-event="hand_back"]')).not.toBeNull()
  // The role hand-back after it shows nothing of its own.
  expect(container.querySelectorAll('[data-event="hand_back"]')).toHaveLength(1)
  expect(screen.queryByText('limiter')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('limiter').tagName).toBe('STRONG')
})

test('a handoff recorded without the next role takes it from the role handoff after it', () => {
  const runs: Record<string, ThreadRun> = {
    p: { id: 'p', ticketRunId: 'tr1', role: 'Planner' },
    i: { id: 'i', ticketRunId: 'tr1', role: 'Implementer' }
  }
  const events = [
    makeEvent({ kind: 'handoff', summary: 'Planned', outcome: 'done' }, { runId: 'p', seq: 1 }),
    makeEvent({ kind: 'role_handoff', from: 'Planner', to: 'Implementer' }, { runId: 'i', seq: 1 })
  ]
  renderWithMantine(<Thread events={events} decisions={[]} runs={runs} />)
  expect(screen.getByText('Planner → Implementer')).toBeInTheDocument()
})

test("a skipped role's handoff divider says Mainbus generated the summary, and a pause and resume are dividers", async () => {
  const runs: Record<string, ThreadRun> = {
    p: { id: 'p', ticketRunId: 'tr1', role: 'Planner' },
    i: { id: 'i', ticketRunId: 'tr1', role: 'Implementer' }
  }
  const events = [
    makeEvent({ kind: 'paused' }, { runId: 'p', seq: 1 }),
    makeEvent({ kind: 'resumed' }, { runId: 'p', seq: 2 }),
    makeEvent(
      { kind: 'handoff', summary: 'What the Planner did', outcome: 'done', to: 'Implementer', skipped: { by: 'user', source: 'summary' } },
      { runId: 'p', seq: 3 }
    ),
    makeEvent({ kind: 'role_handoff', from: 'Planner', to: 'Implementer' }, { runId: 'i', seq: 1 })
  ]
  renderWithMantine(<Thread events={events} decisions={[]} runs={runs} />)

  expect(screen.getByText('Paused Planner')).toBeInTheDocument()
  expect(screen.getByText('Resumed Planner')).toBeInTheDocument()
  const divider = screen.getByText('Planner skipped → Implementer · summary generated by Mainbus')
  expect(divider.closest('[data-event="handoff"]')).not.toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Show summary' }))
  expect(screen.getByText('What the Planner did')).toBeInTheDocument()
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

test('a notice from Mainbus is shown in the thread', () => {
  const text = 'Allowed by unattended mode: Implementer wants to run `npm install zod`'
  const { container } = renderWithMantine(<Thread events={[ev({ kind: 'notice', text })]} decisions={[]} />)
  expect(container.querySelector('[data-event="notice"]')).toHaveTextContent(text)
})

test('a push says whether it opened the PR, and links to it', () => {
  const pr = { branch: 'mainbus/5-x', number: 5, url: 'https://github.com/o/r/pull/5' }
  const { container } = renderWithMantine(
    <Thread
      events={[ev({ kind: 'pull_request', ...pr, opened: true }), ev({ kind: 'pull_request', ...pr, opened: false })]}
      decisions={[]}
    />
  )
  const rows = container.querySelectorAll('[data-event="pull_request"]')
  expect(rows[0]).toHaveTextContent('Pushed mainbus/5-x and opened PR #5')
  expect(rows[1]).toHaveTextContent('Pushed mainbus/5-x to PR #5')
  for (const link of screen.getAllByRole('link', { name: 'PR #5' })) {
    expect(link).toHaveAttribute('href', pr.url)
    expect(link).toHaveAttribute('target', '_blank')
  }
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

/** A group of reads and a board tool, then a message, then another read: two groups. */
function toolEvents(): StoredEvent[] {
  return [
    ev({ kind: 'tool_call', id: 'a', name: 'Read', input: { file_path: 'a.ts' } }),
    ev({ kind: 'tool_result', id: 'a', ok: true, summary: 'Read a.ts' }),
    ev({ kind: 'usage', inputTokens: 1, outputTokens: 1 }),
    ev({ kind: 'tool_call', id: 'b', name: 'Read', input: { file_path: 'b.ts' } }),
    ev({ kind: 'tool_call', id: 'c', name: 'Read', input: { file_path: 'c.ts' } }),
    ev({ kind: 'tool_call', id: 'd', name: 'mcp__mainbus__list_tickets', input: {} }),
    ev({ kind: 'message', text: 'Here is the board.' }),
    ev({ kind: 'tool_call', id: 'e', name: 'Read', input: { file_path: 'e.ts' } })
  ]
}

test('with summariseTools, each group of tool rows is one collapsed line that expands to the rows', async () => {
  const { container } = renderWithMantine(<Thread events={toolEvents()} decisions={[]} summariseTools />)
  const groups = container.querySelectorAll('[data-event="tool_group"]')
  expect(groups).toHaveLength(2)
  expect(groups[0]).toHaveTextContent('Read 3 files, looked at the board')
  expect(groups[1]).toHaveTextContent('Read 1 file')
  expect(container.querySelector('[data-event="tool"]')).toBeNull()

  const summary = screen.getByRole('button', { name: /Read 3 files/ })
  expect(summary).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(summary)
  expect(summary).toHaveAttribute('aria-expanded', 'true')
  expect(await screen.findByText('Read a.ts')).toBeVisible()
  expect(groups[0]!.querySelectorAll('[data-event="tool"]')).toHaveLength(4)
  expect(screen.getByText('mcp__mainbus__list_tickets')).toBeInTheDocument()
})

test('without summariseTools, tool rows show one by one', () => {
  const { container } = renderWithMantine(<Thread events={toolEvents()} decisions={[]} />)
  expect(container.querySelector('[data-event="tool_group"]')).toBeNull()
  expect(container.querySelectorAll('[data-event="tool"]')).toHaveLength(5)
})

test('a declared wait reads "<role> is waiting: <reason>, until <time>"', () => {
  const until = new Date(2026, 10, 2, 14, 30).toISOString()
  const { container } = renderWithMantine(<Thread events={[ev({ kind: 'waiting', reason: 'the full test suite', until })]} decisions={[]} />)
  expect(container.querySelector('[data-event="waiting"]')).toHaveTextContent('Implementer is waiting: the full test suite, until 14:30')
})

test('a redirect is a Mainbus entry naming the role, not the user own message', () => {
  const events = [ev({ kind: 'redirected', role: 'Implementer', text: 'Timeouts are ruled out; check the shared fixtures instead.' })]
  renderWithMantine(<Thread events={events} decisions={[]} />)
  const entry = screen.getByText('Timeouts are ruled out; check the shared fixtures instead.').closest('[data-event="redirected"]') as HTMLElement
  expect(entry).not.toBeNull()
  expect(within(entry).getByText('Mainbus · Redirected Implementer')).toBeInTheDocument()
  expect(document.querySelector('[data-event="user_message"]')).toBeNull()
})


describe('a replacement', () => {
  const replaced = (over: Partial<Extract<ThreadEvent, { kind: 'replaced' }>> = {}) =>
    ev({ kind: 'replaced', role: 'Implementer', summary: 'It tried X; Y failed.', source: 'summary', ...over })

  test('is a divider where the new run starts, with the handoff block collapsed under it', async () => {
    const { container } = renderWithMantine(<Thread events={[replaced()]} decisions={[]} />)
    expect(container.querySelector('[data-event="replaced"]')).toHaveTextContent('Implementer replaced')
    const toggle = screen.getByRole('button', { name: /Handoff from the previous run/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('It tried X; Y failed.')).not.toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('It tried X; Y failed.')).toBeInTheDocument()
    expect(screen.queryByText('Summary from the log digest')).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(screen.queryByText('It tried X; Y failed.')).not.toBeInTheDocument()
  })

  test('says so when the summary came from the log digest', async () => {
    renderWithMantine(<Thread events={[replaced({ source: 'digest' })]} decisions={[]} />)
    await userEvent.click(screen.getByRole('button', { name: /Handoff from the previous run/ }))
    expect(screen.getByText('Summary from the log digest')).toBeInTheDocument()
  })

  test('View previous run opens the replaced run, and is absent without a handler or in a read-only thread', async () => {
    const onViewRun = vi.fn()
    const first = renderWithMantine(<Thread events={[replaced()]} decisions={[]} onViewRun={onViewRun} />)
    await userEvent.click(screen.getByRole('button', { name: 'View previous run' }))
    expect(onViewRun).toHaveBeenCalledWith('r1')
    first.unmount()

    const none = renderWithMantine(<Thread events={[replaced()]} decisions={[]} />)
    expect(screen.queryByRole('button', { name: 'View previous run' })).not.toBeInTheDocument()
    none.unmount()

    renderWithMantine(<Thread events={[replaced()]} decisions={[]} onViewRun={onViewRun} readOnly />)
    expect(screen.queryByRole('button', { name: 'View previous run' })).not.toBeInTheDocument()
  })
})

test('stuck episodes and the Failed outcome are for the Activity list, not the thread', () => {
  const events = [
    ev({ kind: 'stuck', role: 'Implementer', change: 'opened', episodeId: 'e1', rule: 'repeated_failure', evidence: ['x'], count: 5 }),
    ev({ kind: 'stuck_failed', role: 'Implementer', replacements: 2 })
  ]
  const { container } = renderWithMantine(<Thread events={events} decisions={[]} />)
  expect(container.querySelector('[data-event]')).toBeNull()
})

test('a read-only thread tells a question still open instead of showing its card', () => {
  const events = [ev({ kind: 'decision', decisionId: 'dq' })]
  const decisions = [makeDecision({ id: 'dq', question: 'Which palette?', status: 'pending' })]
  renderWithMantine(<Thread events={events} decisions={decisions} readOnly />)
  expect(screen.getByText('Asked the user: Which palette?')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

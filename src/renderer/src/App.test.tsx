import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, onEngineEvent } from './api'
import { App } from './App'
import { useMainbus } from './store'
import { makeTicket, renderWithMantine, workspace } from './test-utils'

vi.mock('./api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(() => () => {}),
  openFolder: vi.fn(),
  isSetupRequired: () => false
}))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

function answer(setup: unknown, ws: unknown, tickets: unknown[] = []): void {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return setup
    if (command === 'workspace.get') return ws
    if (command === 'workspace.summaries') return ws ? [{ ...(ws as object), active: false, needsYou: 0 }] : []
    if (command === 'board.get') return { tickets }
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    if (command === 'unattended.get') return { on: false, status: { kind: 'off' } }
    if (command === 'usage.get') return { kind: 'ok' }
    if (command === 'orchestrator.get') return { status: 'idle', runs: [], events: [], proposals: [] }
    throw new Error(`unexpected ${command}`)
  })
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  vi.mocked(onEngineEvent).mockReturnValue(() => {})
})

test('a failed setup check shows the setup screen and no board', async () => {
  answer({ ok: false, reason: 'not_found', detail: '' }, null)
  renderWithMantine(<App />)
  expect(await screen.findByText(/Claude Code isn't installed/)).toBeInTheDocument()
  expect(screen.queryByText('Backlog')).not.toBeInTheDocument()
})

test('with Claude ready and no workspace, the app offers to open a repo folder', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, null)
  renderWithMantine(<App />)
  expect(await screen.findByRole('button', { name: 'Open a repo folder' })).toBeInTheDocument()
})

test('with a workspace, the app shows the board, and a card opens the ticket view', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, workspace, [makeTicket({ title: 'First ticket' })])
  renderWithMantine(<App />)
  await userEvent.click(await screen.findByRole('button', { name: /First ticket/ }))
  expect(await screen.findByText('Source: Local')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '← mainbus board' }))
  expect(screen.getByText('Backlog')).toBeInTheDocument()
})

test('the orchestrator panel is beside the board and the ticket view, and not on the setup screens', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, workspace, [makeTicket({ title: 'First ticket' })])
  renderWithMantine(<App />)
  const panel = await screen.findByRole('complementary', { name: 'Orchestrator' })
  await userEvent.type(within(panel).getByRole('textbox', { name: 'Message the orchestrator' }), 'draft')

  await userEvent.click(screen.getByRole('button', { name: /First ticket/ }))
  expect(await screen.findByText('Source: Local')).toBeInTheDocument()
  // The same panel, not a new one: what was typed is still there.
  expect(screen.getByRole('complementary', { name: 'Orchestrator' })).toBe(panel)
  expect(within(panel).getByRole('textbox', { name: 'Message the orchestrator' })).toHaveValue('draft')
})

test('the workspace rail is beside the board and the ticket view, and not on the setup screens', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, workspace, [makeTicket({ title: 'First ticket' })])
  const { unmount } = renderWithMantine(<App />)
  const rail = await screen.findByRole('navigation', { name: 'Workspaces' })
  expect(within(rail).getByRole('button', { name: /^mainbus/ })).toHaveAttribute('aria-current', 'true')
  await userEvent.click(screen.getByRole('button', { name: /First ticket/ }))
  expect(await screen.findByText('Source: Local')).toBeInTheDocument()
  expect(screen.getByRole('navigation', { name: 'Workspaces' })).toBe(rail)
  unmount()

  useMainbus.setState(initial, true)
  answer({ ok: false, reason: 'not_found', detail: '' }, null)
  renderWithMantine(<App />)
  await screen.findByText(/Claude Code isn't installed/)
  expect(screen.queryByRole('navigation', { name: 'Workspaces' })).not.toBeInTheDocument()
})

test('the setup screens have no orchestrator panel', async () => {
  answer({ ok: false, reason: 'not_found', detail: '' }, null)
  const { unmount } = renderWithMantine(<App />)
  await screen.findByText(/Claude Code isn't installed/)
  expect(screen.queryByRole('complementary', { name: 'Orchestrator' })).not.toBeInTheDocument()
  unmount()

  useMainbus.setState(initial, true)
  answer({ ok: true, path: 'claude', version: '2' }, null)
  renderWithMantine(<App />)
  await screen.findByRole('button', { name: 'Open a repo folder' })
  expect(screen.queryByRole('complementary', { name: 'Orchestrator' })).not.toBeInTheDocument()
})

test('a failing first load shows an error with Try again instead of an endless loader', async () => {
  mockInvoke.mockRejectedValueOnce(new Error("Error invoking remote method 'engine:invoke': Error: database is locked"))
  renderWithMantine(<App />)
  expect(await screen.findByText('database is locked')).toBeInTheDocument()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

  answer({ ok: true, path: 'claude', version: '2' }, workspace, [])
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Backlog')).toBeInTheDocument()
  expect(screen.queryByText('database is locked')).not.toBeInTheDocument()
})

test('revealing a proposal expands a collapsed orchestrator panel', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, workspace)
  renderWithMantine(<App />)
  const panel = await screen.findByRole('complementary', { name: 'Orchestrator' })
  await userEvent.click(within(panel).getByRole('button', { name: 'Collapse orchestrator panel' }))
  expect(within(panel).queryByRole('textbox', { name: 'Message the orchestrator' })).not.toBeInTheDocument()

  act(() => useMainbus.getState().revealProposal('p1'))
  expect(await within(panel).findByRole('textbox', { name: 'Message the orchestrator' })).toBeInTheDocument()
})

import { screen } from '@testing-library/react'
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
    if (command === 'board.get') return { tickets }
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    if (command === 'unattended.get') return { on: false, status: { kind: 'off' } }
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

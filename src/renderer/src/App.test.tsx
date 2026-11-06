import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, onEngineEvent } from './api'
import { App } from './App'
import { useMainbus } from './store'
import { expectNoAxeViolations, makeTicket, renderWithMantine, workspace } from './test-utils'

vi.mock('./api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(() => () => {}),
  onNavigate: vi.fn(() => () => {}),
  openFolder: vi.fn(),
  isSetupRequired: () => false
}))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

function answer(setup: unknown, ws: unknown, tickets: unknown[] = []): void {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return setup
    if (command === 'workspace.get') return ws
    if (command === 'workspace.summaries') return ws ? [{ ...(ws as object), active: false, needsYou: 0, working: 0, waiting: 0, idle: 0 }] : []
    if (command === 'board.get') return { tickets }
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    if (command === 'unattended.get') return { on: false, status: { kind: 'off' } }
    if (command === 'usage.get') return { kind: 'ok' }
    if (command === 'orchestrator.get') return { status: 'idle', runs: [], events: [], proposals: [], edits: [] }
    if (command === 'settings.get') return { maxAgents: 3, whenClosed: 'tray', theme: { choice: 'light', light: 'light', dark: 'dark' } }
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
  expect(await screen.findByRole('button', { name: 'Add workspace' })).toBeInTheDocument()
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
  await screen.findByRole('button', { name: 'Add workspace' })
  expect(screen.queryByRole('complementary', { name: 'Orchestrator' })).not.toBeInTheDocument()
})

test('a failing first load shows an error with Try again instead of an endless loader', async () => {
  mockInvoke.mockRejectedValueOnce(new Error("Error invoking remote method 'engine:invoke': Error: database is locked"))
  renderWithMantine(<App />)
  expect(await screen.findByText('database is locked')).toBeInTheDocument()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

  answer({ ok: true, path: 'claude', version: '2' }, workspace, [])
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText(/No tickets in .* yet/)).toBeInTheDocument()
  expect(screen.queryByText('database is locked')).not.toBeInTheDocument()
})

describe('Mainbus settings', () => {
  const ctrlComma = (target: Element, prevented = false): void => {
    const e = new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true })
    if (prevented) e.preventDefault()
    act(() => {
      target.dispatchEvent(e)
    })
  }

  test('the first launch has the rail with the Mainbus settings button, which opens the Theme', async () => {
    answer({ ok: true, path: 'claude', version: '2' }, null)
    renderWithMantine(<App />)
    await screen.findByText('Welcome to Mainbus')
    const rail = screen.getByRole('navigation', { name: 'Workspaces' })
    // One Add workspace: the welcome screen's.
    expect(screen.getAllByRole('button', { name: 'Add workspace' })).toHaveLength(1)
    await userEvent.click(within(rail).getByRole('button', { name: 'Mainbus settings' }))
    const drawer = await screen.findByRole('dialog', { name: 'Mainbus settings' })
    const appearance = within(drawer).getByRole('region', { name: 'Appearance' })
    await vi.waitFor(() => expect(within(appearance).getByRole('radio', { name: 'Light' })).toBeChecked())
  })

  test('Esc closes it and focus goes back to the rail button', async () => {
    answer({ ok: true, path: 'claude', version: '2' }, workspace)
    renderWithMantine(<App />)
    const button = within(await screen.findByRole('navigation', { name: 'Workspaces' })).getByRole('button', { name: 'Mainbus settings' })
    await userEvent.click(button)
    await screen.findByRole('dialog', { name: 'Mainbus settings' })
    await vi.waitFor(() => expect(button).not.toHaveFocus())
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mainbus settings' })).not.toBeInTheDocument())
    await vi.waitFor(() => expect(button).toHaveFocus())
  })

  test('Ctrl+, opens it from anywhere, a text field too, unless the field used the keys itself', async () => {
    answer({ ok: true, path: 'claude', version: '2' }, workspace)
    renderWithMantine(<App />)
    const box = await screen.findByRole('textbox', { name: 'Message the orchestrator' })

    ctrlComma(box, true)
    expect(useMainbus.getState().appSettingsOpen).toBe(false)

    box.focus()
    await userEvent.keyboard('{Control>},{/Control}')
    expect(await screen.findByRole('dialog', { name: 'Mainbus settings' })).toBeInTheDocument()
    expect(box).toHaveValue('')
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(useMainbus.getState().appSettingsOpen).toBe(false))
    await vi.waitFor(() => expect(box).toHaveFocus())

    ctrlComma(document.body)
    expect(await screen.findByRole('dialog', { name: 'Mainbus settings' })).toBeInTheDocument()
  })

  test('Ctrl+, opens it on the setup screens too', async () => {
    answer({ ok: false, reason: 'not_found', detail: '' }, null)
    renderWithMantine(<App />)
    await screen.findByText(/Claude Code isn't installed/)
    ctrlComma(document.body)
    expect(await screen.findByRole('dialog', { name: 'Mainbus settings' })).toBeInTheDocument()
  })
})

test('the first launch shows a welcome with Add workspace', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, null)
  renderWithMantine(<App />)
  expect(await screen.findByText('Welcome to Mainbus')).toBeInTheDocument()
})

test('asking the orchestrator to draft tickets expands a collapsed panel and fills its box', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, workspace)
  renderWithMantine(<App />)
  const panel = await screen.findByRole('complementary', { name: 'Orchestrator' })
  await userEvent.click(within(panel).getByRole('button', { name: 'Collapse orchestrator panel' }))

  await userEvent.click(await screen.findByRole('button', { name: 'Ask orchestrator to draft tickets' }))
  const box = await within(panel).findByRole('textbox', { name: 'Message the orchestrator' })
  expect(box).toHaveValue('Draft tickets for ')
  expect(box).toHaveFocus()
  expect(useMainbus.getState().orchestratorPrefill).toBeNull()
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

describe('panel width', () => {
  const originalWidth = window.innerWidth
  const setWindowWidth = (w: number): void => {
    act(() => {
      window.innerWidth = w
      window.dispatchEvent(new Event('resize'))
    })
  }
  beforeEach(() => {
    window.innerWidth = 1600
    localStorage.clear()
  })
  afterEach(() => {
    window.innerWidth = originalWidth
    vi.restoreAllMocks()
    localStorage.clear()
  })
  const handle = (): Promise<HTMLElement> => screen.findByRole('separator', { name: 'Resize orchestrator panel' })

  test('is restored on mount', async () => {
    localStorage.setItem('mainbus.orchestratorPanelWidth', '500')
    answer({ ok: true, path: 'claude', version: '2' }, workspace)
    renderWithMantine(<App />)
    expect(await handle()).toHaveAttribute('aria-valuenow', '500')
  })

  test('is clamped in a small window, not lost, and comes back', async () => {
    localStorage.setItem('mainbus.orchestratorPanelWidth', '600')
    answer({ ok: true, path: 'claude', version: '2' }, workspace)
    renderWithMantine(<App />)
    const sep = await handle()
    setWindowWidth(800)
    expect(sep).toHaveAttribute('aria-valuenow', '400')
    expect(sep).toHaveAttribute('aria-valuemax', '400')
    expect(localStorage.getItem('mainbus.orchestratorPanelWidth')).toBe('600')
    setWindowWidth(1600)
    expect(sep).toHaveAttribute('aria-valuenow', '600')
  })

  test('a keyboard change is saved, and collapsing keeps it', async () => {
    answer({ ok: true, path: 'claude', version: '2' }, workspace)
    renderWithMantine(<App />)
    const sep = await handle()
    sep.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(sep).toHaveAttribute('aria-valuenow', '356')
    expect(localStorage.getItem('mainbus.orchestratorPanelWidth')).toBe('356')

    const panel = screen.getByRole('complementary', { name: 'Orchestrator' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Collapse orchestrator panel' }))
    expect(screen.queryByRole('separator', { name: 'Resize orchestrator panel' })).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: /Open orchestrator/ }))
    expect(await handle()).toHaveAttribute('aria-valuenow', '356')
  })

  test('storage that throws falls back to 340', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    answer({ ok: true, path: 'claude', version: '2' }, workspace)
    renderWithMantine(<App />)
    expect(await handle()).toHaveAttribute('aria-valuenow', '340')
  })
})

test('the whole app, on the board and in a ticket, has no axe violations, with landmarks', async () => {
  answer({ ok: true, path: 'claude', version: '2' }, workspace, [makeTicket({ title: 'First ticket' })])
  renderWithMantine(<App />)
  await screen.findByRole('button', { name: /First ticket/ })
  await expectNoAxeViolations(document.body, { region: true })
  await userEvent.click(screen.getByRole('button', { name: /First ticket/ }))
  await screen.findByText('Source: Local')
  await expectNoAxeViolations(document.body, { region: true })
})

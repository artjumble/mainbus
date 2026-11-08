import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkspaceSummary } from '../../../shared/api'
import { invoke, openFolder } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { initials, railStatus, WorkspaceRail } from './WorkspaceRail'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(() => () => {}),
  openFolder: vi.fn(),
  isSetupRequired: () => false
}))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const mockOpenFolder = openFolder as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const alpha: WorkspaceSummary = { ...workspace, id: 'a', name: 'alpha-repo', repoPath: '/r/alpha', active: true, needsYou: 1, working: 0, waiting: 0, idle: 0 }
const bravo: WorkspaceSummary = { ...workspace, id: 'b', name: 'bravo', repoPath: '/r/bravo', active: false, needsYou: 0, working: 0, waiting: 0, idle: 0 }

/** The engine as the rail sees it: focus moves, and summaries are what `summaries` holds. */
/** Hover the rail until it has expanded (real timers: the hover delay is 150 ms). */
async function expand(): Promise<HTMLElement> {
  const nav = screen.getByRole('navigation', { name: 'Workspaces' })
  fireEvent.pointerEnter(nav)
  await vi.waitFor(() => expect(nav).toHaveAttribute('data-expanded', 'true'))
  return nav
}

function engine(opts: { failOpen?: string; failRemove?: string } = {}): void {
  const summaries = [alpha, bravo]
  let focused = alpha
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.summaries') return summaries
    if (command === 'workspace.focus') {
      focused = summaries.find((w) => w.id === args[0])!
      return focused
    }
    if (command === 'workspace.get') return focused
    if (command === 'board.get') return { tickets: [] }
    if (command === 'unattended.get') return { on: false, status: { kind: 'off' } }
    if (command === 'workspace.open') {
      if (opts.failOpen) throw new Error(opts.failOpen)
      return bravo
    }
    if (command === 'workspace.remove') {
      if (opts.failRemove) throw new Error(opts.failRemove)
      return { keptFolders: [] }
    }
    throw new Error(`unexpected ${command}`)
  })
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockOpenFolder.mockReset()
  useMainbus.setState({ workspace: alpha, workspaces: [alpha, bravo], currentTicketId: 't1' })
})

test('initials are the first letters of the name', () => {
  expect(initials('alpha-repo')).toBe('AR')
  expect(initials('mainbus')).toBe('MA')
})

test('each workspace has an entry with its activity dot and needs-you count', () => {
  engine()
  renderWithMantine(<WorkspaceRail />)
  const rail = screen.getByRole('navigation', { name: 'Workspaces' })
  const a = within(rail).getByRole('button', { name: /^alpha-repo/ })
  expect(a).toHaveAttribute('aria-current', 'true')
  expect(within(a).getByLabelText('agents working')).toBeInTheDocument()
  expect(within(a).getByLabelText('1 need you')).toHaveTextContent('1')
  const b = within(rail).getByRole('button', { name: /^bravo/ })
  expect(b).not.toHaveAttribute('aria-current')
  expect(within(b).queryByLabelText('agents working')).not.toBeInTheDocument()
  expect(within(b).queryByLabelText(/need you/)).not.toBeInTheDocument()
})

test('clicking an entry focuses that workspace and closes an open ticket', async () => {
  engine()
  renderWithMantine(<WorkspaceRail />)
  await userEvent.click(screen.getByRole('button', { name: /^bravo/ }))
  expect(mockInvoke).toHaveBeenCalledWith('workspace.focus', 'b')
  await vi.waitFor(() => expect(useMainbus.getState().workspace?.id).toBe('b'))
  expect(useMainbus.getState().currentTicketId).toBeNull()
})

test('+ Add workspace explains trust, then opens the chosen folder', async () => {
  engine()
  mockOpenFolder.mockResolvedValue('/r/bravo')
  renderWithMantine(<WorkspaceRail />)
  await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/treats the folder you pick as\s+trusted/)).toBeInTheDocument()
  expect(within(dialog).getByText(/own copies of the repo/)).toBeInTheDocument()

  await userEvent.click(within(dialog).getByRole('button', { name: 'Choose folder…' }))
  expect(mockInvoke).toHaveBeenCalledWith('workspace.open', '/r/bravo')
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

test('cancelling the folder picker does nothing', async () => {
  engine()
  mockOpenFolder.mockResolvedValue(null)
  renderWithMantine(<WorkspaceRail />)
  await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Choose folder…' }))
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.open', expect.anything())
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('an error from opening a folder is shown plainly in the dialog', async () => {
  engine({ failOpen: '/r/x is not a git repository' })
  mockOpenFolder.mockResolvedValue('/r/x')
  renderWithMantine(<WorkspaceRail />)
  await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Choose folder…' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('/r/x is not a git repository')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

async function chooseRemove(name: string): Promise<HTMLElement> {
  await expand()
  await userEvent.click(screen.getByRole('button', { name: `Options for ${name}` }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }))
  return screen.findByRole('dialog')
}

test('Remove… asks first, says the repo is never deleted, and then removes', async () => {
  engine()
  renderWithMantine(<WorkspaceRail />)
  const dialog = await chooseRemove('bravo')
  expect(dialog).toHaveTextContent('Remove bravo from Mainbus? The repo at /r/bravo is never deleted.')
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.remove', expect.anything())
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
  expect(mockInvoke).toHaveBeenCalledWith('workspace.remove', 'b')
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

test('the engine refusal to remove is shown and the dialog stays', async () => {
  engine({ failRemove: 'bravo has agents open. Stop them first.' })
  renderWithMantine(<WorkspaceRail />)
  const dialog = await chooseRemove('bravo')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('bravo has agents open. Stop them first.')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('Settings focuses the workspace first, then opens the drawer', async () => {
  engine()
  renderWithMantine(<WorkspaceRail />)
  await expand()
  await userEvent.click(screen.getByRole('button', { name: 'Options for bravo' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  await vi.waitFor(() => expect(useMainbus.getState().settingsOpen).toBe(true))
  expect(mockInvoke).toHaveBeenCalledWith('workspace.focus', 'b')
  expect(useMainbus.getState().workspace?.id).toBe('b')
})

test('the Mainbus settings button opens the Mainbus settings, collapsed and expanded, and is the same button', async () => {
  engine()
  renderWithMantine(<WorkspaceRail />)
  const nav = screen.getByRole('navigation', { name: 'Workspaces' })
  expect(nav).toHaveAttribute('data-expanded', 'false')
  const button = within(nav).getByRole('button', { name: 'Mainbus settings' })
  await userEvent.click(button)
  expect(useMainbus.getState().appSettingsOpen).toBe(true)
  // Not the workspace's settings, and no workspace focus moved.
  expect(useMainbus.getState().settingsOpen).toBe(false)
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.focus', expect.anything())

  useMainbus.getState().closeAppSettings()
  await expand()
  // The same element, so focus can come back to it whichever way the rail is.
  expect(within(nav).getByRole('button', { name: 'Mainbus settings' })).toBe(button)
  expect(button).toHaveTextContent('Mainbus settings')
  await userEvent.click(button)
  expect(useMainbus.getState().appSettingsOpen).toBe(true)
})

test('with no workspace yet, the rail has the Mainbus settings button and leaves Add workspace to the welcome screen', async () => {
  mockInvoke.mockImplementation(async () => [])
  useMainbus.setState({ workspace: null, workspaces: [], currentTicketId: null })
  renderWithMantine(<WorkspaceRail />)
  const nav = screen.getByRole('navigation', { name: 'Workspaces' })
  expect(within(nav).queryByRole('button', { name: 'Add workspace' })).not.toBeInTheDocument()
  await userEvent.click(within(nav).getByRole('button', { name: 'Mainbus settings' }))
  expect(useMainbus.getState().appSettingsOpen).toBe(true)
  await expectNoAxeViolations()
})

describe('accessibility', () => {
  test('the rail, its options menu and the Add and Remove dialogs have no axe violations', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    await expectNoAxeViolations()
    await expand()
    await expectNoAxeViolations()

    await userEvent.click(screen.getByRole('button', { name: 'Options for bravo' }))
    await screen.findByRole('menuitem', { name: 'Remove…' })
    await expectNoAxeViolations()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }))
    await screen.findByRole('dialog')
    await expectNoAxeViolations()
  })

  test('the Add workspace dialog has no axe violations', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
    await screen.findByRole('dialog')
    await expectNoAxeViolations()
  })
})

test('each entry has a status line: working, waiting on you or idle', () => {
  const w = (over: Partial<WorkspaceSummary>): WorkspaceSummary => ({ ...bravo, ...over })
  expect(railStatus(w({ working: 2, needsYou: 1 }))).toBe('• 2 working')
  expect(railStatus(w({ needsYou: 1 }))).toBe('◆ Waiting on you')
  expect(railStatus(w({ waiting: 1 }))).toBe('◆ Waiting on you')
  expect(railStatus(w({ idle: 1 }))).toBe('○ Idle')
})

describe('collapsed and expanded', () => {
  const navOf = (): HTMLElement => screen.getByRole('navigation', { name: 'Workspaces' })

  test('is collapsed by default: initials, dot and badge, no names, status or menus', () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    expect(navOf()).toHaveAttribute('data-expanded', 'false')
    const a = screen.getByRole('button', { name: /^alpha-repo/ })
    // The initials are drawn from an attribute, so they aren't text the label must contain.
    expect(a.querySelector('[data-initials]')).toHaveAttribute('data-initials', 'AR')
    expect(a).not.toHaveTextContent('alpha-repo')
    expect(within(a).getByLabelText('agents working')).toBeInTheDocument()
    expect(within(a).getByLabelText('1 need you')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Options for/ })).not.toBeInTheDocument()
    expect(navOf().querySelector('[data-rail-status]')).toBeNull()
  })

  test('hover expands it after a delay and leaving collapses it after a longer one', async () => {
    engine()
    vi.useFakeTimers()
    try {
      renderWithMantine(<WorkspaceRail />)
      fireEvent.pointerEnter(navOf())
      await act(() => vi.advanceTimersByTimeAsync(100))
      expect(navOf()).toHaveAttribute('data-expanded', 'false')
      await act(() => vi.advanceTimersByTimeAsync(60))
      expect(navOf()).toHaveAttribute('data-expanded', 'true')
      expect(screen.getByRole('button', { name: 'Options for alpha-repo' })).toBeInTheDocument()
      expect(navOf()).toHaveTextContent('+ Add workspace')
      expect(navOf().querySelectorAll('[data-rail-status]')).toHaveLength(2)

      fireEvent.pointerLeave(navOf())
      await act(() => vi.advanceTimersByTimeAsync(250))
      expect(navOf()).toHaveAttribute('data-expanded', 'true')
      await act(() => vi.advanceTimersByTimeAsync(60))
      expect(navOf()).toHaveAttribute('data-expanded', 'false')
    } finally {
      vi.useRealTimers()
    }
  })

  test('Tab into the rail expands it at once, and the next Tab reaches the options menu', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /^alpha-repo/ })).toHaveFocus()
    expect(navOf()).toHaveAttribute('data-expanded', 'true')
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Options for alpha-repo' })).toHaveFocus()
  })

  test('a mouse click leaves it to collapse once the pointer is gone', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    await expand()
    await userEvent.click(screen.getByRole('button', { name: /^bravo/ }))
    fireEvent.pointerLeave(navOf())
    await vi.waitFor(() => expect(navOf()).toHaveAttribute('data-expanded', 'false'))
  })

  test('stays open while its menu or the Remove dialog is open', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    await expand()
    await userEvent.click(screen.getByRole('button', { name: 'Options for bravo' }))
    await screen.findByRole('menuitem', { name: 'Remove…' })
    fireEvent.pointerLeave(navOf())
    await act(() => new Promise((r) => setTimeout(r, 450)))
    expect(navOf()).toHaveAttribute('data-expanded', 'true')

    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }))
    const dialog = await screen.findByRole('dialog')
    await act(() => new Promise((r) => setTimeout(r, 450)))
    expect(navOf()).toHaveAttribute('data-expanded', 'true')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    // The pointer left the rail again on its way to the dialog.
    fireEvent.pointerLeave(navOf())
    await vi.waitFor(() => expect(navOf()).toHaveAttribute('data-expanded', 'false'), { timeout: 2000 })
  })

  test('stays open while the Add workspace dialog is open', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    await expand()
    await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
    await screen.findByRole('dialog')
    fireEvent.pointerLeave(navOf())
    await act(() => new Promise((r) => setTimeout(r, 450)))
    expect(navOf()).toHaveAttribute('data-expanded', 'true')
  })

  test('shows the repo path in the options menu', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    await expand()
    await userEvent.click(screen.getByRole('button', { name: 'Options for bravo' }))
    expect(await screen.findByText('/r/bravo')).toBeInTheDocument()
  })

  test('accessible names are the same in both states', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
    expect(screen.getByRole('button', { name: /^alpha-repo 1 need you · agents working$/ })).toBeInTheDocument()
    await expand()
    expect(screen.getByRole('button', { name: /^alpha-repo 1 need you · agents working$/ })).toBeInTheDocument()
  })

  test('is laid out over the board and animates its width, unless motion is reduced', () => {
    engine()
    const { unmount } = renderWithMantine(<WorkspaceRail />)
    expect(navOf().style.position).toBe('absolute')
    expect(navOf().style.transition).toContain('width 150ms')
    unmount()
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null
    })) as unknown as typeof window.matchMedia
    try {
      renderWithMantine(<WorkspaceRail />)
      expect(navOf().style.transition).toBe('none')
    } finally {
      window.matchMedia = original
    }
  })
})

test('in the expanded rail, the needs-you count keeps its width and is never clipped beside a long name', async () => {
  engine()
  renderWithMantine(<WorkspaceRail />)
  const nav = await expand()
  const badge = nav.querySelector<HTMLElement>('[data-needs-you]')!
  expect(badge).toHaveTextContent('1')
  // jsdom has no layout, so these are the styles that keep the count whole.
  expect(getComputedStyle(badge).flexShrink).toBe('0')
  expect(getComputedStyle(badge).overflow).toBe('visible')
  const label = badge.querySelector<HTMLElement>('.mantine-Badge-label')!
  expect(getComputedStyle(label).overflow).toBe('visible')
})

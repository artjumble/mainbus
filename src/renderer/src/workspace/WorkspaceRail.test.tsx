import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkspaceSummary } from '../../../shared/api'
import { invoke, openFolder } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { initials, WorkspaceRail } from './WorkspaceRail'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(() => () => {}),
  openFolder: vi.fn(),
  isSetupRequired: () => false
}))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const mockOpenFolder = openFolder as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const alpha: WorkspaceSummary = { ...workspace, id: 'a', name: 'alpha-repo', repoPath: '/r/alpha', active: true, needsYou: 1 }
const bravo: WorkspaceSummary = { ...workspace, id: 'b', name: 'bravo', repoPath: '/r/bravo', active: false, needsYou: 0 }

/** The engine as the rail sees it: focus moves, and summaries are what `summaries` holds. */
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
  await userEvent.click(screen.getByRole('button', { name: 'Options for bravo' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  await vi.waitFor(() => expect(useMainbus.getState().settingsOpen).toBe(true))
  expect(mockInvoke).toHaveBeenCalledWith('workspace.focus', 'b')
  expect(useMainbus.getState().workspace?.id).toBe('b')
})

describe('accessibility', () => {
  test('the rail, its options menu and the Add and Remove dialogs have no axe violations', async () => {
    engine()
    renderWithMantine(<WorkspaceRail />)
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

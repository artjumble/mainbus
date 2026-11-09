import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, openFolder } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { OpenWorkspace } from './OpenWorkspace'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const mockOpenFolder = openFolder as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockOpenFolder.mockReset()
})

test('picking a folder opens it as the workspace', async () => {
  mockOpenFolder.mockResolvedValue('C:\\repos\\mainbus')
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'workspace.check') return { status: 'ready', folder: 'C:/repos/mainbus', root: 'C:/repos/mainbus' }
    return command === 'workspace.open' ? workspace : { tickets: [] }
  })
  renderWithMantine(<OpenWorkspace />)
  await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  await vi.waitFor(() => expect(useMainbus.getState().workspace).toEqual(workspace))
  expect(mockInvoke).toHaveBeenCalledWith('workspace.open', 'C:\\repos\\mainbus')
})

test('cancelling the picker opens nothing', async () => {
  mockOpenFolder.mockResolvedValue(null)
  renderWithMantine(<OpenWorkspace />)
  await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  expect(mockOpenFolder).toHaveBeenCalled()
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('a folder the engine rejects shows its message', async () => {
  mockOpenFolder.mockResolvedValue('C:\\not-a-repo')
  mockInvoke.mockRejectedValue(
    new Error("Error invoking remote method 'engine:invoke': Error: C:\\not-a-repo is not a git repository")
  )
  renderWithMantine(<OpenWorkspace />)
  await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  expect(await screen.findByText('C:\\not-a-repo is not a git repository')).toBeInTheDocument()
  expect(useMainbus.getState().workspace).toBeNull()
})

test('a folder without commits offers to set git up, and changes nothing until confirmed', async () => {
  mockOpenFolder.mockResolvedValue('C:\repos\new')
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'workspace.check') return { status: 'no_commits', folder: 'C:\repos\new', root: 'C:\repos\new' }
    if (command === 'workspace.previewSetup') return { root: 'C:\repos\new', files: 0, bytes: 0, entries: [], warnings: [] }
    throw new Error('unexpected ' + command)
  })
  renderWithMantine(<OpenWorkspace />)
  await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  expect(await screen.findByText('Set up git here')).toBeInTheDocument()
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.prepare', expect.anything(), expect.anything())
  expect(useMainbus.getState().workspace).toBeNull()
})

test('the screen has no axe violations', async () => {
  renderWithMantine(<OpenWorkspace />)
  await expectNoAxeViolations()
})

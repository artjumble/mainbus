import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, openFolder } from '../api'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { TicketFoldersSettings } from './TicketFoldersSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(() => () => {}), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const mockOpenFolder = openFolder as unknown as ReturnType<typeof vi.fn>
const NAME = 'Ticket folders location'

let stored: string | null
let outcome: { error?: string; warning?: string }

beforeEach(() => {
  mockInvoke.mockReset()
  mockOpenFolder.mockReset()
  stored = null
  outcome = {}
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return { ticketFoldersLocation: stored }
    if (command === 'settings.setTicketFoldersLocation') {
      if (outcome.error) throw new Error(outcome.error)
      stored = args[0] as string | null
      return { settings: { ticketFoldersLocation: stored }, warning: outcome.warning ?? null }
    }
    return undefined
  })
})

test('loads nothing while closed', () => {
  renderWithMantine(<TicketFoldersSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('shows the saved folder, or the data home placeholder when empty', async () => {
  stored = 'D:\\mb'
  const { unmount } = renderWithMantine(<TicketFoldersSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('textbox', { name: NAME })).toHaveValue('D:\\mb'))
  unmount()
  stored = null
  renderWithMantine(<TicketFoldersSettings opened />)
  const box = await screen.findByRole('textbox', { name: NAME })
  await vi.waitFor(() => expect(box).toBeEnabled())
  expect(box).toHaveValue('')
  expect(box).toHaveAttribute('placeholder', 'The data home (default)')
})

test('the help names the Dev Drive, the 260 limit, new tickets only, and pnpm\'s same-drive store', async () => {
  renderWithMantine(<TicketFoldersSettings opened />)
  const help = await screen.findByText(/Dev Drive/)
  expect(help).toHaveTextContent('new tickets only')
  expect(help).toHaveTextContent('260')
  expect(help).toHaveTextContent('pnpm store path')
  expect(help).toHaveTextContent('same drive')
})

test('Choose folder saves the picked folder and shows a warning under the field', async () => {
  outcome = { warning: 'A typical ticket folder here would be 120 characters long.' }
  mockOpenFolder.mockResolvedValue('D:\\mb')
  renderWithMantine(<TicketFoldersSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTicketFoldersLocation', 'D:\\mb'))
  expect(await screen.findByText(/120 characters long/)).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: NAME })).toHaveValue('D:\\mb')
  await expectNoAxeViolations(document.body)
})

test('a typed path is saved with Save, and a refusal is shown as the field\'s error', async () => {
  outcome = { error: 'D:\\repo is inside a git repository. Choose a folder outside every repository.' }
  renderWithMantine(<TicketFoldersSettings opened />)
  const box = await screen.findByRole('textbox', { name: NAME })
  await vi.waitFor(() => expect(box).toBeEnabled())
  await userEvent.type(box, 'D:\\repo\\t')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText(/inside a git repository/)).toBeInTheDocument()
  expect(stored).toBeNull()
})

test('Use the data home saves null and empties the field', async () => {
  stored = 'D:\\mb'
  renderWithMantine(<TicketFoldersSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Use the data home' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'Use the data home' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTicketFoldersLocation', null))
  await vi.waitFor(() => expect(screen.getByRole('textbox', { name: NAME })).toHaveValue(''))
})

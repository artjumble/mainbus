import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { ReportSettings } from './ReportSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let saved: { saveReports: boolean; reportsFolder: string }

beforeEach(() => {
  mockInvoke.mockReset()
  saved = { saveReports: true, reportsFolder: 'docs/investigations' }
  // The focused workspace the board already loaded: the section reads it from the store, not with a fresh load.
  useMainbus.setState({ workspace: { ...workspace, ...saved } })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.setReportSettings') {
      const input = args[0] as Partial<typeof saved>
      saved = { ...saved, ...input, ...(input.reportsFolder !== undefined ? { reportsFolder: input.reportsFolder.replace(/\\/g, '/') } : {}) }
      return { ...workspace, ...saved }
    }
    return undefined
  })
})

const toggle = (): Promise<HTMLElement> => screen.findByRole('switch', { name: /^Save investigation reports in the repo/ })
const folder = (): HTMLElement => screen.getByRole('textbox', { name: /^Reports folder/ })

test('is on by default with docs/investigations, and switching it off saves it for the workspace', async () => {
  renderWithMantine(<ReportSettings opened />)
  // Settled from the first render: enabled, with what is saved.
  const sw = await toggle()
  expect(sw).toBeChecked()
  expect(sw).toBeEnabled()
  expect(folder()).toHaveValue('docs/investigations')
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.get')
  expect(screen.getByText(/If the repository is public, so are the reports/)).toBeInTheDocument()

  await userEvent.click(sw)
  expect(mockInvoke).toHaveBeenCalledWith('workspace.setReportSettings', { saveReports: false })
  await vi.waitFor(() => expect(sw).not.toBeChecked())
  expect(useMainbus.getState().workspace?.saveReports).toBe(false)
  // Off, there is no folder to set.
  expect(folder()).toBeDisabled()
})

test('saves a custom folder, and refuses one that leaves the repo before saving it', async () => {
  renderWithMantine(<ReportSettings opened />)
  await vi.waitFor(() => expect(folder()).toHaveValue('docs/investigations'))
  const save = screen.getByRole('button', { name: 'Save folder' })
  expect(save).toBeDisabled()

  await userEvent.clear(folder())
  await userEvent.type(folder(), '../outside')
  expect(screen.getByText('The folder must stay inside the repository: ".." leaves it')).toBeInTheDocument()
  expect(save).toBeDisabled()

  await userEvent.clear(folder())
  await userEvent.type(folder(), 'notes\\research')
  expect(save).toBeEnabled()
  await userEvent.click(save)
  expect(mockInvoke).toHaveBeenCalledWith('workspace.setReportSettings', { reportsFolder: 'notes\\research' })
  await vi.waitFor(() => expect(folder()).toHaveValue('notes/research'))
  expect(useMainbus.getState().workspace?.reportsFolder).toBe('notes/research')
})

test('the report settings have no axe violations', async () => {
  renderWithMantine(<ReportSettings opened />)
  await toggle()
  await expectNoAxeViolations()
})

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkspaceBranches } from '../../../shared/api'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { BaseBranchSettings } from './BaseBranchSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

let info: WorkspaceBranches

beforeEach(() => {
  mockInvoke.mockReset()
  useMainbus.setState({ ...initial, workspace: { ...workspace, baseBranch: 'main' } }, true)
  info = {
    baseBranch: 'main',
    branches: [
      { name: 'develop', onRemote: false },
      { name: 'main', onRemote: true }
    ],
    defaultBranch: 'main',
    hasRemote: true,
    baseOnRemote: true
  }
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.branches') return info
    if (command === 'workspace.setBaseBranch') {
      info = { ...info, baseBranch: args[0] as string, baseOnRemote: info.branches.find((b) => b.name === args[0])?.onRemote === true }
      return { ...workspace, baseBranch: args[0] }
    }
    return undefined
  })
})

const select = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: /^Base branch/ })

test('shows the current base, marks branches on origin, and says existing tickets are untouched', async () => {
  renderWithMantine(<BaseBranchSettings opened />)
  const input = await select()
  await vi.waitFor(() => expect(input).toBeEnabled())
  expect(input).toHaveValue('main · on origin')
  expect(screen.getByText(/Existing tickets keep their branches, and their open pull requests aren't retargeted/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save base branch' })).toBeDisabled()
  expect(screen.queryByText(/Pull requests will fail/)).not.toBeInTheDocument()
})

test('choosing another branch and saving changes the workspace base', async () => {
  renderWithMantine(<BaseBranchSettings opened />)
  const input = await select()
  await vi.waitFor(() => expect(input).toBeEnabled())
  await userEvent.click(input)
  await userEvent.click(await screen.findByRole('option', { name: 'develop' }))
  await userEvent.click(screen.getByRole('button', { name: 'Save base branch' }))

  expect(mockInvoke).toHaveBeenCalledWith('workspace.setBaseBranch', 'develop')
  await vi.waitFor(() => expect(useMainbus.getState().workspace?.baseBranch).toBe('develop'))
  expect(await screen.findByText("Pull requests will fail: develop isn't on origin")).toBeInTheDocument()
})

test('warns when the base is not on origin', async () => {
  info = { ...info, baseBranch: 'main', baseOnRemote: false }
  renderWithMantine(<BaseBranchSettings opened />)
  expect(await screen.findByText("Pull requests will fail: main isn't on origin")).toBeInTheDocument()
})

test('has no axe violations', async () => {
  renderWithMantine(<BaseBranchSettings opened />)
  await select()
  await expectNoAxeViolations()
})

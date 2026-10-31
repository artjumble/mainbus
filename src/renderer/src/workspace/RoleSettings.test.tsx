import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AllowRule, Role } from '../../../shared/domain'
import { invoke } from '../api'
import { renderWithMantine } from '../test-utils'
import { RoleSettings } from './RoleSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const role: Role = {
  workspaceId: 'w1',
  name: 'Implementer',
  instructions: 'Be careful.',
  activePhase: 'implementing',
  toolProfile: 'edit',
  model: null,
  effort: null
}

function rule(id: string, toolName: string, pattern: string | null): AllowRule {
  return { id, workspaceId: 'w1', toolName, pattern }
}

let rules: AllowRule[]

beforeEach(() => {
  mockInvoke.mockReset()
  rules = []
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'role.get') return role
    if (command === 'role.update') return { ...role, ...(args[0] as object) }
    if (command === 'allowRules.list') return rules
    return undefined
  })
})

const save = (): HTMLElement => screen.getByRole('button', { name: 'Save' })
const optionLabels = (select: HTMLElement): string[] =>
  within(select).getAllByRole('option').map((o) => o.textContent ?? '')

test('edits Implementer instructions, model and effort', async () => {
  renderWithMantine(<RoleSettings opened onClose={() => {}} />)
  const instructions = await screen.findByLabelText('Instructions')
  await vi.waitFor(() => expect(instructions).toHaveValue('Be careful.'))
  const model = screen.getByLabelText('Model')
  const effort = screen.getByLabelText('Effort')
  expect(optionLabels(model)).toEqual(['Orchestrator decides', 'Opus', 'Sonnet'])
  expect(optionLabels(effort)).toEqual(['Orchestrator decides', 'Low', 'Medium', 'High'])
  expect(screen.getByText(/Claude Code's default/)).toBeInTheDocument()
  expect(save()).toBeDisabled()

  await userEvent.clear(instructions)
  await userEvent.type(instructions, 'Be bold.')
  await userEvent.selectOptions(model, 'Opus')
  await userEvent.selectOptions(effort, 'High')
  expect(save()).toBeEnabled()
  await userEvent.click(save())

  await vi.waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith('role.update', { instructions: 'Be bold.', model: 'opus', effort: 'high' })
  )
  // The saved value stays on screen and Save goes back to disabled.
  await vi.waitFor(() => expect(save()).toBeDisabled())
  expect(instructions).toHaveValue('Be bold.')
  expect(model).toHaveValue('opus')

  // Choosing "Orchestrator decides" again saves null.
  await userEvent.selectOptions(model, 'Orchestrator decides')
  await userEvent.selectOptions(effort, 'Orchestrator decides')
  await userEvent.click(save())
  await vi.waitFor(() =>
    expect(mockInvoke).toHaveBeenLastCalledWith('role.update', { instructions: 'Be bold.', model: null, effort: null })
  )
})

test('a failed save shows the message and keeps the edits', async () => {
  renderWithMantine(<RoleSettings opened onClose={() => {}} />)
  const instructions = await screen.findByLabelText('Instructions')
  await vi.waitFor(() => expect(instructions).toHaveValue('Be careful.'))
  mockInvoke.mockRejectedValue(new Error('Disk full'))
  await userEvent.type(instructions, ' More.')
  await userEvent.click(save())
  expect(await screen.findByText('Disk full')).toBeInTheDocument()
  expect(instructions).toHaveValue('Be careful. More.')
  expect(save()).toBeEnabled()
})

test('lists allow rules and removes one', async () => {
  rules = [
    rule('a1', 'Bash', 'pnpm install *'),
    rule('a2', 'Bash', '=git status'),
    rule('a3', 'WebFetch', null)
  ]
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'role.get') return role
    if (command === 'allowRules.list') return rules
    if (command === 'allowRules.remove') {
      rules = rules.filter((r) => r.id !== 'a1')
      return undefined
    }
    return undefined
  })
  renderWithMantine(<RoleSettings opened onClose={() => {}} />)
  expect(await screen.findByText('Bash: pnpm install *')).toBeInTheDocument()
  expect(screen.getByText('Bash: git status (exact)')).toBeInTheDocument()
  expect(screen.getByText('WebFetch: any use')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Remove Bash: pnpm install *' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('allowRules.remove', 'a1'))
  await vi.waitFor(() => expect(screen.queryByText('Bash: pnpm install *')).not.toBeInTheDocument())
  expect(screen.getByText('WebFetch: any use')).toBeInTheDocument()
})

test('says so when no commands are always allowed', async () => {
  renderWithMantine(<RoleSettings opened onClose={() => {}} />)
  expect(await screen.findByText(/Nothing is always allowed/)).toBeInTheDocument()
})

test('loads nothing while closed', () => {
  renderWithMantine(<RoleSettings opened={false} onClose={() => {}} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AllowRule } from '../../../shared/domain'
import { invoke } from '../api'
import { makeLineup, renderWithMantine } from '../test-utils'
import { WorkspaceSettings } from './WorkspaceSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

function rule(id: string, toolName: string, pattern: string | null): AllowRule {
  return { id, workspaceId: 'w1', toolName, pattern }
}

let rules: AllowRule[]

beforeEach(() => {
  mockInvoke.mockReset()
  rules = []
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'lineup.get') return makeLineup()
    if (command === 'allowRules.list') return rules
    return undefined
  })
})

test('shows the lineup, the pull request switch, the allow list and Connect agents', async () => {
  renderWithMantine(<WorkspaceSettings opened onClose={() => {}} />)
  expect(await screen.findByRole('button', { name: 'Edit Planner' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Lineup' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Always allowed in this workspace' })).toBeInTheDocument()
  expect(await screen.findByRole('region', { name: 'Connect agents' })).toBeInTheDocument()
  // Only the Change lineup for now: no Investigate tab.
  expect(screen.queryByRole('tab')).not.toBeInTheDocument()
})

test('lists allow rules and removes one', async () => {
  rules = [
    rule('a1', 'Bash', 'pnpm install *'),
    rule('a2', 'Bash', '=git status'),
    rule('a3', 'WebFetch', null)
  ]
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'lineup.get') return makeLineup()
    if (command === 'allowRules.list') return rules
    if (command === 'allowRules.remove') {
      rules = rules.filter((r) => r.id !== 'a1')
      return undefined
    }
    return undefined
  })
  renderWithMantine(<WorkspaceSettings opened onClose={() => {}} />)
  expect(await screen.findByText('Bash: pnpm install *')).toBeInTheDocument()
  expect(screen.getByText('Bash: git status (exact)')).toBeInTheDocument()
  expect(screen.getByText('WebFetch: any use')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Remove Bash: pnpm install *' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('allowRules.remove', 'a1'))
  await vi.waitFor(() => expect(screen.queryByText('Bash: pnpm install *')).not.toBeInTheDocument())
  expect(screen.getByText('WebFetch: any use')).toBeInTheDocument()
})

test('says so when no commands are always allowed', async () => {
  renderWithMantine(<WorkspaceSettings opened onClose={() => {}} />)
  expect(await screen.findByText(/Nothing is always allowed/)).toBeInTheDocument()
})

test('loads nothing while closed', () => {
  renderWithMantine(<WorkspaceSettings opened={false} onClose={() => {}} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('Connect agents shows copyable setup lines built from the real launcher', async () => {
  const launcher = '/apps/Mainbus/bin/mainbus.cmd'
  const base = mockInvoke.getMockImplementation() as (command: string, ...args: unknown[]) => Promise<unknown>
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) =>
    command === 'agents.launcher' ? { kind: 'stable', program: [launcher], env: {}, exists: true } : base(command, ...args)
  )
  renderWithMantine(<WorkspaceSettings opened onClose={() => {}} />)
  const section = await screen.findByRole('region', { name: 'Connect agents' })
  expect(await within(section).findByText(`claude mcp add --scope user mainbus -- cmd /c ${launcher} mcp`)).toBeInTheDocument()
  expect(within(section).getByText(/\[mcp_servers\.mainbus\]/)).toBeInTheDocument()
  expect(within(section).getByText(/"servers"/)).toBeInTheDocument()
  for (const client of ['Claude Code', 'Codex', 'GitHub Copilot in VS Code']) {
    expect(within(section).getByRole('button', { name: `Copy the ${client} setup` })).toBeInTheDocument()
  }
  expect(within(section).queryByText(/isn't there yet/)).not.toBeInTheDocument()
})

test('Connect agents says when the stable launcher has not been written yet', async () => {
  const base = mockInvoke.getMockImplementation() as (command: string, ...args: unknown[]) => Promise<unknown>
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) =>
    command === 'agents.launcher' ? { kind: 'stable', program: ['/x/bin/mainbus.cmd'], env: {}, exists: false } : base(command, ...args)
  )
  renderWithMantine(<WorkspaceSettings opened onClose={() => {}} />)
  expect(await screen.findByText(/build-stable\.ps1/)).toBeInTheDocument()
})

test("Connect agents shows why agents can't reach the board when the intake pipe couldn't be opened", async () => {
  const base = mockInvoke.getMockImplementation() as (command: string, ...args: unknown[]) => Promise<unknown>
  const intakeError = "Mainbus couldn't open \\.\pipe\mainbus-0123456789abcdef: listen EADDRINUSE"
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) =>
    command === 'agents.launcher'
      ? { kind: 'stable', program: ['/x/bin/mainbus.cmd'], env: {}, exists: true, intakeError }
      : base(command, ...args)
  )
  renderWithMantine(<WorkspaceSettings opened onClose={() => {}} />)
  const section = await screen.findByRole('region', { name: 'Connect agents' })
  expect(await within(section).findByText("Agents can't reach this board")).toBeInTheDocument()
  expect(within(section).getByText(/listen EADDRINUSE/)).toBeInTheDocument()
})

test('Connect agents shows no intake error while the pipe is open', async () => {
  const base = mockInvoke.getMockImplementation() as (command: string, ...args: unknown[]) => Promise<unknown>
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) =>
    command === 'agents.launcher' ? { kind: 'stable', program: ['/x/bin/mainbus.cmd'], env: {}, exists: true } : base(command, ...args)
  )
  renderWithMantine(<WorkspaceSettings opened onClose={() => {}} />)
  const section = await screen.findByRole('region', { name: 'Connect agents' })
  await within(section).findByText(/claude mcp add/)
  expect(within(section).queryByText("Agents can't reach this board")).not.toBeInTheDocument()
})

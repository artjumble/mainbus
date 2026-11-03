import { invoke } from './api'
import { navigateTo } from './navigation'
import { useMainbus } from './store'
import { workspace } from './test-utils'

vi.mock('./api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), onNavigate: vi.fn(), openFolder: vi.fn() }))
vi.mock('./notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
})

test('a ticket in the focused workspace opens at once', async () => {
  useMainbus.setState({ workspace: { ...workspace, id: 'w1' } })
  await navigateTo({ to: 'ticket', workspaceId: 'w1', ticketId: 't1' })
  expect(mockInvoke).not.toHaveBeenCalled()
  expect(useMainbus.getState().currentTicketId).toBe('t1')
})

test('a ticket in another workspace focuses it first, then opens after the reload that clears the open ticket', async () => {
  useMainbus.setState({ workspace: { ...workspace, id: 'w1' }, currentTicketId: 'old' })
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'workspace.get') return { ...workspace, id: 'w2' }
    if (command === 'board.get') return { tickets: [] }
    if (command === 'unattended.get') return { on: false, status: { kind: 'off' } }
    return undefined
  })
  await navigateTo({ to: 'ticket', workspaceId: 'w2', ticketId: 't9' })
  expect(mockInvoke).toHaveBeenCalledWith('workspace.focus', 'w2')
  expect(useMainbus.getState().workspace?.id).toBe('w2')
  expect(useMainbus.getState().currentTicketId).toBe('t9')
})

test('Needs you closes an open ticket to show the board', async () => {
  useMainbus.setState({ workspace: { ...workspace, id: 'w1' }, currentTicketId: 't1' })
  await navigateTo({ to: 'needsYou', workspaceId: 'w1' })
  expect(useMainbus.getState().currentTicketId).toBeNull()
})

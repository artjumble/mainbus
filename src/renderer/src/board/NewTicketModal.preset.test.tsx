import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LineupPreset, RunSettings } from '../../../shared/domain'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { makeLineup, optionLabels, renderWithMantine } from '../test-utils'
import { NewTicketModal } from './NewTicketModal'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const NONE: RunSettings = { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} }
const presets: LineupPreset[] = [
  { id: 'a', workspaceId: 'w1', name: 'Full', settings: NONE },
  { id: 'b', workspaceId: 'w1', name: 'Docs', settings: { ...NONE, excludedRoleIds: ['p', 'r'] } },
  { id: 'c', workspaceId: 'w1', name: 'Old', settings: { ...NONE, excludedRoleIds: ['gone'], roleNames: { gone: 'Architect' } } }
]

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'board.get') return { tickets: [] }
    if (command === 'preset.list') return presets
    if (command === 'lineup.get') return makeLineup()
    return {}
  })
})

const create = (): HTMLElement => screen.getByRole('button', { name: 'Create ticket' })
const presetSelect = (): Promise<HTMLElement> => screen.findByLabelText('Preset')

async function fill(): Promise<void> {
  await userEvent.type(screen.getByLabelText(/Title/), 'Document the API')
  await userEvent.type(screen.getByLabelText(/In your words/), 'Write the docs')
}

test('offers the lineup defaults and the workspace presets', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  expect(optionLabels(await presetSelect())).toEqual(['Lineup defaults', 'Full', 'Docs', 'Old'])
  expect(await presetSelect()).toHaveValue('')
})

test('the chosen preset is sent by name, and forgotten after the ticket is created', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await userEvent.selectOptions(await presetSelect(), 'Docs')
  await fill()
  await userEvent.click(create())
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.objectContaining({ preset: 'Docs', kind: 'change' })))
  await vi.waitFor(() => expect(screen.getByLabelText('Preset')).toHaveValue(''))
})

test('without a preset, none is sent', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await presetSelect()
  await fill()
  await userEvent.click(create())
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.anything()))
  const call = mockInvoke.mock.calls.find((c) => c[0] === 'ticket.create')!
  expect(call[1]).not.toHaveProperty('preset')
})

test('is hidden for an Investigate ticket, and nothing is sent', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await userEvent.selectOptions(await presetSelect(), 'Docs')
  await userEvent.click(screen.getByRole('radio', { name: /Investigate/ }))
  expect(screen.queryByLabelText('Preset')).not.toBeInTheDocument()
  await fill()
  await userEvent.click(create())
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.objectContaining({ kind: 'investigate' })))
  const call = mockInvoke.mock.calls.find((c) => c[0] === 'ticket.create')!
  expect(call[1]).not.toHaveProperty('preset')
})

test('says what a preset drops because the lineup lacks the role', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await userEvent.selectOptions(await presetSelect(), 'Old')
  expect(await screen.findByText("Architect isn't in this lineup, so the Old preset's setting for it was dropped.")).toBeInTheDocument()
})

test('is not shown when the workspace has no presets', async () => {
  mockInvoke.mockImplementation(async (command: string) => (command === 'preset.list' ? [] : command === 'lineup.get' ? makeLineup() : {}))
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await screen.findByLabelText(/Title/)
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('preset.list'))
  expect(screen.queryByLabelText('Preset')).not.toBeInTheDocument()
})

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LineupPreset, RunSettings } from '../../../shared/domain'
import { invoke } from '../api'
import { makeLineup, makeTicket, optionLabels, renderWithMantine } from '../test-utils'
import { RunSettingsModal } from './RunSettingsModal'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const NONE: RunSettings = { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} }
const presets: LineupPreset[] = [
  { id: 'a', workspaceId: 'w1', name: 'Full', settings: NONE },
  {
    id: 'b',
    workspaceId: 'w1',
    name: 'Docs',
    settings: { excludedRoleIds: ['p', 'r'], roles: { i: { model: 'sonnet', effort: 'medium' } }, extraInstructions: 'Docs only.', roleNames: {} }
  },
  { id: 'c', workspaceId: 'w1', name: 'Old', settings: { ...NONE, excludedRoleIds: ['gone'], roleNames: { gone: 'Architect' } } }
]

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'lineup.get') return makeLineup()
    if (command === 'preset.list') return presets
    return undefined
  })
})

async function openDialog(editable = true, kind: 'change' | 'investigate' = 'change'): Promise<HTMLElement> {
  const ticket = makeTicket({ kind }, { column: 'backlog' })
  renderWithMantine(<RunSettingsModal opened onClose={() => {}} ticket={ticket} editable={editable} />)
  return screen.findByRole('dialog', { name: 'Run settings' })
}

test('the Preset select is at the top, with a prompt and the workspace presets', async () => {
  const dialog = await openDialog()
  const select = await within(dialog).findByLabelText('Preset')
  expect(optionLabels(select)).toEqual(['Choose a preset…', 'Full', 'Docs', 'Old'])
})

test('choosing a preset fills the form, which can still be edited; Save sends the filled settings, not the preset', async () => {
  const dialog = await openDialog()
  await userEvent.selectOptions(await within(dialog).findByLabelText('Preset'), 'Docs')
  expect(within(dialog).getByRole('checkbox', { name: '1. Planner' })).not.toBeChecked()
  expect(within(dialog).getByRole('checkbox', { name: '2. Implementer' })).toBeChecked()
  expect(within(dialog).getByRole('checkbox', { name: '3. Reviewer' })).not.toBeChecked()
  expect(within(dialog).getByLabelText(/Extra instructions/)).toHaveValue('Docs only.')

  // Still editable before Save.
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '1. Planner' }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.setRunSettings', expect.any(String), expect.anything()))
  const call = mockInvoke.mock.calls.find((c) => c[0] === 'ticket.setRunSettings')!
  // Sonnet at medium is what the Implementer runs with anyway, so the form leaves it unsaved.
  expect(call[2]).toEqual({ excludedRoleIds: ['r'], roles: {}, extraInstructions: 'Docs only.' })
})

test('Full ticks every role again', async () => {
  const dialog = await openDialog()
  const select = await within(dialog).findByLabelText('Preset')
  await userEvent.selectOptions(select, 'Docs')
  await userEvent.selectOptions(select, 'Full')
  for (const name of ['1. Planner', '2. Implementer', '3. Reviewer']) expect(within(dialog).getByRole('checkbox', { name })).toBeChecked()
})

test('says what the preset drops because the lineup lacks the role', async () => {
  const dialog = await openDialog()
  await userEvent.selectOptions(await within(dialog).findByLabelText('Preset'), 'Old')
  expect(await within(dialog).findByText("Architect isn't in this lineup, so the Old preset's setting for it was dropped.")).toBeInTheDocument()
})

test('is disabled while a run is open, and absent for an Investigate ticket', async () => {
  const dialog = await openDialog(false)
  expect(await within(dialog).findByLabelText('Preset')).toBeDisabled()
})

test('an Investigate ticket has no Preset select and asks for no presets', async () => {
  const dialog = await openDialog(true, 'investigate')
  await within(dialog).findByRole('button', { name: 'Save' })
  expect(within(dialog).queryByLabelText('Preset')).not.toBeInTheDocument()
  expect(mockInvoke).not.toHaveBeenCalledWith('preset.list')
})

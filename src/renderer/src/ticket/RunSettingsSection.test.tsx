import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RunSettings, TicketState } from '../../../shared/domain'
import { invoke } from '../api'
import { expectNoAxeViolations, makeLineup, makeTicket, renderWithMantine } from '../test-utils'
import { RunSettingsSection } from './RunSettingsSection'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(),
  isSetupRequired: () => false
}))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const SAVED: RunSettings = {
  excludedRoleIds: ['r'],
  roles: { i: { model: 'opus', effort: 'high' } },
  extraInstructions: null,
  roleNames: { r: 'Reviewer', i: 'Implementer' }
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => (command === 'lineup.get' ? makeLineup() : undefined))
})

function show(runSettings: RunSettings | null, state: Partial<TicketState> = { column: 'backlog' }, notices: string[] = []) {
  const ticket = makeTicket({ runSettings, runSettingsNotices: notices }, state)
  renderWithMantine(<RunSettingsSection ticket={ticket} />)
  return ticket
}

const setRunSettingsCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === 'ticket.setRunSettings')

test('collapsed: "Lineup defaults" with nothing saved, else a one-line summary', async () => {
  show(null)
  expect(screen.getByText('Lineup defaults')).toBeInTheDocument()
  expect(await screen.findByRole('button', { name: 'Edit' })).toBeEnabled()
})

test('the summary names the roles that run and the chosen models', async () => {
  show(SAVED)
  expect(await screen.findByText('Planner, Implementer · Implementer on Opus, high')).toBeInTheDocument()
})

test('Edit opens the form filled in; Save keeps only the choices that differ from the defaults', async () => {
  const ticket = show(null, { column: 'ready' })
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.getByRole('checkbox', { name: '1. Planner' })).toBeChecked()
  expect(screen.getByText('Untick a role to skip it whenever this ticket starts.')).toBeInTheDocument()
  // Reset is for saved settings only.
  expect(screen.queryByRole('button', { name: 'Reset to defaults' })).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole('checkbox', { name: '1. Planner' }))
  await userEvent.click(screen.getByRole('button', { name: /Models and effort per role/ }))
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Model for Implementer' }), 'Opus')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Effort for Implementer' }), 'High')
  await userEvent.type(screen.getByRole('textbox', { name: 'Extra instructions for this agent' }), 'Small diff.')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect(setRunSettingsCalls()).toEqual([
    ['ticket.setRunSettings', ticket.id, { excludedRoleIds: ['p'], roles: { i: { model: 'opus', effort: 'high' } }, extraInstructions: 'Small diff.' }]
  ])
  // Saved: back to the summary.
  expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument()
})

test('the form opens with the saved settings; Reset to defaults clears them; Cancel saves nothing', async () => {
  const ticket = show(SAVED)
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.getByRole('checkbox', { name: '3. Reviewer' })).not.toBeChecked()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(setRunSettingsCalls()).toEqual([])

  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
  expect(setRunSettingsCalls()).toEqual([['ticket.setRunSettings', ticket.id, null]])
})

test('a refused save is shown and keeps the form open', async () => {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'lineup.get') return makeLineup()
    if (command === 'ticket.setRunSettings') throw new Error("Run settings can't be changed while a run is open")
    return undefined
  })
  show(null)
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText("Run settings can't be changed while a run is open")).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
})

test('read-only while a run is open: the summary, no Edit', async () => {
  show(SAVED, { column: 'in_progress', agentStatus: 'working', phase: 'implementing' })
  expect(await screen.findByText('Planner, Implementer · Implementer on Opus, high')).toBeInTheDocument()
  expect(screen.getByText("Can't be changed while a run is open.")).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
})

test('in Review the summary shows alone', async () => {
  show(SAVED, { column: 'review', agentStatus: 'handed_off', phase: 'ready_for_review' })
  expect(await screen.findByText('Planner, Implementer · Implementer on Opus, high')).toBeInTheDocument()
  expect(screen.queryByText("Can't be changed while a run is open.")).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
})

test('what the lineup changes dropped shows above the summary, and has no axe violations', async () => {
  show(SAVED, { column: 'backlog' }, ['Tester is no longer in the lineup, so its saved setting was dropped.'])
  const alert = screen.getByText('The lineup changed since these were saved').closest('[role="alert"]') as HTMLElement
  expect(within(alert).getByText('Tester is no longer in the lineup, so its saved setting was dropped.')).toBeInTheDocument()
  await screen.findByRole('button', { name: 'Edit' })
  await expectNoAxeViolations()
})

import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LineupRole, LineupRoleInput } from '../../../shared/domain'
import { invoke } from '../api'
import { expectNoAxeViolations, makeLineup, optionLabels, renderWithMantine } from '../test-utils'
import { LineupEditor, LineupSettings } from './LineupSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

/** What lineup.save returns: the roles in order, new ones with a real id. */
function savedFrom(roles: LineupRoleInput[]): LineupRole[] {
  return roles.map((r, i) => ({
    ...r,
    id: r.id.startsWith('new-') ? `saved-${i}` : r.id,
    workspaceId: 'w1',
    lineup: 'change',
    position: i + 1
  }))
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'lineup.get') return makeLineup()
    if (command === 'lineup.save') return savedFrom(args[0] as LineupRoleInput[])
    return undefined
  })
})

const saveButton = (): HTMLElement => screen.getByRole('button', { name: 'Save lineup' })
const roleNames = (): string[] =>
  within(screen.getByRole('list', { name: 'Roles' }))
    .getAllByRole('button', { name: /^Edit / })
    .map((b) => b.getAttribute('aria-label')!.replace(/^Edit /, ''))
/** The roles of the last lineup.save call. */
const lastSaved = (): LineupRoleInput[] => {
  const calls = mockInvoke.mock.calls.filter((c) => c[0] === 'lineup.save')
  return calls[calls.length - 1]![1] as LineupRoleInput[]
}

async function renderLoaded(): Promise<void> {
  renderWithMantine(<LineupEditor opened lineup="change" />)
  await screen.findByRole('button', { name: 'Edit Planner' })
}

test('shows the lineup in order, with the first role open for editing', async () => {
  await renderLoaded()
  expect(roleNames()).toEqual(['Planner', 'Implementer', 'Reviewer'])
  const list = screen.getByRole('list', { name: 'Roles' })
  expect(within(list).getByText('Reviewing')).toBeInTheDocument()
  expect(screen.getByLabelText('Name')).toHaveValue('Planner')
  expect(screen.getByLabelText('Instructions')).toHaveValue('Be the Planner.')
  expect(optionLabels(screen.getByLabelText('Phase while active'))).toEqual(['Planning', 'Implementing', 'Testing', 'Reviewing'])
  expect(screen.getByLabelText('Phase while active')).toHaveValue('planning')
  expect(screen.getByLabelText('Tool profile')).toHaveValue('read_only')
  expect(screen.getByRole('radio', { name: 'Ask me' })).toBeChecked()
  expect(screen.queryByLabelText('Hand back to')).not.toBeInTheDocument()
  expect(optionLabels(screen.getByLabelText('Model'))).toEqual(['Orchestrator decides', 'Opus', 'Sonnet', 'Haiku'])
  expect(screen.getByLabelText('Model')).toHaveValue('')
  expect(optionLabels(screen.getByLabelText('Effort'))).toEqual(['Orchestrator decides', 'Low', 'Medium', 'High'])
  expect(screen.getByLabelText('Effort')).toHaveValue('')
  // What "Orchestrator decides" means, with the default table.
  expect(
    screen.getByText(
      '"Orchestrator decides" lets the orchestrator choose when it proposes a start. Otherwise Mainbus\'s defaults apply: ' +
        'Planner Opus, high effort; Reviewer Opus, medium effort; Implementer Sonnet, medium effort; any other role Sonnet, medium effort.'
    )
  ).toBeInTheDocument()
  expect(saveButton()).toBeDisabled()
})

test('edits a role and saves the whole lineup', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Implementer' }))
  const name = screen.getByLabelText('Name')
  await userEvent.clear(name)
  await userEvent.type(name, 'Builder')
  await userEvent.clear(screen.getByLabelText('Instructions'))
  await userEvent.type(screen.getByLabelText('Instructions'), 'Build it.')
  await userEvent.selectOptions(screen.getByLabelText('Phase while active'), 'Testing')
  await userEvent.selectOptions(screen.getByLabelText('Tool profile'), 'Read only (no file edits)')
  await userEvent.selectOptions(screen.getByLabelText('Model'), 'Opus')
  await userEvent.selectOptions(screen.getByLabelText('Effort'), 'High')
  expect(roleNames()).toEqual(['Planner', 'Builder', 'Reviewer'])
  expect(saveButton()).toBeEnabled()

  await userEvent.click(saveButton())
  await vi.waitFor(() => expect(saveButton()).toBeDisabled())
  const [planner, implementer, reviewer] = makeLineup()
  const strip = ({ workspaceId: _w, lineup: _l, position: _p, ...rest }: LineupRole): LineupRoleInput => rest
  expect(lastSaved()).toEqual([
    strip(planner!),
    { ...strip(implementer!), name: 'Builder', instructions: 'Build it.', activePhase: 'testing', toolProfile: 'read_only', model: 'opus', effort: 'high' },
    strip(reviewer!)
  ])
  // The saved lineup stays on screen, with the same role still open.
  expect(screen.getByLabelText('Name')).toHaveValue('Builder')

  // Choosing "Orchestrator decides" again saves null.
  await userEvent.selectOptions(screen.getByLabelText('Model'), 'Orchestrator decides')
  await userEvent.selectOptions(screen.getByLabelText('Effort'), 'Orchestrator decides')
  await userEvent.click(saveButton())
  await vi.waitFor(() => expect(lastSaved()[1]).toMatchObject({ model: null, effort: null }))
})

test('Hand back to offers only earlier roles, defaulting to the previous role, and Ask me clears it', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Reviewer' }))
  expect(screen.getByRole('radio', { name: 'Hand back' })).toBeChecked()
  const handBack = screen.getByLabelText('Hand back to')
  expect(optionLabels(handBack)).toEqual(['Previous role', 'Planner', 'Implementer'])
  expect(handBack).toHaveValue('i')
  await userEvent.selectOptions(handBack, 'Planner')
  await userEvent.click(screen.getByRole('radio', { name: 'Ask me' }))
  expect(screen.queryByLabelText('Hand back to')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: 'Hand back' }))
  expect(screen.getByLabelText('Hand back to')).toHaveValue('')

  await userEvent.click(saveButton())
  await vi.waitFor(() => expect(lastSaved()[2]).toMatchObject({ onProblem: 'hand_back', handBackTo: null }))
})

test('Move up and Move down reorder the roles and keep the focus on the moved role', async () => {
  await renderLoaded()
  expect(screen.getByRole('button', { name: 'Move Planner up' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Move Reviewer down' })).toBeDisabled()

  const down = screen.getByRole('button', { name: 'Move Planner down' })
  down.focus()
  await userEvent.keyboard('{Enter}')
  expect(roleNames()).toEqual(['Implementer', 'Planner', 'Reviewer'])
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Move Planner down' })).toHaveFocus())
  await userEvent.keyboard('{Enter}')
  expect(roleNames()).toEqual(['Implementer', 'Reviewer', 'Planner'])
  // At the bottom, Move down is disabled, so focus goes to Move up.
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Move Planner up' })).toHaveFocus())

  // The Implementer now comes before the Planner it handed back to, so it falls back to the previous role.
  await userEvent.click(screen.getByRole('button', { name: 'Edit Implementer' }))
  expect(screen.getByLabelText('Hand back to')).toHaveValue('')

  await userEvent.click(saveButton())
  await vi.waitFor(() => expect(lastSaved().map((r) => r.name)).toEqual(['Implementer', 'Reviewer', 'Planner']))
  expect(lastSaved()[0]).toMatchObject({ id: 'i', handBackTo: null })
  expect(lastSaved()[1]).toMatchObject({ id: 'r', handBackTo: 'i' })
})

test('dragging a role onto another moves it there', async () => {
  await renderLoaded()
  // jsdom has no layout: give each row a box, stacked 40px apart, so dnd-kit can tell what is under the pointer.
  const rows = screen.getAllByRole('listitem')
  rows.forEach((row, i) => {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: i * 40, width: 300, height: 36 }))
  })
  const handle = screen.getByRole('button', { name: 'Drag Reviewer' })
  fireEvent.pointerDown(handle, { isPrimary: true, button: 0, clientX: 10, clientY: 98 })
  fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: 60 })
  fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: 18 })
  fireEvent.pointerUp(document, { isPrimary: true, clientX: 10, clientY: 18 })
  await vi.waitFor(() => expect(roleNames()).toEqual(['Reviewer', 'Planner', 'Implementer']))
  expect(saveButton()).toBeEnabled()
})

test('adds a role with a name of its own, and saves it as new', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Add role' }))
  expect(roleNames()).toEqual(['Planner', 'Implementer', 'Reviewer', 'New role'])
  expect(screen.getByLabelText('Name')).toHaveValue('New role')
  await userEvent.click(screen.getByRole('button', { name: 'Add role' }))
  expect(roleNames()).toEqual(['Planner', 'Implementer', 'Reviewer', 'New role', 'New role 2'])
  await userEvent.click(screen.getByRole('button', { name: 'Remove New role 2' }))

  await userEvent.type(screen.getByLabelText('Name'), ' for docs')
  await userEvent.type(screen.getByLabelText('Instructions'), 'Update the docs.')
  await userEvent.click(saveButton())
  await vi.waitFor(() => expect(lastSaved()).toHaveLength(4))
  expect(lastSaved()[3]).toMatchObject({ id: expect.stringMatching(/^new-/), name: 'New role for docs', instructions: 'Update the docs.' })
  // After the save the new role has its real id and is still the one open.
  await vi.waitFor(() => expect(saveButton()).toBeDisabled())
  expect(screen.getByLabelText('Name')).toHaveValue('New role for docs')
})

test('removes roles, but never the last one', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Remove Planner' }))
  expect(roleNames()).toEqual(['Implementer', 'Reviewer'])
  // The open role was removed, so the next one opens; it handed back to the Planner, so now to the previous role.
  expect(screen.getByLabelText('Name')).toHaveValue('Implementer')
  expect(screen.getByLabelText('Hand back to')).toHaveValue('')
  await userEvent.click(screen.getByRole('button', { name: 'Remove Reviewer' }))
  expect(roleNames()).toEqual(['Implementer'])
  expect(screen.getByRole('button', { name: 'Remove Implementer' })).toBeDisabled()

  await userEvent.click(saveButton())
  await vi.waitFor(() => expect(lastSaved().map((r) => r.id)).toEqual(['i']))
})

test('shows why lineup.save refused, keeps the edits, and clears the message on the next edit', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Reviewer' }))
  const name = screen.getByLabelText('Name')
  await userEvent.clear(name)
  await userEvent.type(name, 'planner')
  mockInvoke.mockRejectedValueOnce(
    new Error(`Error invoking remote method 'engine:invoke': Error: Two roles are called "Planner". Give each role its own name.`)
  )
  await userEvent.click(saveButton())

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Could not save the lineup')
  expect(alert).toHaveTextContent('Two roles are called "Planner". Give each role its own name.')
  expect(alert).not.toHaveTextContent('Error invoking')
  expect(roleNames()).toEqual(['Planner', 'Implementer', 'planner'])
  expect(saveButton()).toBeEnabled()

  await userEvent.type(name, ' 2')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('a role whose name is cleared is still listed by its place', async () => {
  await renderLoaded()
  await userEvent.clear(screen.getByLabelText('Name'))
  expect(roleNames()).toEqual(['Role 1', 'Implementer', 'Reviewer'])
})

test('loads nothing while closed', () => {
  renderWithMantine(<LineupSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('has a tab for each lineup; the Investigate tab loads and saves the Investigate lineup', async () => {
  const investigator: LineupRole = { ...makeLineup()[0]!, id: 'inv', name: 'Investigator', lineup: 'investigate' }
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'lineup.get') return args[0] === 'investigate' ? [investigator] : makeLineup()
    if (command === 'lineup.save') return savedFrom(args[0] as LineupRoleInput[]).map((r) => ({ ...r, lineup: args[1] as 'change' | 'investigate' }))
    return undefined
  })
  renderWithMantine(<LineupSettings opened />)
  expect(screen.getByRole('tab', { name: 'Change' })).toHaveAttribute('aria-selected', 'true')
  await screen.findByRole('button', { name: 'Edit Planner' })
  expect(mockInvoke).toHaveBeenCalledWith('lineup.get', 'change')
  expect(mockInvoke).toHaveBeenCalledWith('lineup.get', 'investigate')

  await userEvent.click(screen.getByRole('tab', { name: 'Investigate' }))
  expect(screen.getByText(/The last role ends with a report instead of a handoff/)).toBeVisible()
  await userEvent.click(await screen.findByRole('button', { name: 'Edit Investigator' }))
  // The Change panel stays mounted, hidden, with a Name field of its own.
  const name = within(screen.getByRole('tabpanel', { name: 'Investigate' })).getByLabelText('Name')
  await userEvent.clear(name)
  await userEvent.type(name, 'Detective')
  await userEvent.click(saveButton())
  const saves = mockInvoke.mock.calls.filter((c) => c[0] === 'lineup.save')
  expect(saves).toHaveLength(1)
  expect(saves[0]![2]).toBe('investigate')
  expect((saves[0]![1] as LineupRoleInput[]).map((r) => r.name)).toEqual(['Detective'])
})

test('the lineup editor has no axe violations', async () => {
  await renderLoaded()
  await expectNoAxeViolations()
})

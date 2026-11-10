import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LineupPreset, LineupPresetInput, RunSettings } from '../../../shared/domain'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { DISCOVERED, expectNoAxeViolations, makeLineup, optionLabels, renderWithMantine } from '../test-utils'
import { PresetSettings } from './PresetSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const NONE: RunSettings = { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} }
let presets: LineupPreset[]

function preset(id: string, name: string, settings = NONE): LineupPreset {
  return { id, workspaceId: 'w1', name, settings }
}

beforeEach(() => {
  presets = [
    preset('a', 'Full'),
    preset('b', 'Quick fix', { ...NONE, excludedRoleIds: ['p'], roleNames: { p: 'Planner' } }),
    preset('c', 'Docs', { excludedRoleIds: ['p', 'r'], roles: { i: { model: 'sonnet', effort: 'medium' } }, extraInstructions: null, roleNames: {} })
  ]
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'lineup.get') return makeLineup()
    if (command === 'preset.list') return presets
    if (command === 'preset.save') {
      const input = args[0] as LineupPresetInput
      const saved = preset(input.id ?? 'new', input.name.trim(), { ...NONE, excludedRoleIds: input.settings.excludedRoleIds, roles: input.settings.roles })
      presets = input.id ? presets.map((p) => (p.id === input.id ? saved : p)) : [...presets, saved]
      return saved
    }
    if (command === 'preset.remove') {
      presets = presets.filter((p) => p.id !== args[0])
      return undefined
    }
    return undefined
  })
})

const lastSave = (): LineupPresetInput => {
  const calls = mockInvoke.mock.calls.filter((c) => c[0] === 'preset.save')
  return calls[calls.length - 1]![1] as LineupPresetInput
}

async function renderLoaded(): Promise<HTMLElement> {
  renderWithMantine(<PresetSettings opened lineupVersion={0} />)
  return screen.findByRole('list', { name: 'Presets' })
}

test('lists the presets with what each runs', async () => {
  const list = await renderLoaded()
  const rows = within(list).getAllByRole('listitem')
  expect(rows.map((r) => r.getAttribute('data-preset'))).toEqual(['Full', 'Quick fix', 'Docs'])
  expect(within(rows[0]!).getByText('Planner, Implementer, Reviewer')).toBeInTheDocument()
  expect(within(rows[1]!).getByText('Implementer, Reviewer')).toBeInTheDocument()
  expect(within(rows[2]!).getByText('Implementer · Implementer on Sonnet, medium')).toBeInTheDocument()
})

test('edits a preset in the Run settings form: unticking a role and renaming it', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Quick fix' }))
  const dialog = await screen.findByRole('dialog', { name: 'Edit preset' })
  expect(within(dialog).getByRole('checkbox', { name: '1. Planner' })).not.toBeChecked()
  expect(within(dialog).getByRole('checkbox', { name: '2. Implementer' })).toBeChecked()

  await userEvent.click(within(dialog).getByRole('checkbox', { name: '3. Reviewer' }))
  const name = within(dialog).getByLabelText('Name')
  await userEvent.clear(name)
  await userEvent.type(name, 'Small fix')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save preset' }))

  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(lastSave()).toEqual({ id: 'b', name: 'Small fix', settings: { excludedRoleIds: ['p', 'r'], roles: {}, extraInstructions: '' } })
  expect(await screen.findByRole('button', { name: 'Edit Small fix' })).toBeInTheDocument()
})

test("a preset may put a role on Fable when the user's claude has it, and lists it with its version", async () => {
  useMainbus.getState().setModelOptions(DISCOVERED)
  try {
    await renderLoaded()
    await userEvent.click(screen.getByRole('button', { name: /Add preset/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New preset' })
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Fable')
    await userEvent.click(within(dialog).getByRole('button', { name: /Models and effort per role/ }))
    const model = await within(dialog).findByRole('combobox', { name: 'Model for Implementer' })
    expect(optionLabels(model)).toEqual(['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
    await userEvent.selectOptions(model, 'Fable 5.2')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save preset' }))

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lastSave()).toEqual({ name: 'Fable', settings: { excludedRoleIds: [], roles: { i: { model: 'claude-fable-5-2' } }, extraInstructions: '' } })
    const row = (await screen.findAllByRole('listitem')).find((r) => r.getAttribute('data-preset') === 'Fable')!
    expect(within(row).getByText('Planner, Implementer, Reviewer · Implementer on Fable 5.2')).toBeInTheDocument()
  } finally {
    useMainbus.getState().setModelOptions([])
  }
})

test('adds a preset', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: /Add preset/ }))
  const dialog = await screen.findByRole('dialog', { name: 'New preset' })
  const save = within(dialog).getByRole('button', { name: 'Save preset' })
  expect(save).toBeDisabled()
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Spike')
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '1. Planner' }))
  await userEvent.click(save)

  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(lastSave()).toEqual({ name: 'Spike', settings: { excludedRoleIds: ['p'], roles: {}, extraInstructions: '' } })
  expect(await screen.findByRole('button', { name: 'Remove Spike' })).toBeInTheDocument()
})

test('a refused save is shown and keeps the form open', async () => {
  const base = mockInvoke.getMockImplementation() as (command: string, ...args: unknown[]) => Promise<unknown>
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'preset.save') throw new Error('There is already a preset called "Docs".')
    return base(command, ...args)
  })
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: /Add preset/ }))
  const dialog = await screen.findByRole('dialog', { name: 'New preset' })
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Docs')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save preset' }))
  expect(await within(dialog).findByText('There is already a preset called "Docs".')).toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'New preset' })).toBeInTheDocument()
})

test('removes a preset', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Remove Full' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('preset.remove', 'a'))
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Full' })).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Edit Docs' })).toBeInTheDocument()
})

test('reads the presets again when the Change lineup was saved', async () => {
  const { rerender } = renderWithMantine(<PresetSettings opened lineupVersion={0} />)
  await screen.findByRole('list', { name: 'Presets' })
  const reads = (): number => mockInvoke.mock.calls.filter((c) => c[0] === 'preset.list').length
  const before = reads()
  rerender(<PresetSettings opened lineupVersion={1} />)
  await vi.waitFor(() => expect(reads()).toBeGreaterThan(before))
})

test('has no axe violations, with the form open', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Docs' }))
  await screen.findByRole('dialog', { name: 'Edit preset' })
  await expectNoAxeViolations()
})

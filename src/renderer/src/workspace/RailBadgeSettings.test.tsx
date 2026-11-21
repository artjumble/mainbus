import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkspaceSummary } from '../../../shared/api'
import type { RailBadgeInput } from '../../../shared/domain'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { RailBadgeSettings } from './RailBadgeSettings'
import { WorkspaceRail } from './WorkspaceRail'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(() => () => {}),
  openFolder: vi.fn(),
  isSetupRequired: () => false
}))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const summary = (id: string, name: string): WorkspaceSummary => ({
  ...workspace,
  id,
  name,
  repoPath: `/r/${name}`,
  active: false,
  needsYou: 0,
  working: 0,
  waiting: 0,
  idle: 0
})

let summaries: WorkspaceSummary[]

/** The engine's rail badge handling: it holds the summaries, saves what it is given, and can refuse. */
function engine(opts: { reject?: string } = {}): void {
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.summaries') return summaries
    if (command === 'workspace.setRailBadge') {
      if (opts.reject) throw new Error(opts.reject)
      const badge = args[0] as RailBadgeInput
      const focused = useMainbus.getState().workspace!
      summaries = summaries.map((w) =>
        w.id === focused.id
          ? {
              ...w,
              ...(badge.label !== undefined ? { railLabel: badge.label } : {}),
              ...(badge.color !== undefined ? { railColor: badge.color } : {})
            }
          : w
      )
      return summaries.find((w) => w.id === focused.id)
    }
    throw new Error(`unexpected ${command}`)
  })
}

const tile = (name: RegExp): HTMLElement => screen.getByRole('button', { name }).querySelector('[data-initials]') as HTMLElement
const saved = (): unknown[][] => mockInvoke.mock.calls.filter((c) => c[0] === 'workspace.setRailBadge')

function show(): void {
  renderWithMantine(
    <>
      <WorkspaceRail />
      <RailBadgeSettings opened />
    </>
  )
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  summaries = [summary('a', 'mainbus'), summary('b', 'hunter')]
  useMainbus.setState({ workspace: summaries[0], workspaces: summaries })
})

test('a custom label and color show in the rail, and clearing them goes back to the automatic ones', async () => {
  engine()
  show()
  const user = userEvent.setup()
  const automaticLabel = tile(/^mainbus/).dataset.initials
  const automaticColor = tile(/^mainbus/).dataset.railColor
  expect(automaticLabel).toBe('MA')

  await user.type(screen.getByRole('textbox', { name: 'Short label' }), '🚀')
  await user.click(screen.getByRole('button', { name: 'Save label' }))
  await user.click(screen.getByRole('combobox', { name: 'Color' }))
  await user.click(await screen.findByRole('option', { name: 'Pink' }))
  await vi.waitFor(() => expect(tile(/^mainbus/)).toHaveAttribute('data-initials', '🚀'))
  await vi.waitFor(() => expect(tile(/^mainbus/)).toHaveAttribute('data-rail-color', 'pink'))

  await user.clear(screen.getByRole('textbox', { name: 'Short label' }))
  await user.click(screen.getByRole('button', { name: 'Save label' }))
  await vi.waitFor(() => expect(screen.getByRole('combobox', { name: 'Color' })).toBeEnabled())
  await user.click(screen.getByRole('combobox', { name: 'Color' }))
  await user.click(await screen.findByRole('option', { name: /^Automatic/ }))
  await vi.waitFor(() => expect(tile(/^mainbus/)).toHaveAttribute('data-initials', automaticLabel))
  await vi.waitFor(() => expect(tile(/^mainbus/)).toHaveAttribute('data-rail-color', automaticColor))
  expect(saved()).toEqual([
    ['workspace.setRailBadge', { label: '🚀' }],
    ['workspace.setRailBadge', { color: 'pink' }],
    ['workspace.setRailBadge', { label: null }],
    ['workspace.setRailBadge', { color: null }]
  ])
})

test('the Color select lists Automatic with its resolved color first, then every color with an aria-hidden swatch', async () => {
  engine()
  show()
  const user = userEvent.setup()
  const field = screen.getByRole('combobox', { name: 'Color' })
  expect((field as HTMLInputElement).value).toMatch(/^Automatic \(\w+\)$/)
  await user.click(field)
  const options = await screen.findAllByRole('option')
  expect(options).toHaveLength(9)
  expect(options[0]).toHaveAccessibleName(/^Automatic \(\w+\)$/)
  expect(options[1]).toHaveAccessibleName('Blue')
  for (const o of options) expect(o.querySelector('[aria-hidden="true"]')).not.toBeNull()
})

test("a label another workspace shows is refused on the spot, whatever its case, and never sent", async () => {
  engine()
  show()
  const user = userEvent.setup()
  // hunter's automatic label is HU.
  await user.type(screen.getByRole('textbox', { name: 'Short label' }), 'hu')
  expect(await screen.findByText(/hunter already shows HU/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save label' })).toBeDisabled()
  expect(saved()).toEqual([])
})

test('a label of four characters is refused', async () => {
  engine()
  show()
  await userEvent.setup().type(screen.getByRole('textbox', { name: 'Short label' }), 'abcd')
  expect(await screen.findByText(/at most 3 characters/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save label' })).toBeDisabled()
})

test("the engine's refusal is shown", async () => {
  engine({ reject: 'Too many rockets.' })
  show()
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Short label' }), 'ZZ')
  await user.click(screen.getByRole('button', { name: 'Save label' }))
  expect(await screen.findByText('Too many rockets.')).toBeInTheDocument()
})

test('has no accessibility violations', async () => {
  engine()
  const { container } = renderWithMantine(<RailBadgeSettings opened />)
  await expectNoAxeViolations(container)
})

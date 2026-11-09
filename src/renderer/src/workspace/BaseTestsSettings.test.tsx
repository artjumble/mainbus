import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BaseTestsView, TestCommand } from '../../../shared/domain'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { BaseTestsSettings } from './BaseTestsSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(() => () => {}), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let saved: TestCommand[]
let view: BaseTestsView

const UNIT: TestCommand = { name: 'Unit', command: 'npx vitest run --outputFile=<results>', format: 'vitest-json' }

beforeEach(() => {
  mockInvoke.mockReset()
  saved = []
  view = { summary: null, results: [], runs: 0, running: null, waitingForAgents: false }
  useMainbus.setState({ workspace: { ...workspace, testCommands: saved } })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.setTestCommands') {
      saved = args[0] as TestCommand[]
      return { ...workspace, testCommands: saved }
    }
    if (command === 'workspace.baseTests') return view
    return undefined
  })
})

const save = (): HTMLElement => screen.getByRole('button', { name: 'Save test commands' })

test('is empty by default, with nothing to save and no run controls', () => {
  renderWithMantine(<BaseTestsSettings opened />)
  expect(screen.getByRole('region', { name: 'Base branch tests' })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: /Test command 1/ })).not.toBeInTheDocument()
  expect(save()).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Run base tests now' })).not.toBeInTheDocument()
})

test('adds a command, saves it trimmed, and then offers to run it', async () => {
  renderWithMantine(<BaseTestsSettings opened />)
  await userEvent.click(screen.getByRole('button', { name: 'Add test command' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Test command 1 name' }), ' Unit ')
  await userEvent.type(screen.getByRole('textbox', { name: 'Test command 1 command' }), 'npx vitest run --outputFile=<results>')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Test command 1 result format' }), 'vitest-json')
  await userEvent.click(save())

  expect(mockInvoke).toHaveBeenCalledWith('workspace.setTestCommands', [UNIT], 'w1')
  await vi.waitFor(() => expect(useMainbus.getState().workspace?.testCommands).toEqual([UNIT]))
  expect(await screen.findByRole('button', { name: 'Run base tests now' })).toBeEnabled()
})

test('says why a list cannot be saved', async () => {
  renderWithMantine(<BaseTestsSettings opened />)
  await userEvent.click(screen.getByRole('button', { name: 'Add test command' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Test command 1 name' }), 'Unit')
  await userEvent.type(screen.getByRole('textbox', { name: 'Test command 1 command' }), 'npx vitest run')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Test command 1 result format' }), 'vitest-json')
  expect(screen.getByRole('alert')).toHaveTextContent('<results>')
  expect(save()).toBeDisabled()
})

test('removes a command', async () => {
  saved = [UNIT]
  useMainbus.setState({ workspace: { ...workspace, testCommands: saved } })
  renderWithMantine(<BaseTestsSettings opened />)
  await userEvent.click(screen.getByRole('button', { name: 'Remove test command 1' }))
  expect(save()).toBeEnabled()
  await userEvent.click(save())
  expect(mockInvoke).toHaveBeenCalledWith('workspace.setTestCommands', [], 'w1')
})

test('shows the last run, its known failures with the intermittent ones marked, and runs on demand', async () => {
  useMainbus.setState({ workspace: { ...workspace, testCommands: [UNIT] } })
  view = {
    summary: {
      baseRef: 'origin/main',
      baseSha: 'abcdef1234567890',
      at: '2026-11-07T16:57:28.486Z',
      error: null,
      commands: [{ name: 'Unit', exitCode: 1, timedOut: false, failing: 2 }],
      knownFailures: [
        { command: 'Unit', test: 'math > divides', failedRuns: 3, ofRuns: 10, intermittent: true, inLatest: true, exitCode: 1 },
        { command: 'Unit', test: 'math > adds', failedRuns: 10, ofRuns: 10, intermittent: false, inLatest: true, exitCode: 1 }
      ]
    },
    results: [{ name: 'Unit', command: 'x', format: 'vitest-json', exitCode: 1, timedOut: false, durationMs: 2300, failures: ['math > adds', 'math > divides'], tail: [], note: null }],
    runs: 4,
    running: null,
    waitingForAgents: false
  }
  renderWithMantine(<BaseTestsSettings opened />)

  expect(await screen.findByText(/Last run .* on origin\/main at abcdef1/)).toBeInTheDocument()
  expect(screen.getByText('Unit: 2 failing (2.3 s)')).toBeInTheDocument()
  expect(screen.getByText('Unit: math > divides')).toBeInTheDocument()
  expect(screen.getByText('intermittent, 3 of 10 runs')).toBeInTheDocument()
  expect(screen.getAllByText(/intermittent/)).toHaveLength(1)

  await userEvent.click(screen.getByRole('button', { name: 'Run base tests now' }))
  expect(mockInvoke).toHaveBeenCalledWith('workspace.runBaseTests', 'w1')
})

test('says when a run is under way or waiting for agents', async () => {
  useMainbus.setState({ workspace: { ...workspace, testCommands: [UNIT] } })
  view = { ...view, running: { startedAt: '2026-11-07T16:57:28.486Z', baseSha: 'abcdef1234567890', command: 'Unit' } }
  const { unmount } = renderWithMantine(<BaseTestsSettings opened />)
  expect(await screen.findByText('Running on abcdef1 (Unit)…')).toBeInTheDocument()
  unmount()

  view = { ...view, running: null, waitingForAgents: true }
  renderWithMantine(<BaseTestsSettings opened />)
  expect(await screen.findByText('Waiting for agents to finish')).toBeInTheDocument()
})

test('the base branch tests settings have no axe violations', async () => {
  useMainbus.setState({ workspace: { ...workspace, testCommands: [UNIT] } })
  const { container } = renderWithMantine(<BaseTestsSettings opened />)
  await screen.findByRole('button', { name: 'Run base tests now' })
  await expectNoAxeViolations(container)
})

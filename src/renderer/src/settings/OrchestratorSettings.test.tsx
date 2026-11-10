import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EngineEvent } from '../../../shared/api'
import {
  latestOfEachFamily,
  ORCHESTRATOR_MODEL_NOTE,
  orchestratorModelState,
  type OrchestratorModelState
} from '../../../shared/orchestratorModel'
import { invoke, onEngineEvent } from '../api'
import { showError } from '../notify'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { OrchestratorSettings } from './OrchestratorSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const NAME = /^Let the orchestrator read web pages/

const OFFERED = latestOfEachFamily([
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }
])
const modelState = (over: Partial<{ family: 'fable' | 'opus' | 'sonnet'; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }> = {}, offered = OFFERED): OrchestratorModelState =>
  orchestratorModelState({ family: over.family ?? 'opus', effort: over.effort ?? 'medium' }, offered, true)

let failSave = false
let model: OrchestratorModelState
let emit: (e: EngineEvent) => void

beforeEach(() => {
  mockInvoke.mockReset()
  vi.mocked(showError).mockReset()
  failSave = false
  model = modelState()
  vi.mocked(onEngineEvent).mockImplementation((listener) => {
    emit = listener
    return () => {}
  })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return { orchestratorWebAccess: true }
    if (command === 'orchestrator.model') return model
    if (command === 'settings.setOrchestratorWebAccess') {
      if (failSave) throw new Error('disk full')
      return { orchestratorWebAccess: args[0] }
    }
    if (command === 'settings.setOrchestratorModel' || command === 'settings.setOrchestratorEffort') {
      if (failSave) throw new Error('disk full')
      // The engine answers with the settings and tells the renderer the new state through an event.
      model = command === 'settings.setOrchestratorModel' ? modelState({ family: args[0] as 'sonnet', effort: model.effort }) : modelState({ family: model.saved, effort: args[0] as 'high' })
      emit({ type: 'orchestrator.model', state: model })
      return {}
    }
    return undefined
  })
})

test('loads nothing while closed', () => {
  renderWithMantine(<OrchestratorSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('offers the latest Fable, Opus and Sonnet with their versions, and every effort; Opus at medium by default, with the note', async () => {
  renderWithMantine(<OrchestratorSettings opened />)
  const modelSelect = screen.getByRole('combobox', { name: 'Model' })
  await vi.waitFor(() => expect(modelSelect).toBeEnabled())
  const options = (el: HTMLElement) => [...el.querySelectorAll('option')].map((o) => o.textContent)
  expect(options(modelSelect)).toEqual(['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5'])
  expect(modelSelect).toHaveValue('opus')
  const effort = screen.getByRole('combobox', { name: 'Effort' })
  expect(options(effort)).toEqual(['Low', 'Medium', 'High', 'Xhigh', 'Max'])
  expect(effort).toHaveValue('medium')
  expect(screen.getByText(ORCHESTRATOR_MODEL_NOTE)).toBeInTheDocument()
  expect(ORCHESTRATOR_MODEL_NOTE).toMatch(/slower and use more of your plan/)
})

test('choosing a model and an effort saves them', async () => {
  renderWithMantine(<OrchestratorSettings opened />)
  const modelSelect = screen.getByRole('combobox', { name: 'Model' })
  await vi.waitFor(() => expect(modelSelect).toBeEnabled())
  await userEvent.selectOptions(modelSelect, 'Sonnet 5.5')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setOrchestratorModel', 'sonnet'))
  await vi.waitFor(() => expect(modelSelect).toHaveValue('sonnet'))
  const effort = screen.getByRole('combobox', { name: 'Effort' })
  await userEvent.selectOptions(effort, 'High')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setOrchestratorEffort', 'high'))
  await vi.waitFor(() => expect(effort).toHaveValue('high'))
})

test('a saved model that is no longer offered shows the one used instead, with a notice', async () => {
  model = modelState({ family: 'fable' }, OFFERED.filter((o) => o.family !== 'fable'))
  renderWithMantine(<OrchestratorSettings opened />)
  const modelSelect = screen.getByRole('combobox', { name: 'Model' })
  await vi.waitFor(() => expect(modelSelect).toBeEnabled())
  expect(modelSelect).toHaveValue('opus')
  expect(screen.getByText("Fable isn't offered by your claude, so the orchestrator uses Opus 5.5.")).toBeInTheDocument()
})

test('a model change that fails says so', async () => {
  renderWithMantine(<OrchestratorSettings opened />)
  const modelSelect = screen.getByRole('combobox', { name: 'Model' })
  await vi.waitFor(() => expect(modelSelect).toBeEnabled())
  failSave = true
  await userEvent.selectOptions(modelSelect, 'Fable 5.2')
  await vi.waitFor(() => expect(showError).toHaveBeenCalled())
  expect(modelSelect).toHaveValue('opus')
})

test('is on by default, and turning it off saves and stays off', async () => {
  renderWithMantine(<OrchestratorSettings opened />)
  const toggle = screen.getByRole('switch', { name: NAME })
  await vi.waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toBeChecked()
  await userEvent.click(toggle)
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setOrchestratorWebAccess', false))
  expect(toggle).not.toBeChecked()
})

test('goes back and says so when saving fails', async () => {
  failSave = true
  renderWithMantine(<OrchestratorSettings opened />)
  const toggle = screen.getByRole('switch', { name: NAME })
  await vi.waitFor(() => expect(toggle).toBeEnabled())
  await userEvent.click(toggle)
  await vi.waitFor(() => expect(showError).toHaveBeenCalled())
  expect(toggle).toBeChecked()
})

test('has no accessibility violations', async () => {
  const { container } = renderWithMantine(<OrchestratorSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('switch', { name: NAME })).toBeEnabled())
  await vi.waitFor(() => expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled())
  await expectNoAxeViolations(container)
})

test('reviewing finished tickets is on with a two-minute wait, and both save', async () => {
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return { orchestratorWebAccess: true, reviewDoneTickets: true, reviewDoneWaitMinutes: 2 }
    if (command === 'orchestrator.model') return model
    if (command === 'settings.setReviewDone') {
      const v = args[0] as { on?: boolean; waitMinutes?: number }
      return { orchestratorWebAccess: true, reviewDoneTickets: v.on ?? true, reviewDoneWaitMinutes: v.waitMinutes ?? 2 }
    }
    return undefined
  })
  renderWithMantine(<OrchestratorSettings opened />)
  const toggle = screen.getByRole('switch', { name: /^Review finished tickets for follow-ups/ })
  const wait = screen.getByRole('textbox', { name: /^Wait before reviewing/ })
  await vi.waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toBeChecked()
  expect(wait).toHaveValue('2')
  expect(wait).toBeEnabled()

  await userEvent.clear(wait)
  await userEvent.type(wait, '5')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setReviewDone', { waitMinutes: 5 }))

  await userEvent.click(toggle)
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setReviewDone', { on: false }))
  await vi.waitFor(() => expect(toggle).not.toBeChecked())
  expect(wait).toBeDisabled()
})

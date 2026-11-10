import { act, renderHook, waitFor } from '@testing-library/react'
import type { EngineEvent } from '../../shared/api'
import { ALIAS_MODEL_OPTIONS, modelLabel, setModelOptions } from '../../shared/models'
import { invoke, onEngineEvent } from './api'
import { startSync, useMainbus } from './store'
import { DISCOVERED } from './test-utils'
import { useModelOptions } from './useModelOptions'

vi.mock('./api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

afterEach(() => {
  setModelOptions([])
  useMainbus.setState({ modelOptions: [...ALIAS_MODEL_OPTIONS] })
})

test("offers the aliases until the engine answers, then what the user's claude offers, and reads them once", async () => {
  mockInvoke.mockImplementation(async (command: string) => (command === 'models.list' ? DISCOVERED : undefined))
  const first = renderHook(() => useModelOptions())
  expect(first.result.current).toEqual(ALIAS_MODEL_OPTIONS)
  await waitFor(() => expect(first.result.current).toEqual(DISCOVERED))
  // Every label follows: the alias shows the version it names.
  expect(modelLabel('opus')).toBe('Opus 5.5')
  renderHook(() => useModelOptions())
  expect(mockInvoke.mock.calls.filter(([c]) => c === 'models.list')).toHaveLength(1)
})

test('follows the models.changed event', () => {
  let listener: (e: EngineEvent) => void = () => {}
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return () => {}
  })
  mockInvoke.mockResolvedValue(undefined)
  const stop = startSync(() => {})
  const { result } = renderHook(() => useModelOptions())
  act(() => listener({ type: 'models.changed', options: DISCOVERED }))
  expect(result.current).toEqual(DISCOVERED)
  stop()
})

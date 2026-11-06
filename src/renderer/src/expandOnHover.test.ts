import { act, renderHook } from '@testing-library/react'
import { useExpandOnHover } from './expandOnHover'

describe('useExpandOnHover', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const run = (now: boolean, hovered: boolean) =>
    renderHook(({ n, h }) => useExpandOnHover(n, h), { initialProps: { n: now, h: hovered } })

  test('a hover opens it after 150 ms, not before', () => {
    const { result } = run(false, true)
    act(() => void vi.advanceTimersByTime(100))
    expect(result.current).toBe(false)
    act(() => void vi.advanceTimersByTime(60))
    expect(result.current).toBe(true)
  })

  test('now opens it at once', () => {
    const { result } = run(true, false)
    expect(result.current).toBe(true)
  })

  test('it closes 300 ms after the hover ends', () => {
    const { result, rerender } = run(false, true)
    act(() => void vi.advanceTimersByTime(160))
    rerender({ n: false, h: false })
    act(() => void vi.advanceTimersByTime(250))
    expect(result.current).toBe(true)
    act(() => void vi.advanceTimersByTime(60))
    expect(result.current).toBe(false)
  })

  test('a hover shorter than 150 ms never opens it', () => {
    const { result, rerender } = run(false, true)
    act(() => void vi.advanceTimersByTime(100))
    rerender({ n: false, h: false })
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current).toBe(false)
  })
})

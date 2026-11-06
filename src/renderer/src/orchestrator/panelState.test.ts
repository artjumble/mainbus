import { clampPanelWidth, maxPanelWidth, readPanelOpen, readPanelWidth, writePanelOpen, writePanelWidth } from './panelState'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

test('the panel is open by default', () => {
  expect(readPanelOpen()).toBe(true)
})

test('the state is remembered', () => {
  writePanelOpen(false)
  expect(readPanelOpen()).toBe(false)
  writePanelOpen(true)
  expect(readPanelOpen()).toBe(true)
})

test('storage that throws falls back to open, and a failed write is ignored', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied')
  })
  expect(readPanelOpen()).toBe(true)
  expect(() => writePanelOpen(false)).not.toThrow()
})

describe('width', () => {
  test('is 340 by default and remembered', () => {
    expect(readPanelWidth()).toBe(340)
    writePanelWidth(500)
    expect(readPanelWidth()).toBe(500)
  })

  test('garbage falls back to 340 and stored extremes are clamped', () => {
    for (const bad of ['', 'abc', 'NaN']) {
      localStorage.setItem('mainbus.orchestratorPanelWidth', bad)
      expect(readPanelWidth()).toBe(340)
    }
    localStorage.setItem('mainbus.orchestratorPanelWidth', '100')
    expect(readPanelWidth()).toBe(280)
    localStorage.setItem('mainbus.orchestratorPanelWidth', '5000')
    expect(readPanelWidth()).toBe(720)
  })

  test('storage that throws gives 340, and a failed write is ignored', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readPanelWidth()).toBe(340)
    expect(() => writePanelWidth(400)).not.toThrow()
  })

  test('the maximum is half the window, between 280 and 720', () => {
    expect([400, 800, 1280, 2000].map(maxPanelWidth)).toEqual([280, 400, 640, 720])
    expect(clampPanelWidth(700, 800)).toBe(400)
    expect(clampPanelWidth(100, 800)).toBe(280)
  })
})

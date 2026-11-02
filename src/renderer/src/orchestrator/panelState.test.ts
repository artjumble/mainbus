import { readPanelOpen, writePanelOpen } from './panelState'

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

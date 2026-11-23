import { clampContextWidth, maxContextWidth, readContextWidth, writeContextWidth } from './contextWidth'

beforeEach(() => localStorage.clear())

test('defaults to 380, then remembers a written width', () => {
  expect(readContextWidth()).toBe(380)
  writeContextWidth(520)
  expect(readContextWidth()).toBe(520)
})

test('ignores bad values and raises small ones to the minimum', () => {
  for (const bad of ['', 'abc', 'NaN']) {
    localStorage.setItem('mainbus.ticketContextWidth', bad)
    expect(readContextWidth()).toBe(380)
  }
  localStorage.setItem('mainbus.ticketContextWidth', '100')
  expect(readContextWidth()).toBe(380)
})

test('the maximum leaves 360 px for the conversation, never below 380', () => {
  expect([600, 800, 1000, 1600].map(maxContextWidth)).toEqual([380, 440, 640, 1240])
  expect(clampContextWidth(900, 1000)).toBe(640)
  expect(clampContextWidth(100, 1000)).toBe(380)
})

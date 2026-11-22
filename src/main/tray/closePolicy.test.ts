import { expect, test } from 'vitest'
import { closeAction } from './closePolicy'

test.each([
  ['win32', 'tray', 1, false, 'hide'],
  ['win32', 'tray', 4, false, 'hide'],
  ['win32', 'tray', 0, false, 'quit'],
  ['win32', 'quit', 1, false, 'quit'],
  ['darwin', 'tray', 0, false, 'hide'],
  ['darwin', 'tray', 1, false, 'hide'],
  ['darwin', 'quit', 1, false, 'quit'],
  ['darwin', 'tray', 0, true, 'hide'],
  ['linux', 'tray', 1, false, 'minimize'],
  ['linux', 'tray', 1, true, 'quit'],
  ['linux', 'tray', 0, false, 'quit'],
  ['linux', 'quit', 1, false, 'quit']
] as const)('%s, when closed is %s with %i open agents, minimized %s: %s', (platform, whenClosed, openAgents, minimized, expected) => {
  expect(closeAction({ whenClosed, openAgents, platform, minimized })).toBe(expected)
})

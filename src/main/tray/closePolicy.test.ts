import { expect, test } from 'vitest'
import { closeAction } from './closePolicy'

test.each([
  ['tray', 1, 'hide'],
  ['tray', 4, 'hide'],
  ['tray', 0, 'quit'],
  ['quit', 1, 'quit'],
  ['quit', 0, 'quit']
] as const)('when closed is %s with %i open agents: %s', (whenClosed, openAgents, expected) => {
  expect(closeAction({ whenClosed, openAgents })).toBe(expected)
})

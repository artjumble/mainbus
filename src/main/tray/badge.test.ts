import { expect, test } from 'vitest'
import { badgeKind } from './badge'

test.each([
  ['win32', 'overlay'],
  ['linux', 'count'],
  ['darwin', 'none']
] as const)('%s badge: %s', (platform, expected) => {
  expect(badgeKind(platform)).toBe(expected)
})

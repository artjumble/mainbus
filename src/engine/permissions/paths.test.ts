import { describe, expect, test } from 'vitest'
import { hostPathStyle, pathRules } from './paths'

describe('hostPathStyle', () => {
  test('maps the platform', () => {
    expect(hostPathStyle('win32')).toBe('win32')
    expect(hostPathStyle('darwin')).toBe('darwin')
    expect(hostPathStyle('linux')).toBe('linux')
    expect(hostPathStyle('freebsd')).toBe('linux')
  })
})

describe('isInside', () => {
  test.each([
    ['win32', 'C:\\h\\Work', 'c:\\H\\work\\a', true],
    ['win32', 'C:\\h\\work', 'C:\\h\\work-x', false],
    ['darwin', '/Users/s/Work', '/users/s/WORK/a', true],
    ['darwin', '/Users/s/Work', '/Users/s/Work-x', false],
    ['darwin', '/Users/s/Work', '/Users/s/Work', true],
    ['linux', '/home/s/work', '/home/s/work/a/b', true],
    ['linux', '/home/s/work', '/home/s/WORK/a', false],
    ['linux', '/home/s/work', '/home/s/work-x', false],
    ['linux', '/home/s/work', '/home/s/work', true],
    ['linux', '/home/s/work', '/home/s', false],
    ['linux', '/home/s/work', '/home/s/work/../x', false],
  ] as const)('%s: %s contains %s -> %s', (style, root, target, expected) => {
    const rules = pathRules(style)
    expect(rules.isInside(rules.resolve(root, target), [root])).toBe(expected)
  })
})

describe('resolve', () => {
  test('maps /c/x to a drive only on win32', () => {
    expect(pathRules('win32').resolve('C:\\w', '/c/x')).toBe('C:\\x')
    expect(pathRules('darwin').resolve('/w', '/c/x')).toBe('/c/x')
    expect(pathRules('linux').resolve('/w', '/c/x')).toBe('/c/x')
  })

  test('a backslash is a file name character on POSIX', () => {
    const resolved = pathRules('linux').resolve('/w', '..\\x')
    expect(resolved).toBe('/w/..\\x')
    expect(pathRules('linux').isInside(resolved, ['/w'])).toBe(true)
  })
})

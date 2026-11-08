import { describe, expect, test } from 'vitest'
import { messageHeader, withHeader } from './header'

const ws = { name: 'mainbus', repoPath: 'C:\\code\\mainbus' }

describe('messageHeader', () => {
  test('names the workspace, its repo and the local date and time', () => {
    expect(messageHeader(ws, new Date(2026, 10, 1, 14, 5))).toBe(
      '[Mainbus] Focused workspace: mainbus (C:\\code\\mainbus) · Local time: 2026-11-01 14:05, Sunday'
    )
  })

  test('keeps a workspace name on one line', () => {
    expect(messageHeader({ ...ws, name: 'a\nb' }, new Date(2026, 0, 5, 9, 0))).toBe(
      '[Mainbus] Focused workspace: a b (C:\\code\\mainbus) · Local time: 2026-01-05 09:00, Monday'
    )
  })

  test('withHeader puts the header, a blank line, then the message', () => {
    expect(withHeader(ws, new Date(2026, 10, 1, 14, 5), 'What needs me?')).toBe(
      '[Mainbus] Focused workspace: mainbus (C:\\code\\mainbus) · Local time: 2026-11-01 14:05, Sunday\n\nWhat needs me?'
    )
  })

  test('a mentions line follows the header line, before the blank line', () => {
    const line = '[Mainbus] Mentioned workspaces: hunter (id w2)'
    const out = withHeader(ws, new Date(2026, 10, 1, 14, 5), 'Go', line).split('\n')
    expect(out[1]).toBe(line)
    expect(out.slice(2)).toEqual(['', 'Go'])
  })
})

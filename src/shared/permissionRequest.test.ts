import { describe, expect, test } from 'vitest'
import { parsePermissionQuestion, permissionRequestOf } from './permissionRequest'

const run = (role: string, command: string, reason: string | null) => ({ role, tool: 'Bash', command, path: null, input: null, reason })

describe('parsePermissionQuestion', () => {
  test('a command with a reason', () => {
    expect(parsePermissionQuestion('Implementer wants to run `python -c "print(1)"` — Runs a command Mainbus can\'t check: python -c')).toEqual(
      run('Implementer', 'python -c "print(1)"', "Runs a command Mainbus can't check: python -c")
    )
  })

  test('a command without a reason', () => {
    expect(parsePermissionQuestion('Planner wants to run `pnpm install`')).toEqual(run('Planner', 'pnpm install', null))
  })

  test('a multi-line command that contains " — " and no reason', () => {
    expect(parsePermissionQuestion('Implementer wants to run `echo a — b\nls`')).toEqual(run('Implementer', 'echo a — b\nls', null))
  })

  test('a command with backticks and " — ", then a reason', () => {
    expect(parsePermissionQuestion('Implementer wants to run `echo `date` — now` — Writes outside the folder')).toEqual(
      run('Implementer', 'echo `date` — now', 'Writes outside the folder')
    )
  })

  test('an edit has its path', () => {
    expect(parsePermissionQuestion('Implementer wants to edit `C:\w\a.ts` — Leaves the ticket\'s folder')).toEqual({
      role: 'Implementer',
      tool: 'Edit',
      command: null,
      path: 'C:\w\a.ts',
      input: null,
      reason: "Leaves the ticket's folder"
    })
  })

  test('another tool has its name', () => {
    expect(parsePermissionQuestion('Planner wants to use WebFetch')).toMatchObject({ role: 'Planner', tool: 'WebFetch', command: null, path: null, reason: null })
  })

  test('anything else is not a permission request', () => {
    expect(parsePermissionQuestion('Which database?')).toBeNull()
    expect(parsePermissionQuestion('Implementer wants to run `ls` and more')).toBeNull()
  })
})

test('permissionRequestOf prefers the stored parts over the text', () => {
  const stored = run('Reviewer', 'stored', null)
  expect(permissionRequestOf({ request: stored, question: 'Planner wants to run `text`' })).toBe(stored)
  expect(permissionRequestOf({ request: null, question: 'Planner wants to run `text`' })).toEqual(run('Planner', 'text', null))
})

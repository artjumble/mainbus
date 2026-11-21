import { describe, expect, test } from 'vitest'
import { type GuardContext, guardReason } from './guard'

// A ticket whose folders sit under a custom "Ticket folders location" root on another drive (such as a Dev Drive).
const ctx: GuardContext = {
  worktree: 'D:\\mb\\work\\ws\\14-x',
  additionalDirectories: ['D:\\mb\\scratch\\ws\\14-x'],
  ownBranch: 'mainbus/14-x',
  pathStyle: 'win32'
}

describe('the guard with the ticket folders on another drive', () => {
  test.each([
    ['Write in the ticket folder', 'Write', { file_path: 'D:\\mb\\work\\ws\\14-x\\src\\a.ts' }],
    ['Write in its scratch folder', 'Write', { file_path: 'D:\\mb\\scratch\\ws\\14-x\\notes.txt' }],
    ['rm in the ticket folder', 'Bash', { command: 'rm -rf /d/mb/work/ws/14-x/build' }],
    ['rm in its scratch folder', 'Bash', { command: 'rm -rf /d/mb/scratch/ws/14-x/tmp' }]
  ])('%s needs no card', (_name, tool, input) => {
    expect(guardReason(tool, input, ctx)).toBeNull()
  })

  test.each([
    ['Write elsewhere on that drive', 'Write', { file_path: 'D:\\mb\\other\\x.txt' }],
    ['Write in another ticket folder', 'Write', { file_path: 'D:\\mb\\work\\ws\\15-y\\a.txt' }],
    ['rm elsewhere on that drive', 'Bash', { command: 'rm -rf /d/data' }]
  ])('%s raises a card', (_name, tool, input) => {
    expect(guardReason(tool, input, ctx)).not.toBeNull()
  })

  test('reading in the ticket folder is not a credential reason', () => {
    expect(guardReason('Read', { file_path: 'D:\\mb\\work\\ws\\14-x\\README.md' }, ctx)).toBeNull()
  })
})

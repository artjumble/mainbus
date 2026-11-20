// Replays the shell commands that raised permission cards on this board (fixtures/cards.json: paths and the home
// folder made generic, long commands and anything token-like left out) through the guard, and compares with what
// main's guard said about each one at the time `before` was recorded. `after` is this guard's answer, kept so a
// change to the guard shows up here.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { guardReason, type GuardContext } from './guard'
import cards from './fixtures/cards.json'

interface Said {
  kind: 'hard_stop' | 'automatic'
  message: string
}
interface Card {
  tool: string
  command: string
  cwd?: string
  before: Said | null
  after: Said | null
}

const W = String.raw`C:\h\work\ws\14-x`
const S = String.raw`C:\h\scratch\ws\14-x`
const win = path.win32

// The fake worktree has this repository's folders; the scratch folder has whatever a command makes there.
function exists(p: string): boolean {
  const rel = win.relative(W, p)
  if (rel.startsWith('..') || win.isAbsolute(rel)) return !win.relative(S, p).startsWith('..')
  return fs.existsSync(path.join(process.cwd(), rel))
}

const ctx: GuardContext = { worktree: W, additionalDirectories: [S], scratch: S, ownBranch: 'mainbus/14-x', exists, pathStyle: 'win32' }
const replay = (c: Card): Said | null => {
  const r = guardReason(c.tool, { command: c.command }, { ...ctx, ...(c.cwd ? { cwd: c.cwd } : {}) })
  return r && { kind: r.kind, message: r.message }
}

const all = cards as Card[]

describe('replay of the cards this board raised', () => {
  test.each(all.map((c, i) => [i, c.command.slice(0, 70).replace(/\s+/g, ' '), c] as const))(
    '#%i %s gives the recorded answer',
    (_i, _name, c) => {
      expect(replay(c)).toEqual(c.after)
    },
  )

  test('a heredoc no longer hides a write outside the folders', () => {
    // These were "a heredoc" (automatic) and are now judged by their target: /tmp really is outside.
    const found = all.filter((c) => c.before?.kind === 'automatic' && c.after?.kind === 'hard_stop')
    expect(found.length).toBeGreaterThan(0)
    for (const c of found) {
      expect(c.before?.message, c.command).toContain('heredoc')
      expect(c.after?.message, c.command).toMatch(/^(Writes outside|Leaves) the ticket's folder: C:\\tmp\\/)
    }
  })
})

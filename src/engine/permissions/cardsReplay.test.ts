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

const ctx: GuardContext = { worktree: W, additionalDirectories: [S], scratch: S, ownBranch: 'mainbus/14-x', exists }
const replay = (c: Card): Said | null => {
  const r = guardReason(c.tool, { command: c.command }, { ...ctx, ...(c.cwd ? { cwd: c.cwd } : {}) })
  return r && { kind: r.kind, message: r.message }
}

const all = cards as Card[]
// Hard stops that are right: pushes, credentials, agent and git settings, other branches, repository internals.
const TRUE_STOP =
  /^(Force-pushes|Pushes commits|Reads a credentials file|Prints credentials|Touches the \.claude|Changes agent or git settings|Deletes a branch|Renames a branch|Changes repository internals|Deletes stashed|Permanently prunes|Deletes git reflog|Changes git config|Changes npm config)/

describe('replay of the cards this board raised', () => {
  test.each(all.map((c, i) => [i, c.command.slice(0, 70).replace(/\s+/g, ' '), c] as const))(
    '#%i %s gives the recorded answer',
    (_i, _name, c) => {
      expect(replay(c)).toEqual(c.after)
    },
  )

  test('true hard stops are unchanged', () => {
    const stops = all.filter((c) => c.before?.kind === 'hard_stop' && TRUE_STOP.test(c.before.message))
    expect(stops.length).toBeGreaterThan(15)
    for (const c of stops) expect(c.after, c.command).toMatchObject({ kind: 'hard_stop' })
    // Nothing that raised no card before raises one now.
    for (const c of all.filter((c) => c.before === null)) expect(c.after, c.command).toBeNull()
  })

  test('the examples from the ticket no longer raise a card', () => {
    const wanted = [
      'export MAINBUS_HOME="$TEMP/mbhome"; pnpm exec vitest run > "$TEMP/unit.log"',
      'New-Item -ItemType Junction -Path "$env:TEMP\\mainsrc\\node_modules" -Target "$PWD\\node_modules"',
      'cd ../../..',
    ]
    for (const w of wanted) {
      const card = all.find((c) => c.command.startsWith(w))
      expect(card, w).toBeDefined()
      expect(card?.before?.kind).toBe('hard_stop')
      expect(card?.after).toBeNull()
    }
  })

  test('how many cards the change removes, by kind', () => {
    const count = (f: (c: Card) => boolean): number => all.filter(f).length
    const report = {
      total: all.length,
      hardStopBefore: count((c) => c.before?.kind === 'hard_stop'),
      hardStopNoCardNow: count((c) => c.before?.kind === 'hard_stop' && c.after === null),
      hardStopAutomaticNow: count((c) => c.before?.kind === 'hard_stop' && c.after?.kind === 'automatic'),
      hardStopStill: count((c) => c.before?.kind === 'hard_stop' && c.after?.kind === 'hard_stop'),
      automaticBefore: count((c) => c.before?.kind === 'automatic'),
      automaticNoCardNow: count((c) => c.before?.kind === 'automatic' && c.after === null),
      automaticStill: count((c) => c.before?.kind === 'automatic' && c.after !== null),
    }
    console.info(`Card replay: ${JSON.stringify(report)}`)
    // Most of the false hard stops are gone.
    expect(report.hardStopNoCardNow).toBeGreaterThan(report.hardStopBefore / 2)
  })

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

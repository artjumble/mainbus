import { describe, expect, test } from 'vitest'
import type { Workspace } from '../../shared/domain'
import { NO_WORKSPACE, resolveTargetWorkspace } from './workspaceRef'

const ws = (id: string, name: string): Workspace => ({ id, name, slug: name, repoPath: `/${name}`, baseBranch: 'main', openPrOnReview: false, mergeMethod: 'merge', saveReports: true, reportsFolder: 'docs/investigations', setupCommand: '', setupTimeoutMinutes: 15, testCommands: [] })
const mainbus = ws('w1', 'mainbus')
const website = ws('w2', 'website')

describe('resolveTargetWorkspace', () => {
  test('with one workspace open, it is used when none is named', () => {
    expect(resolveTargetWorkspace([mainbus])).toEqual({ ok: true, ws: mainbus })
    expect(resolveTargetWorkspace([mainbus], ' ')).toEqual({ ok: true, ws: mainbus })
  })

  test('with none open, there is nothing to use', () => {
    expect(resolveTargetWorkspace([])).toEqual({ ok: false, text: NO_WORKSPACE })
  })

  test('with more than one open, one must be named: the error lists them and says to infer or ask', () => {
    const r = resolveTargetWorkspace([mainbus, website])
    expect(r).toEqual({
      ok: false,
      text:
        "More than one workspace is open: mainbus (id w1), website (id w2). Name one with workspace: infer it from the user's words or " +
        "the recent conversation; if they don't make it clear, ask the user which one and end your turn."
    })
  })

  test('a named one is found by id or name; an unknown one is refused with the open ones', () => {
    expect(resolveTargetWorkspace([mainbus, website], 'Website')).toEqual({ ok: true, ws: website })
    expect(resolveTargetWorkspace([mainbus, website], 'w1')).toEqual({ ok: true, ws: mainbus })
    expect(resolveTargetWorkspace([mainbus, website], 'shop')).toEqual({
      ok: false,
      text: 'No workspace "shop". The workspaces are: mainbus (id w1), website (id w2).'
    })
  })
})

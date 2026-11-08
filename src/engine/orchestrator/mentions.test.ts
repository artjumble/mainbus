import { describe, expect, test } from 'vitest'
import type { Workspace } from '../../shared/domain'
import { mentionsLine, resolveMentions } from './mentions'

const ws = (id: string, name: string, repoPath = `C:\\repos\\${name}`): Workspace => ({ id, name, repoPath }) as Workspace
const all = [ws('w1', 'mainbus'), ws('w2', 'hunter'), ws('w3', 'My App')]

describe('resolveMentions', () => {
  test('a hand-typed exact name resolves, ignoring case', () => {
    const r = resolveMentions('ticket in @HUNTER and @"my app"', [], all)
    expect(r.resolved.map((x) => x.ws.id)).toEqual(['w2', 'w3'])
    expect(r.unknown).toEqual([])
  })

  test('an unknown name is marked, and so is part of a name', () => {
    expect(resolveMentions('@nobody @hun', [], all)).toEqual({ resolved: [], unknown: ['@nobody', '@hun'] })
  })

  test('an email address is not a mention', () => {
    expect(resolveMentions('mail a@hunter.com', [], all)).toEqual({ resolved: [], unknown: [] })
  })

  test('two workspaces with one name: the picked id wins, otherwise it is unknown', () => {
    const twins = [ws('a', 'site'), ws('b', 'site')]
    expect(resolveMentions('@site', ['b'], twins).resolved.map((x) => x.ws.id)).toEqual(['b'])
    expect(resolveMentions('@site', [], twins)).toEqual({ resolved: [], unknown: ['@site'] })
  })

  test('a picked id that is gone falls back to the name; one that does not match the token is ignored', () => {
    expect(resolveMentions('@hunter', ['gone'], all).resolved.map((x) => x.ws.id)).toEqual(['w2'])
    expect(resolveMentions('@hunter', ['w1'], all).resolved.map((x) => x.ws.id)).toEqual(['w2'])
  })

  test('a workspace mentioned twice appears once', () => {
    expect(resolveMentions('@hunter then @hunter', [], all).resolved).toHaveLength(1)
  })
})

describe('mentionsLine', () => {
  test('names each workspace with its id and repo, and marks the rest', () => {
    const line = mentionsLine(resolveMentions('@hunter @foo', [], all))
    expect(line).toBe('[Mainbus] Mentioned workspaces: hunter (id w2, C:\\repos\\hunter); "@foo" (not a workspace)')
  })

  test('is null without mentions', () => {
    expect(mentionsLine(resolveMentions('hello', [], all))).toBeNull()
  })

  test('keeps a long or odd token on one line, quoted and clipped', () => {
    const line = mentionsLine({ resolved: [], unknown: [`@"${'x'.repeat(100)}"`] })!
    expect(line.split('\n')).toHaveLength(1)
    expect(line.length).toBeLessThan(140)
  })
})

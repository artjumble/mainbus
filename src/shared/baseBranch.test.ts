import { describe, expect, it } from 'vitest'
import type { BaseBranchChoice } from './api'
import { addBaseQuestion, baseBranchWarning, baseChoiceWarning, needsBaseStep } from './baseBranch'

const choice = (over: Partial<BaseBranchChoice>): BaseBranchChoice => ({ current: 'main', suggested: 'main', branches: [], defaultBranch: 'main', hasRemote: false, removed: null, ...over })

describe('baseBranchWarning', () => {
  it('warns when there is a remote and the base is not on it', () => {
    expect(baseBranchWarning({ baseBranch: 'fm/x', hasRemote: true, baseOnRemote: false })).toBe("Pull requests will fail: fm/x isn't on origin")
  })
  it('is quiet without a remote or when the base is on it', () => {
    expect(baseBranchWarning({ baseBranch: 'fm/x', hasRemote: false, baseOnRemote: false })).toBeNull()
    expect(baseBranchWarning({ baseBranch: 'main', hasRemote: true, baseOnRemote: true })).toBeNull()
  })
})

describe('addBaseQuestion', () => {
  it('asks nothing for a new repo on its default branch', () => {
    expect(addBaseQuestion(choice({}))).toBe('none')
  })
  it('says when the checkout differs from the default', () => {
    expect(addBaseQuestion(choice({ current: 'fm/x' }))).toBe('differs_from_checkout')
  })
  it('asks about a removed workspace whose base is gone or differs', () => {
    expect(addBaseQuestion(choice({ removed: { baseBranch: 'old', exists: false } }))).toBe('removed_missing')
    expect(addBaseQuestion(choice({ removed: { baseBranch: 'dev', exists: true } }))).toBe('removed_differs')
  })
  it('asks nothing for a removed workspace whose base is the default', () => {
    expect(addBaseQuestion(choice({ current: 'fm/x', removed: { baseBranch: 'main', exists: true } }))).toBe('none')
  })
})

describe('needsBaseStep', () => {
  const warning = { branch: 'fm/x', notOnRemote: false, restored: false }
  it('is false without a base choice', () => {
    expect(needsBaseStep({})).toBe(false)
  })
  it('is true for a question, or for a warning with nothing to ask', () => {
    expect(needsBaseStep({ base: choice({ current: 'fm/x' }) })).toBe(true)
    expect(needsBaseStep({ base: choice({ current: 'fm/x', suggested: 'fm/x' }), baseWarning: warning })).toBe(true)
  })
  it('is false when there is nothing to ask and nothing to warn about', () => {
    expect(needsBaseStep({ base: choice({}) })).toBe(false)
  })
})

describe('baseChoiceWarning', () => {
  const branches = [
    { name: 'fm/x', onRemote: false },
    { name: 'fm/y', onRemote: true },
    { name: 'main', onRemote: true }
  ]
  const c = (over: Partial<BaseBranchChoice> = {}): BaseBranchChoice => choice({ branches, hasRemote: true, ...over })
  it('is null for main, master and the default branch', () => {
    expect(baseChoiceWarning(c(), 'main')).toBeNull()
    expect(baseChoiceWarning(c(), 'master')).toBeNull()
    expect(baseChoiceWarning(c({ defaultBranch: 'trunk' }), 'trunk')).toBeNull()
  })
  it('warns about any other branch, and about it missing from origin when there is a remote', () => {
    expect(baseChoiceWarning(c(), 'fm/y')).toEqual({ branch: 'fm/y', notOnRemote: false, restored: false })
    expect(baseChoiceWarning(c(), 'fm/x')).toEqual({ branch: 'fm/x', notOnRemote: true, restored: false })
    expect(baseChoiceWarning(c({ hasRemote: false }), 'fm/x')).toEqual({ branch: 'fm/x', notOnRemote: false, restored: false })
  })
  it("marks a removed workspace's old base as restored", () => {
    expect(baseChoiceWarning(c({ removed: { baseBranch: 'fm/x', exists: true } }), 'fm/x')?.restored).toBe(true)
    expect(baseChoiceWarning(c({ removed: { baseBranch: 'fm/x', exists: false } }), 'fm/x')?.restored).toBe(false)
  })
})

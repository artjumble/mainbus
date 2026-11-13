import { describe, expect, it } from 'vitest'
import type { BaseBranchChoice } from './api'
import { addBaseQuestion, baseBranchWarning } from './baseBranch'

const choice = (over: Partial<BaseBranchChoice>): BaseBranchChoice => ({ current: 'main', suggested: 'main', branches: [], removed: null, ...over })

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

import { describe, expect, it } from 'vitest'
import { mergedText, mergePlanSentences, samePlan, type MergePlan } from './merge'

const local: MergePlan = { kind: 'local', base: 'main', branch: 'feat', head: 'a', how: 'fast_forward', commits: 1, checkout: '/r', currentBranch: 'main', message: null }
const pr: MergePlan = { kind: 'pull_request', base: 'main', branch: 'feat', head: 'a', method: 'squash', pr: { url: 'https://github.com/o/r/pull/3', number: 3 } }

describe('mergePlanSentences', () => {
  it('says each way a pull request is merged, and that the checkout is not touched', () => {
    expect(mergePlanSentences({ ...pr, method: 'merge' })[0]).toBe('Merges pull request #3 into main on GitHub with a merge commit, with gh and your own login.')
    expect(mergePlanSentences(pr)[0]).toContain('by squashing it into one commit')
    expect(mergePlanSentences({ ...pr, method: 'rebase' })[0]).toContain('by rebasing its commits')
    expect(mergePlanSentences(pr)[1]).toBe("Your checkout isn't touched: pull main afterwards.")
  })

  it('says what a local merge does in the checkout, or to the ref alone', () => {
    expect(mergePlanSentences(local)).toEqual(['Fast-forwards main to feat (1 commit) in your checkout, with git merge --ff-only. No merge commit.'])
    expect(mergePlanSentences({ ...local, how: 'merge_commit', commits: 3, message: 'Merge #7: Add login' })[0]).toBe(
      'Merges feat (3 commits) into main in your checkout with a merge commit, "Merge #7: Add login". It has no conflicts.'
    )
    expect(mergePlanSentences({ ...local, how: 'fast_forward_ref', checkout: null })[0]).toContain("main isn't checked out, so no files in your checkout change.")
  })
})

describe('samePlan', () => {
  it('is true for the same plan and false when the head, the way or the kind differs', () => {
    expect(samePlan(local, { ...local })).toBe(true)
    expect(samePlan(local, { ...local, head: 'b' })).toBe(false)
    expect(samePlan(local, { ...local, how: 'merge_commit' })).toBe(false)
    expect(samePlan(pr, { ...pr, method: 'merge' })).toBe(false)
    expect(samePlan(local, pr)).toBe(false)
  })
})

describe('mergedText', () => {
  it('names the way', () => {
    expect(mergedText({ base: 'main', via: 'pull_request', number: 4 })).toBe('Merged into main by you (pull request #4)')
    expect(mergedText({ base: 'main', via: 'local' })).toBe('Merged into main by you (local merge)')
  })
})

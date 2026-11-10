import type { PullRequest } from './domain'

/** How GitHub merges a pull request. */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

export const MERGE_METHODS: MergeMethod[] = ['merge', 'squash', 'rebase']

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase'
}

/** What a local merge does: fast-forward the checked-out base, add a merge commit there, or move the unchecked-out base's ref. */
export type LocalMergeHow = 'fast_forward' | 'merge_commit' | 'fast_forward_ref'

/** Exactly what Merge… would do, worked out from the repository as it is now. */
export type MergePlan =
  | { kind: 'pull_request'; base: string; branch: string; pr: PullRequest; method: MergeMethod; head: string }
  | {
      kind: 'local'
      base: string
      branch: string
      head: string
      how: LocalMergeHow
      /** How many commits the branch has that the base lacks. */
      commits: number
      /** The user's checkout, when the base is checked out there (the merge runs in it); else null. */
      checkout: string | null
      /** The branch the user's checkout is on, for a fast-forward of a base that isn't checked out. */
      currentBranch: string | null
      /** The merge commit's message, for `merge_commit`; else null. */
      message: string | null
    }

export type MergeSuggestion = 'commit_or_stash' | 'update_from_main'

export type MergePreview = { ok: true; plan: MergePlan } | { ok: false; reason: string; suggest: MergeSuggestion | null }

export interface MergeOptions {
  /** Delete the branch on GitHub afterwards. Pull request merges only; off by default. */
  deleteBranch?: boolean
  /** Move the ticket to Done afterwards (its folder is removed, its branch kept). On by default. */
  moveToDone?: boolean
}

export interface MergeOutcome {
  plan: MergePlan
  /** The base's new commit; null when it can't be known (a pull request merge fetched nothing). */
  commit: string | null
  /** What happened to the move to Done: 'not_asked' when it wasn't asked for. */
  moved: 'moved' | 'dirty' | 'asked' | 'not_asked'
  /** Why fetching the base afterwards failed, else null. */
  fetchError: string | null
}

export const SUGGESTION_TEXT: Record<MergeSuggestion, string> = {
  commit_or_stash: 'Commit or stash your changes, then try again.',
  update_from_main: 'Use Update from main on the ticket first.'
}

const METHOD_SENTENCE: Record<MergeMethod, string> = {
  merge: 'with a merge commit',
  squash: 'by squashing it into one commit',
  rebase: 'by rebasing its commits'
}

/** The sentences that say exactly what the plan will do: the dialog and the proposal card both show them. */
export function mergePlanSentences(plan: MergePlan): string[] {
  if (plan.kind === 'pull_request') {
    return [
      `Merges pull request #${plan.pr.number} into ${plan.base} on GitHub ${METHOD_SENTENCE[plan.method]}, with gh and your own login.`,
      `Your checkout isn't touched: pull ${plan.base} afterwards.`
    ]
  }
  const n = plan.commits === 1 ? '1 commit' : `${plan.commits} commits`
  switch (plan.how) {
    case 'fast_forward':
      return [`Fast-forwards ${plan.base} to ${plan.branch} (${n}) in your checkout, with git merge --ff-only. No merge commit.`]
    case 'merge_commit':
      return [`Merges ${plan.branch} (${n}) into ${plan.base} in your checkout with a merge commit, "${plan.message ?? ''}". It has no conflicts.`]
    case 'fast_forward_ref':
      return [
        `Fast-forwards the branch ${plan.base} to ${plan.branch} (${n}). ${plan.base} isn't checked out, so no files in your checkout change.`
      ]
  }
}

/** Whether two plans do the same thing: the same kind, branches, commit and way of merging. */
export function samePlan(a: MergePlan, b: MergePlan): boolean {
  if (a.kind === 'pull_request' && b.kind === 'pull_request') {
    return a.base === b.base && a.branch === b.branch && a.head === b.head && a.method === b.method && a.pr.number === b.pr.number && a.pr.url === b.pr.url
  }
  if (a.kind === 'local' && b.kind === 'local') {
    return a.base === b.base && a.branch === b.branch && a.head === b.head && a.how === b.how && a.checkout === b.checkout && a.message === b.message
  }
  return false
}

/** The Activity line for a merge: "Merged into main by you (pull request #4)" or "(local merge)". */
export function mergedText(e: { base: string; via: 'pull_request' | 'local'; number?: number }): string {
  return `Merged into ${e.base} by you (${e.via === 'pull_request' ? `pull request #${e.number ?? '?'}` : 'local merge'})`
}

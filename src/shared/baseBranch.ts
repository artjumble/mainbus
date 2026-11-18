import type { BaseBranchChoice, BaseBranchWarning, FolderReadiness, WorkspaceBranches } from './api'

/** The warning for a base branch that isn't on the remote, or null when there is nothing to warn about. */
export function baseBranchWarning(info: Pick<WorkspaceBranches, 'baseBranch' | 'hasRemote' | 'baseOnRemote'>): string | null {
  return info.hasRemote && !info.baseOnRemote ? `Pull requests will fail: ${info.baseBranch} isn't on origin` : null
}

/** What Add workspace has to ask about the base branch; 'none' opens the workspace straight away. */
export type AddBaseQuestion = 'none' | 'differs_from_checkout' | 'removed_missing' | 'removed_differs'

export function addBaseQuestion(choice: BaseBranchChoice): AddBaseQuestion {
  if (choice.removed !== null) {
    if (!choice.removed.exists) return 'removed_missing'
    return choice.removed.baseBranch === choice.suggested ? 'none' : 'removed_differs'
  }
  return choice.suggested === choice.current ? 'none' : 'differs_from_checkout'
}

/** Whether Add workspace shows the base branch step for a ready folder: a question to ask, or a base worth a warning. */
export function needsBaseStep(readiness: Pick<FolderReadiness, 'base' | 'baseWarning'>): boolean {
  return readiness.base !== undefined && (addBaseQuestion(readiness.base) !== 'none' || readiness.baseWarning !== undefined)
}

/**
 * The warning for using `branch` as a new workspace's base: it isn't main, master or the repo's default branch, or it isn't on
 * origin. Null when there is nothing to warn about.
 */
export function baseChoiceWarning(choice: BaseBranchChoice, branch: string): BaseBranchWarning | null {
  if (branch === 'main' || branch === 'master' || branch === choice.defaultBranch) return null
  const notOnRemote = choice.hasRemote && !choice.branches.some((b) => b.name === branch && b.onRemote)
  return { branch, notOnRemote, restored: choice.removed?.exists === true && choice.removed.baseBranch === branch }
}

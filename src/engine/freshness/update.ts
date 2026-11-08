import type { LineupRole } from '../../shared/domain'

/** Files whose change on the base means the workspace's setup command (dependency install) is due again. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']

/** The role that does an Update from main: the one named Implementer, else the first that can edit files. */
export function updateRoleOf(lineup: LineupRole[]): LineupRole | null {
  return lineup.find((r) => r.name.trim().toLowerCase() === 'implementer') ?? lineup.find((r) => r.toolProfile === 'edit') ?? null
}

export interface UpdateFacts {
  /** The ref to merge: `origin/main` or the local base. */
  ref: string
  sha: string
  behind: number
  conflicts: string[]
  lockfileChanged: boolean
}

/** The extra instructions of an Update run: what the Implementer does, step by step. */
export function updateInstructions({ ref, sha, behind, conflicts, lockfileChanged }: UpdateFacts): string {
  const commits = `${behind} commit${behind === 1 ? '' : 's'}`
  return [
    `This is an Update run: bring this branch up to date with the newest base. ${ref} (at ${sha.slice(0, 12)}) has ${commits} that this branch does not have.`,
    conflicts.length > 0
      ? `Merging it is known to conflict in: ${conflicts.join(', ')}.`
      : 'Merging it is expected to be clean, but check.',
    lockfileChanged
      ? 'A dependency lockfile differs between the branch and the base, so dependencies may need installing again after the merge.'
      : null,
    '',
    'Do this, in order:',
    `1. Run \`git merge ${ref}\`. Do not rebase, and do not push or fetch: Mainbus does both.`,
    '2. Resolve any conflicts, keeping the intent of both sides. When the conflict is a clash of migration numbers, keep the base\'s migration as it is and renumber this branch\'s to the next free number, updating any journal, snapshot or index that lists it.',
    '3. Run the type check and the tests related to what changed in the merge and in the conflicts you resolved.',
    '4. Make no other changes. Commit the merge, then hand off with a short summary of what you resolved.'
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

import { Badge } from '@mantine/core'
import type { ReactElement } from 'react'
import type { BranchFreshness } from '../../../shared/domain'
import { WRAPPING_CHIP } from './chipStyles'

/**
 * "Conflicts with main" (needs attention) or "Behind main" (quiet) on a card and in the ticket header, for an open
 * ticket whose branch lacks commits of the newest base. Nothing when the branch is up to date or not checked.
 */
export function FreshnessChip({ freshness, done }: { freshness: BranchFreshness | null; done: boolean }): ReactElement | null {
  if (!freshness || done || freshness.behind === 0) return null
  if (freshness.conflicts.length > 0) {
    return (
      <Badge color="needs" variant="light" size="sm" radius="sm" data-freshness-chip="conflicts" {...WRAPPING_CHIP}>
        Conflicts with {freshness.baseBranch}
      </Badge>
    )
  }
  return (
    <Badge color="gray" variant="outline" size="sm" radius="sm" data-freshness-chip="behind" {...WRAPPING_CHIP}>
      Behind {freshness.baseBranch}
    </Badge>
  )
}

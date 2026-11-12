import { useEffect, useState } from 'react'
import type { WorkspaceBranches } from '../../../shared/api'
import { invoke } from '../api'

/**
 * The workspace's branches and whether its base is on origin. Read again when the workspace, its base branch or `reload`
 * changes (the board passes whether settings are open, so closing them re-checks). Null until read, and when it can't be.
 */
export function useWorkspaceBranches(workspaceId: string | undefined, baseBranch: string | undefined, reload?: unknown): WorkspaceBranches | null {
  const [info, setInfo] = useState<WorkspaceBranches | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setInfo(null)
      return
    }
    let cancelled = false
    Promise.resolve(invoke('workspace.branches', workspaceId))
      .then((read) => {
        if (!cancelled) setInfo(read ?? null)
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, baseBranch, reload])

  return info
}

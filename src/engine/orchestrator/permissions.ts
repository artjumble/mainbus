import { guardReason } from '../permissions/guard'
import { ORCHESTRATOR_BUILT_IN_TOOLS, ORCHESTRATOR_READ_TOOLS } from '../runtime/sdkRuntime'
import type { PermissionVerdict } from '../runtime/types'

export const ORCHESTRATOR_DENIED = 'The orchestrator only reads and proposes; it cannot do this.'

/**
 * Whether the orchestrator may make a tool call. It never asks the user: the Mainbus read tools are allowed,
 * Read, Grep and Glob are allowed inside its own folder and the repo unless they name a credential file (the
 * role guard's checks), and everything else is denied.
 */
export function orchestratorVerdict(
  toolName: string,
  input: Record<string, unknown>,
  folders: { cwd: string; repo: string }
): PermissionVerdict {
  if (ORCHESTRATOR_READ_TOOLS.includes(toolName)) return { allow: true }
  if (!ORCHESTRATOR_BUILT_IN_TOOLS.includes(toolName)) return { allow: false, message: ORCHESTRATOR_DENIED }
  // For these tools the guard checks only for credential files and reads outside the folders.
  const reason = guardReason(toolName, input, { worktree: folders.cwd, additionalDirectories: [folders.repo], ownBranch: '' })
  return reason === null ? { allow: true } : { allow: false, message: `${reason.message}. ${ORCHESTRATOR_DENIED}` }
}

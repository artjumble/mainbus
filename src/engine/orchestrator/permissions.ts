import path from 'node:path'
import { guardReason } from '../permissions/guard'
import { ORCHESTRATOR_BUILT_IN_TOOLS, ORCHESTRATOR_MAINBUS_TOOLS } from '../runtime/sdkRuntime'
import type { PermissionVerdict } from '../runtime/types'
import { grepScope } from './grepScope'

export const ORCHESTRATOR_DENIED = 'The orchestrator only reads and proposes; it cannot do this.'

/**
 * Whether the orchestrator may make a tool call. It never asks the user: the Mainbus read and propose tools are
 * allowed, Read, Grep and Glob are allowed inside its own folder and the repo unless they could read a credential
 * file, and everything else is denied.
 */
export async function orchestratorVerdict(
  toolName: string,
  input: Record<string, unknown>,
  folders: { cwd: string; repo: string }
): Promise<PermissionVerdict> {
  if (ORCHESTRATOR_MAINBUS_TOOLS.includes(toolName)) return { allow: true }
  if (!ORCHESTRATOR_BUILT_IN_TOOLS.includes(toolName)) return { allow: false, message: ORCHESTRATOR_DENIED }
  // For these tools the guard checks only for credential files they name and reads outside the folders.
  const reason = guardReason(toolName, input, { worktree: folders.cwd, additionalDirectories: [folders.repo], ownBranch: '' })
  if (reason !== null) return { allow: false, message: `${reason.message}. ${ORCHESTRATOR_DENIED}` }
  if (toolName !== 'Grep') return { allow: true }

  // Grep reads the contents of every file it searches, hidden ones included, not just those it names.
  const root = typeof input.path === 'string' && input.path !== '' ? path.resolve(folders.cwd, input.path) : folders.cwd
  const glob = typeof input.glob === 'string' ? input.glob : undefined
  const scope = await grepScope(root, glob)
  if (scope === null) return { allow: true }
  const why =
    'tooLarge' in scope
      ? 'Mainbus could not check this folder for credential files: it is too large.'
      : `This search would read a credentials file: ${scope.credential}.`
  return {
    allow: false,
    message: `${why} Search a folder or file without one, or narrow the search with a glob such as "*.ts". ${ORCHESTRATOR_DENIED}`
  }
}

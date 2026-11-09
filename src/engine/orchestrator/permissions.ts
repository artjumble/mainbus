import path from 'node:path'
import { guardReason } from '../permissions/guard'
import { ORCHESTRATOR_BUILT_IN_TOOLS, ORCHESTRATOR_MAINBUS_TOOLS } from '../runtime/sdkRuntime'
import type { PermissionVerdict } from '../runtime/types'
import { grepScope } from './grepScope'
import { webFetchRefusal } from './webUrl'

export const ORCHESTRATOR_DENIED = 'The orchestrator only reads and proposes; it cannot do this.'
export const ORCHESTRATOR_WEB_OFF =
  "The user turned the orchestrator's web access off in Mainbus settings, so it can't read web pages or search."

/**
 * Whether the orchestrator may make a tool call. It never asks the user: the Mainbus read and propose tools are
 * allowed, Read, Grep and Glob are allowed inside its own folder and the readable ones (the repo and the ticket folders) unless they could read a credential
 * file, WebFetch and WebSearch are allowed (WebFetch only for public http and https URLs) while `web.allowed`, and
 * everything else is denied.
 */
export async function orchestratorVerdict(
  toolName: string,
  input: Record<string, unknown>,
  folders: { cwd: string; readable: string[] },
  web: { allowed: boolean } = { allowed: true }
): Promise<PermissionVerdict> {
  if (ORCHESTRATOR_MAINBUS_TOOLS.includes(toolName)) return { allow: true }
  if (!ORCHESTRATOR_BUILT_IN_TOOLS.includes(toolName)) return { allow: false, message: ORCHESTRATOR_DENIED }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    if (!web.allowed) return { allow: false, message: ORCHESTRATOR_WEB_OFF }
    const why = toolName === 'WebFetch' ? webFetchRefusal(input.url) : null
    return why === null ? { allow: true } : { allow: false, message: `${why} ${ORCHESTRATOR_DENIED}` }
  }
  // For these tools the guard checks only for credential files they name and reads outside the folders.
  const reason = guardReason(toolName, input, { worktree: folders.cwd, additionalDirectories: folders.readable, ownBranch: '' })
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

import type { BranchOption, WorkspaceBranches } from '../../shared/api'
import type { Workspace } from '../../shared/domain'
import type { GitRunner } from './git'

/** The branch checked out in the repository; null when HEAD is detached. */
export async function currentBranch(git: GitRunner, root: string): Promise<string | null> {
  const r = await git(['symbolic-ref', '--short', 'HEAD'], root)
  const name = r.stdout.trim()
  return r.code === 0 && name !== '' ? name : null
}

/** Whether the repository has a local branch of this name. */
export async function branchExists(git: GitRunner, root: string, name: string): Promise<boolean> {
  if (name === '' || name.startsWith('-')) return false
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], root)).code === 0
}

export async function hasOrigin(git: GitRunner, root: string): Promise<boolean> {
  return (await git(['remote', 'get-url', 'origin'], root)).code === 0
}

/** The local branches, sorted, each with whether origin has a remote-tracking branch of the same name. */
export async function listBranches(git: GitRunner, root: string): Promise<BranchOption[]> {
  const r = await git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], root)
  if (r.code !== 0) return []
  const local = new Set<string>()
  const remote = new Set<string>()
  for (const line of r.stdout.split(/\r?\n/)) {
    const ref = line.trim()
    if (ref.startsWith('refs/heads/')) local.add(ref.slice('refs/heads/'.length))
    else if (ref.startsWith('refs/remotes/origin/')) {
      const name = ref.slice('refs/remotes/origin/'.length)
      if (name !== 'HEAD') remote.add(name)
    }
  }
  return [...local].sort().map((name) => ({ name, onRemote: remote.has(name) }))
}

/**
 * The repository's default branch that exists locally: what origin/HEAD points at, else main, else master.
 * Null when none of them exists (the caller uses the checked-out branch).
 */
export async function defaultBranch(git: GitRunner, root: string): Promise<string | null> {
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root)
  const fromOrigin = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : ''
  if (fromOrigin !== '' && (await branchExists(git, root, fromOrigin))) return fromOrigin
  for (const name of ['main', 'master']) if (await branchExists(git, root, name)) return name
  return null
}

/** The branches to choose from for a workspace, and whether its base is on the remote (read from the local remote-tracking refs: no network). */
export async function workspaceBranches(git: GitRunner, ws: Pick<Workspace, 'repoPath' | 'baseBranch'>): Promise<WorkspaceBranches> {
  const [branches, def, remote] = await Promise.all([
    listBranches(git, ws.repoPath),
    defaultBranch(git, ws.repoPath),
    hasOrigin(git, ws.repoPath)
  ])
  const onRemote = (
    await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ws.baseBranch}`], ws.repoPath)
  ).code === 0
  return { baseBranch: ws.baseBranch, branches, defaultBranch: def, hasRemote: remote, baseOnRemote: onRemote }
}

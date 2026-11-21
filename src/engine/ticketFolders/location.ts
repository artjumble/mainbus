import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Workspace } from '../../shared/domain'
import { TICKET_FOLDERS_LOCATION_MAX } from '../../shared/domain'
import type { GitRunner } from '../git/git'
import { isInside } from '../intake/methods'

/** A ticket folder's path longer than this leaves little of Windows' 260 characters for node_modules and the like. */
export const LONG_TICKET_FOLDER = 100

export interface TicketFoldersLocationDeps {
  /** The data home: choosing it is the same as clearing the setting. */
  dataHome: string
  workspaces: Pick<Workspace, 'name' | 'slug' | 'repoPath'>[]
  git: GitRunner
  platform?: NodeJS.Platform
}

export interface CheckedLocation {
  /** The folder to store, resolved; null for the data home. */
  location: string | null
  /** A note for the user when the folder is allowed but not ideal. */
  warning: string | null
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** The folder itself, or the nearest folder above it that exists. */
async function nearestExisting(p: string): Promise<string> {
  let cur = p
  for (;;) {
    if (await exists(cur)) return cur
    const up = path.dirname(cur)
    if (up === cur) return cur
    cur = up
  }
}

/**
 * Checks the folder the user chose for the ticket folders: a full local path that is not inside a repository, that exists or can
 * be made, and that Mainbus can write to. Throws an Error whose message is for the user. Makes the folder when it is missing.
 */
export async function checkTicketFoldersLocation(input: unknown, deps: TicketFoldersLocationDeps): Promise<CheckedLocation> {
  const platform = deps.platform ?? process.platform
  const p = platform === 'win32' ? path.win32 : path.posix
  if (input !== null && typeof input !== 'string') throw new Error('The ticket folders location must be a folder path')
  const typed = (input ?? '').trim()
  if (typed === '') return { location: null, warning: null }
  if (typed.length > TICKET_FOLDERS_LOCATION_MAX) throw new Error(`The ticket folders location must be at most ${TICKET_FOLDERS_LOCATION_MAX} characters`)

  const local = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(typed) : p.isAbsolute(typed)
  if (!local) {
    throw new Error(
      `The ticket folders location must be a full path on a drive of this computer${platform === 'win32' ? ', such as D:\\mb' : ''}, not a relative or network path`
    )
  }
  let loc = p.resolve(typed)
  if (loc.length > p.parse(loc).root.length) loc = loc.replace(/[\\/]+$/, '')
  const same = (a: string, b: string): boolean => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (same(loc, p.resolve(deps.dataHome))) return { location: null, warning: null }

  for (const ws of deps.workspaces) {
    if (isInside(loc, ws.repoPath, platform) || isInside(ws.repoPath, loc, platform)) {
      throw new Error(`${loc} is inside the repository of ${ws.name} (${ws.repoPath}), or holds it. Choose a folder outside every repository.`)
    }
  }

  const probeDir = await nearestExisting(loc)
  const stat = await fs.stat(probeDir).catch(() => null)
  if (stat && !stat.isDirectory()) throw new Error(`${probeDir} is a file, not a folder. Choose a folder.`)
  const inRepo = await deps.git(['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], probeDir).catch(() => null)
  if (inRepo && (inRepo.stdout.split(/\r?\n/).some((l) => l.trim() === 'true') || /dubious ownership/i.test(inRepo.stderr))) {
    throw new Error(`${loc} is inside a git repository. Choose a folder outside every repository.`)
  }

  let created: string | undefined
  try {
    created = await fs.mkdir(loc, { recursive: true })
    const probe = path.join(loc, `.mainbus-write-check-${randomBytes(4).toString('hex')}`)
    await fs.writeFile(probe, '')
    await fs.unlink(probe)
  } catch (err) {
    if (created) await fs.rm(created, { recursive: true, force: true }).catch(() => {})
    throw new Error(`Mainbus can't write to ${loc}: ${err instanceof Error ? err.message : String(err)}`)
  }

  let warning: string | null = null
  if (platform === 'win32') {
    const longest = deps.workspaces.reduce((m, w) => (w.slug.length > m.length ? w.slug : m), 'my-workspace')
    const example = p.join(loc, 'work', longest, `1234-${'x'.repeat(16)}`)
    if (example.length > LONG_TICKET_FOLDER) {
      warning =
        `A typical ticket folder here would be ${example.length} characters long (${example}). Windows allows 260 for a whole path, ` +
        'and node_modules goes deeper. A short folder such as D:\\mb is better.'
    }
  }
  return { location: loc, warning }
}

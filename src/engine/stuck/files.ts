import fs from 'node:fs/promises'
import path from 'node:path'
import type { GitRunner } from '../git/git'
import { IGNORED_FOLDERS } from './config'

/** The walk stops after this many entries, so a huge worktree never makes a check slow. */
const MAX_ENTRIES = 50_000

/**
 * The newest modification time (ms since the epoch) of any file or folder under `root`, skipping the ignored
 * folders (dependencies, build output, caches); null when there is nothing there or it can't be read.
 * Symbolic links are not followed.
 */
export async function newestChange(root: string, ignored: ReadonlySet<string> = IGNORED_FOLDERS): Promise<number | null> {
  let newest: number | null = null
  let seen = 0
  const pending = [root]
  while (pending.length > 0 && seen < MAX_ENTRIES) {
    const dir = pending.pop()!
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue
      seen++
      const full = path.join(dir, entry.name)
      const stat = await fs.lstat(full).catch(() => null)
      if (stat === null) continue
      if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs
      if (entry.isDirectory()) pending.push(full)
    }
  }
  return newest
}

/** The commit the worktree's branch is at, or null when it can't be read. */
export async function headCommit(git: GitRunner, worktreePath: string): Promise<string | null> {
  try {
    const r = await git(['rev-parse', 'HEAD'], worktreePath)
    return r.code === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}

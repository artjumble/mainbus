import type { GitRunner } from './git'

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ChangedFile {
  kind: ChangeKind
  path: string
  /** The old path, for a rename. */
  from?: string
}

export interface BranchChanges {
  /** The ref the changes are measured against. */
  base: string
  files: ChangedFile[]
}

/** Parses `git diff --name-status -z` output. */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    if (!status) continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      const from = parts[i + 1] ?? ''
      const to = parts[i + 2] ?? ''
      i += 2
      // A copy is a new file.
      files.push(letter === 'R' ? { kind: 'renamed', path: to, from } : { kind: 'added', path: to })
      continue
    }
    const file = parts[i + 1] ?? ''
    i += 1
    if (letter === 'A') files.push({ kind: 'added', path: file })
    else if (letter === 'D') files.push({ kind: 'deleted', path: file })
    else files.push({ kind: 'modified', path: file })
  }
  return files
}

/**
 * The files the worktree's branch changes against `baseRef`, committed or not (untracked files count as added),
 * sorted by path. Null when there is no merge base. Never fetches.
 */
export async function branchChanges(git: GitRunner, wtPath: string, baseRef: string): Promise<BranchChanges | null> {
  const mb = await git(['merge-base', baseRef, 'HEAD'], wtPath)
  const sha = mb.stdout.trim()
  if (mb.code !== 0 || sha === '') return null
  const diff = await git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', sha, '--'], wtPath)
  if (diff.code !== 0) return null
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], wtPath)
  const files = parseNameStatus(diff.stdout)
  const seen = new Set(files.map((f) => f.path))
  if (untracked.code === 0) {
    for (const p of untracked.stdout.split('\0')) {
      if (p !== '' && !seen.has(p)) files.push({ kind: 'added', path: p })
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { base: baseRef, files }
}

import path from 'node:path'

const win = path.win32

/** Git Bash writes drive C: as /c/...; give it the Windows form. */
export function fromGitBash(p: string): string {
  const m = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(p)
  return m ? `${m[1].toUpperCase()}:${m[2] === '' ? '\\' : m[2]}` : p
}

export function isInside(resolved: string, roots: string[]): boolean {
  return roots.some((root) => {
    // win32.relative compares case-insensitively and across drives.
    const rel = win.relative(root, resolved)
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win.isAbsolute(rel))
  })
}

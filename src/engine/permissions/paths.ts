import path from 'node:path'

const win = path.win32
const posix = path.posix

/**
 * How the guard reads a path:
 * - win32: Windows rules, case-folded, with Git Bash `/c/...` mapped to `C:\...`;
 * - darwin: POSIX, case-folded (the default APFS is case-insensitive), no drive mapping;
 * - linux: POSIX, exact case, no drive mapping.
 */
export type PathStyle = 'win32' | 'darwin' | 'linux'

/** The style of the machine the guard runs on; any platform that is not Windows or macOS is treated as Linux. */
export function hostPathStyle(platform: NodeJS.Platform = process.platform): PathStyle {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
}

/** Git Bash writes drive C: as /c/...; give it the Windows form. */
export function fromGitBash(p: string): string {
  const m = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(p)
  return m ? `${m[1].toUpperCase()}:${m[2] === '' ? '\\' : m[2]}` : p
}

export interface PathRules {
  style: PathStyle
  /** Whether names that differ only in case are the same file. */
  foldsCase: boolean
  sep: '\\' | '/'
  /** The absolute, normalised form of `p` typed in a shell that is in `base`. Never touches the disk. */
  resolve(base: string, p: string): string
  isAbsolute(p: string): boolean
  /** Whether `resolved` is one of `roots` or below one. */
  isInside(resolved: string, roots: string[]): boolean
  /** The folder names from `root` down to `resolved` (which must be inside it). */
  segments(root: string, resolved: string): string[]
}

const fold = (s: string): string => s.normalize('NFC').toLowerCase()

function posixInside(resolved: string, roots: string[], fix: (s: string) => string): boolean {
  return roots.some((root) => {
    const rel = posix.relative(fix(root), fix(resolved))
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  })
}

const WIN32_RULES: PathRules = {
  style: 'win32',
  foldsCase: true,
  sep: '\\',
  resolve: (base, p) => win.resolve(base, fromGitBash(p)),
  isAbsolute: (p) => win.isAbsolute(p),
  isInside: (resolved, roots) =>
    roots.some((root) => {
      // win32.relative compares case-insensitively and across drives.
      const rel = win.relative(root, resolved)
      return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win.isAbsolute(rel))
    }),
  segments: (root, resolved) => win.relative(root, resolved).split('\\'),
}

const DARWIN_RULES: PathRules = {
  style: 'darwin',
  foldsCase: true,
  sep: '/',
  resolve: (base, p) => posix.resolve(base, p),
  isAbsolute: (p) => posix.isAbsolute(p),
  isInside: (resolved, roots) => posixInside(resolved, roots, fold),
  segments: (root, resolved) => posix.relative(fold(root), fold(resolved)).split('/'),
}

const LINUX_RULES: PathRules = {
  style: 'linux',
  foldsCase: false,
  sep: '/',
  resolve: (base, p) => posix.resolve(base, p),
  isAbsolute: (p) => posix.isAbsolute(p),
  isInside: (resolved, roots) => posixInside(resolved, roots, (s) => s),
  segments: (root, resolved) => posix.relative(root, resolved).split('/'),
}

export function pathRules(style: PathStyle): PathRules {
  return style === 'win32' ? WIN32_RULES : style === 'darwin' ? DARWIN_RULES : LINUX_RULES
}

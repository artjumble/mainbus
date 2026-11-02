import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isCredentialPath } from '../permissions/credentials'

/** A folder Mainbus would have to walk file by file stops counting here; a Grep over it is denied. */
export const WALK_LIMIT = 50_000

export type GrepScope = { credential: string } | { tooLarge: true } | null

/**
 * The files under `dir` that Grep (ripgrep, hidden files included) could search, relative to it with forward
 * slashes, or null when git can't list them. Tracked files and untracked ones that aren't ignored: a superset
 * of what ripgrep reads, since it skips what .gitignore names whether tracked or not.
 */
async function gitFiles(dir: string): Promise<string[] | null> {
  const git = (args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile('git', args, { cwd: dir, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout })
      )
    })
  // A folder git ignores lists nothing, but ripgrep searches a folder it is given: walk it instead.
  if ((await git(['check-ignore', '-q', '--', '.'])).code === 0) return null
  const listed = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return listed.code === 0 ? listed.stdout.split('\0').filter(Boolean) : null
}

/** Every file under `dir`, ignored ones included, without following links; null past WALK_LIMIT. */
async function walk(dir: string, prefix = '', seen = { n: 0 }): Promise<string[] | null> {
  const out: string[] = []
  let entries
  try {
    entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (++seen.n > WALK_LIMIT) return null
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      // ripgrep never searches git's own folder.
      if (e.name === '.git') continue
      const inner = await walk(dir, rel, seen)
      if (inner === null) return null
      out.push(...inner)
    } else {
      out.push(rel)
    }
  }
  return out
}

/** Splits a Grep glob into the globs ripgrep might read it as: the whole, and its comma or space separated parts. */
function globAlternatives(glob: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const c of glob) {
    if (c === '{') depth++
    if (c === '}') depth = Math.max(0, depth - 1)
    if (depth === 0 && (c === ',' || /\s/.test(c))) {
      parts.push(current)
      current = ''
    } else {
      current += c
    }
  }
  parts.push(current)
  return [...new Set([glob, ...parts].map((g) => g.trim()).filter(Boolean))]
}

/** Expands `{a,b}` braces, innermost first. */
function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob)
  if (!m) return [glob]
  return m[1]!.split(',').flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)))
}

/**
 * A regex that matches at least everything ripgrep's glob would: `*` crosses folders, a bracket class is any
 * character, and case is ignored.
 */
function looseGlob(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) out += '\\['
      else {
        out += '.'
        i = end
      }
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

/**
 * Whether the Grep `glob` could let ripgrep search `rel`. A glob is tried against the file's name and against
 * every tail of its path, so it matches wherever ripgrep's would. A negated glob (`!x`) narrows nothing.
 */
function globMayInclude(glob: string, rel: string): boolean {
  const alternatives = globAlternatives(glob.replace(/\\/g, '/'))
  if (alternatives.some((g) => g.startsWith('!'))) return true
  const segments = rel.split('/')
  const tails = segments.map((_, i) => segments.slice(i).join('/'))
  return alternatives
    .flatMap(expandBraces)
    .map((g) => looseGlob(g.replace(/^\/+/, '')))
    .some((re) => tails.some((t) => re.test(t)))
}

/**
 * Whether a Grep over `root` could read a credential file: the first one ripgrep could search there (after the
 * Grep's `glob`), `tooLarge` when the folder couldn't be checked, or null. A file root is left to the path checks.
 */
export async function grepScope(root: string, glob: string | undefined): Promise<GrepScope> {
  const stat = await fs.stat(root).catch(() => null)
  if (!stat?.isDirectory()) return null
  let files = await gitFiles(root)
  if (files !== null) {
    // An untracked folder git doesn't descend into (a nested repository) is listed with a trailing slash.
    const expanded: string[] = []
    for (const f of files) {
      if (!f.endsWith('/')) {
        expanded.push(f)
        continue
      }
      const inner = await walk(path.join(root, f))
      if (inner === null) return { tooLarge: true }
      expanded.push(...inner.map((i) => `${f}${i}`))
    }
    files = expanded
  } else {
    files = await walk(root)
    if (files === null) return { tooLarge: true }
  }
  const credential = files.find((f) => isCredentialPath(f) && (glob === undefined || glob === '' || globMayInclude(glob, f)))
  return credential === undefined ? null : { credential }
}

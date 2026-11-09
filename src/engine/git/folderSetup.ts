import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FolderReadiness, PrepareOptions, SetupPreview, SetupWarning } from '../../shared/api'
import { isCredentialPath } from '../permissions/credentials'
import type { GitRunner } from './git'

const GENERATED_FOLDERS = new Set(['node_modules', 'dist', 'build', '.venv', 'target'])
const LARGE_FILE_BYTES = 50 * 1024 * 1024
const STAT_BATCH = 64

export const DETACHED_SUGGESTION = 'Run git switch <branch> to go back to a branch, or git switch -c <name> to start one here.'

export const NO_IDENTITY_MESSAGE = [
  "Git doesn't know who you are, so it can't make the first commit. Run these two commands, then try again:",
  'git config --global user.name "Your Name"',
  'git config --global user.email "you@example.com"',
  '',
  'Mainbus never sets these for you.'
].join('\n')

/** Why a folder can't be a workspace yet, as the engine throws it; the renderer asks `workspace.check` instead. */
export class WorkspaceNotReadyError extends Error {
  constructor(
    readonly reason: Exclude<FolderReadiness['status'], 'ready'>,
    readonly folder: string,
    readonly root: string,
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceNotReadyError'
  }
}

/** The message `openWorkspace` gives for a folder that isn't ready. */
export function notReadyMessage(r: FolderReadiness): string {
  switch (r.status) {
    case 'not_a_repo':
      return `${r.folder} is not a git repository`
    case 'no_commits':
      return 'The repository has no commits yet.'
    case 'detached_head':
      return `Could not read the current branch of ${r.root}: HEAD is not on a branch. ${DETACHED_SUGGESTION}`
    case 'ready':
      return ''
  }
}

async function isFolder(folder: string): Promise<boolean> {
  return fs.stat(folder).then(
    (s) => s.isDirectory(),
    () => false
  )
}

/** Says whether the folder can open as a workspace, and if not, why. Throws for a missing folder or a git failure. */
export async function checkFolder(git: GitRunner, repoPath: string): Promise<FolderReadiness> {
  const folder = path.resolve(repoPath)
  if (!(await isFolder(folder))) throw new Error(`Folder does not exist: ${folder}`)

  // A subfolder opens its repository: the workspace is the repo root.
  const top = await git(['rev-parse', '--show-toplevel'], folder)
  if (top.code !== 0 || top.stdout.trim() === '') {
    const why = top.stderr.trim()
    if (/not a git repository/i.test(why)) return { status: 'not_a_repo', folder, root: folder }
    throw new Error(`Could not read the repository at ${folder}: ${why || 'git failed'}`)
  }
  const root = path.resolve(top.stdout.trim())
  if ((await git(['rev-parse', '--verify', 'HEAD'], root)).code !== 0) return { status: 'no_commits', folder, root }
  const head = await git(['symbolic-ref', '--short', 'HEAD'], root)
  if (head.code !== 0 || head.stdout.trim() === '') return { status: 'detached_head', folder, root }
  return { status: 'ready', folder, root }
}

/** The files `git add -A` would stage in the folder, as paths relative to `cwd`, without writing anything into it. */
async function listFiles(git: GitRunner, readiness: FolderReadiness): Promise<{ base: string; files: string[] }> {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
  const split = (out: string): string[] => out.split('\0').filter((f) => f !== '')
  if (readiness.status === 'no_commits') {
    const r = await git(args, readiness.root)
    if (r.code !== 0) throw new Error(`Could not list the files: ${r.stderr.trim()}`)
    return { base: readiness.root, files: split(r.stdout) }
  }
  // No repository yet: a scratch git dir stands in for it, so the folder itself is left as it is.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-preview-'))
  try {
    const init = await git(['init', '-q'], scratch)
    if (init.code !== 0) throw new Error(`Could not list the files: ${init.stderr.trim()}`)
    const r = await git(['--git-dir', path.join(scratch, '.git'), '--work-tree', readiness.folder, ...args], readiness.folder)
    if (r.code !== 0) throw new Error(`Could not list the files: ${r.stderr.trim()}`)
    return { base: readiness.folder, files: split(r.stdout) }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function sizes(base: string, files: string[]): Promise<number[]> {
  const out: number[] = new Array<number>(files.length).fill(0)
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    await Promise.all(
      files.slice(i, i + STAT_BATCH).map(async (f, j) => {
        out[i + j] = await fs.stat(path.join(base, f)).then(
          (s) => (s.isFile() ? s.size : 0),
          () => 0
        )
      })
    )
  }
  return out
}

/** What committing the folder's files would include, with what to look at twice. Changes nothing. */
export async function previewSetup(git: GitRunner, repoPath: string): Promise<SetupPreview> {
  const readiness = await checkFolder(git, repoPath)
  if (readiness.status !== 'not_a_repo' && readiness.status !== 'no_commits') {
    throw new Error('Only a folder without a repository, or a repository without commits, can be set up.')
  }
  const { base, files } = await listFiles(git, readiness)
  const bytes = await sizes(base, files)

  const entries = new Map<string, { name: string; folder: boolean; files: number; bytes: number }>()
  const generated = new Map<string, SetupWarning>()
  const warnings: SetupWarning[] = []
  let totalBytes = 0
  files.forEach((rel, i) => {
    const size = bytes[i]!
    totalBytes += size
    const segments = rel.split('/')
    const top = segments[0]!
    const entry = entries.get(top) ?? { name: top, folder: segments.length > 1, files: 0, bytes: 0 }
    entry.files += 1
    entry.bytes += size
    entries.set(top, entry)

    const g = segments.findIndex((s, idx) => idx < segments.length - 1 && GENERATED_FOLDERS.has(s))
    if (g >= 0) {
      const prefix = segments.slice(0, g + 1).join('/')
      const w = generated.get(prefix) ?? { kind: 'generated' as const, path: prefix, files: 0, bytes: 0 }
      w.files += 1
      w.bytes += size
      generated.set(prefix, w)
      return
    }
    if (isCredentialPath(rel)) warnings.push({ kind: 'secret', path: rel, files: 1, bytes: size })
    else if (size > LARGE_FILE_BYTES) warnings.push({ kind: 'large', path: rel, files: 1, bytes: size })
  })
  const order = { secret: 0, generated: 1, large: 2 }
  warnings.push(...generated.values())
  warnings.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path))
  return {
    root: readiness.root,
    files: files.length,
    bytes: totalBytes,
    entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings
  }
}

function ignoreLine(w: SetupWarning): string {
  const escaped = w.path.replace(/[\\#!*?[\]]/g, '\\$&').replace(/ +$/, (s) => s.replace(/ /g, '\\ '))
  return w.kind === 'generated' ? `/${escaped}/` : `/${escaped}`
}

async function appendGitignore(root: string, warnings: SetupWarning[]): Promise<void> {
  if (warnings.length === 0) return
  const file = path.join(root, '.gitignore')
  const existing = await fs.readFile(file, 'utf8').catch(() => '')
  const lead = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await fs.appendFile(file, `${lead}# Added by Mainbus\n${warnings.map(ignoreLine).join('\n')}\n`)
}

const IDENTITY_FAILURE = /tell me who you are|auto-detect email|no email was given|unable to auto-detect|empty ident/i

/**
 * Makes the folder ready after the user confirmed: `git init` when it isn't a repository, then a first commit of its
 * files or an empty one. Returns the repository root to open. Never touches a remote or git's configuration.
 */
export async function prepareFolder(git: GitRunner, repoPath: string, options: PrepareOptions): Promise<string> {
  const readiness = await checkFolder(git, repoPath)
  if (readiness.status === 'ready') return readiness.root
  if (readiness.status === 'detached_head') {
    throw new WorkspaceNotReadyError('detached_head', readiness.folder, readiness.root, notReadyMessage(readiness))
  }

  // Before anything changes: a missing identity must leave the folder as it was.
  for (const which of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    if ((await git(['var', which], readiness.folder)).code !== 0) throw new Error(NO_IDENTITY_MESSAGE)
  }

  let root = readiness.root
  if (readiness.status === 'not_a_repo') {
    const configured = await git(['config', '--get', 'init.defaultBranch'], readiness.folder)
    const branch = configured.code === 0 && configured.stdout.trim() !== '' ? configured.stdout.trim() : 'main'
    const init = await git(['init', '-b', branch], readiness.folder)
    if (init.code !== 0) throw new Error(`Could not set up git in ${readiness.folder}: ${init.stderr.trim()}`)
    root = readiness.folder
  }

  const fail = (what: string, stderr: string): Error =>
    new Error(IDENTITY_FAILURE.test(stderr) ? NO_IDENTITY_MESSAGE : `${what}: ${stderr.trim()}`)

  if (options.commitFiles) {
    if (options.writeGitignore === true) {
      const { warnings } = await previewSetup(git, root)
      await appendGitignore(root, warnings)
    }
    const add = await git(['add', '-A'], root)
    if (add.code !== 0) throw fail('Could not stage the files', add.stderr)
  }
  // `--only` keeps an empty commit empty even when files were staged before.
  const commit = await git(
    options.commitFiles
      ? ['commit', '--allow-empty', '-m', 'Initial commit']
      : ['commit', '--allow-empty', '--only', '-m', 'Initial commit'],
    root
  )
  if (commit.code !== 0) throw fail('Could not make the first commit', commit.stderr)
  return root
}

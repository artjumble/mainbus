import fs from 'node:fs'
import path from 'node:path'
import { credentialReason, NAMED_PATH, ntfsName, readArguments } from './credentials'
import { type Download, DOWNLOAD_COMMANDS, readDownload } from './downloads'
import { inPlaceFiles } from './interpreters'
import { commandOf, isShellTool } from './policy'
import { fromGitBash, isInside } from './paths'
import {
  CD_COMMANDS,
  commandName,
  isDestructivePushArgs,
  parseGit,
  parseShellDetailed,
  type ShellVars,
  type SimpleCommand,
} from './shell'

/** The folders an agent may work in: the ticket's worktree and any extra ones. */
export interface FolderContext {
  worktree: string
  additionalDirectories: string[]
  /**
   * The ticket's scratch folder, which TEMP, TMP and TMPDIR name in the agent's shells. It is inside only when
   * it is also one of `additionalDirectories`. Absent in tests and in runs from before scratch folders.
   */
  scratch?: string
  /**
   * The folder the agent's shell is in when the command runs (Claude Code keeps it between calls). Relative paths
   * start here; the worktree when absent or not absolute.
   */
  cwd?: string
}

export interface GuardContext extends FolderContext {
  ownBranch: string
  /** Whether a folder exists (the real file system when absent); a `cd` into one that does is taken to work. */
  exists?: (folder: string) => boolean
}

function folderExists(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory()
  } catch {
    return false
  }
}

/**
 * The context of one shell command: `bases` are the folders it may be in (a path is inside only if it is from every
 * one), `inLoop` that a loop that is not repeated word by word encloses it.
 */
type Where = { bases?: string[]; inLoop?: boolean; dialect?: 'bash' | 'powershell' }
type Ctx = GuardContext & Where

/**
 * How unattended mode treats a reason. A hard stop opens a card and waits for the user; an automatic reason
 * is allowed without one while unattended mode is on (and opens a card as usual when it is off).
 */
export type GuardKind = 'hard_stop' | 'automatic'

export interface GuardReason {
  kind: GuardKind
  /** A short human sentence: why Mainbus asks first. */
  message: string
}

/**
 * The reasons unattended mode allows on its own, by how the sentence starts. Everything else is a hard stop,
 * including any reason added later that is not listed here. The hard stops today:
 * - pushes: "Force-pushes to a remote", "Pushes commits to a remote";
 * - credentials: "Reads a credentials file", "Prints credentials";
 * - leaving the worktree: "Writes outside the ticket's folder", "Runs in a folder outside the ticket's folder",
 *   "Leaves the ticket's folder" (downloads that write outside give the first);
 * - code that later runs in the user's own environment: "Touches the .claude folder in the home directory",
 *   "Changes agent or git settings", and "Runs inside agent or git settings" (a runner option such as
 *   `pnpm -C .claude`; it came with the runner checks and is classified with the settings writes);
 * - the shared repository beyond the ticket's branch: "Deletes a branch other than the ticket's own",
 *   "Renames a branch", "Changes repository internals with git …", "Deletes stashed work" (the stash is
 *   shared with the main checkout), "Permanently prunes git objects", "Deletes git reflog entries",
 *   "Changes git config", "Changes npm config".
 */
const AUTOMATIC: readonly string[] = [
  "Runs a command Mainbus can't check",
  "Downloads with options from a file Mainbus can't check",
  // Discarding work inside the ticket's own worktree.
  'Discards uncommitted work with git reset --hard',
  'Deletes untracked files with git clean',
  'Discards file changes with git checkout',
  'Discards file changes with git restore',
  'Discards changes with git switch',
  'Overrides git alias or core settings for one command',
  // A credential file gives "Reads a credentials file" instead, which is checked first.
  "Reads outside the ticket's folder",
]

/** The kind of a guard sentence; anything not known to be automatic is a hard stop. */
export function kindOf(message: string): GuardKind {
  return AUTOMATIC.some((a) => message === a || message.startsWith(`${a}:`)) ? 'automatic' : 'hard_stop'
}

/** The first hard stop among `messages`, else the first automatic one. Stops looking at the first hard stop. */
function pick(messages: Iterable<string>): GuardReason | null {
  let automatic: string | null = null
  for (const message of messages) {
    if (kindOf(message) === 'hard_stop') return { kind: 'hard_stop', message }
    automatic ??= message
  }
  return automatic === null ? null : { kind: 'automatic', message: automatic }
}

const win = path.win32

const FILE_PATH_KEY: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

const COPY_COMMANDS = new Set(['cp', 'copy', 'copy-item', 'cpi'])
// Their arguments can be cmd.exe switches such as /s /q.
const CMD_SWITCH_COMMANDS = new Set(['del', 'erase', 'rd', 'rmdir', 'move', 'copy', 'mklink'])
const WRITE_COMMANDS = new Set([
  ...['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'mv', 'move', 'move-item'],
  ...['cp', 'copy', 'copy-item', 'cpi', 'rename-item', 'new-item', 'ni', 'out-file', 'set-content'],
  ...['add-content', 'sc', 'ac', 'tee', 'tee-object', 'mklink', 'new-symlink', 'ln', 'touch'],
  ...['mkdir', 'md', 'truncate', 'dd'],
  // PowerShell aliases that are not Verb-Noun.
  ...['clc', 'cli', 'clp', 'sp', 'si', 'rp', 'rni', 'ren', 'mi', 'cpp', 'epcsv', 'epal'],
])
const FOLDER_COMMANDS = new Set([...CD_COMMANDS, 'popd', 'pop-location'])

// `~`, `$anything` and `%VAR%` point somewhere we cannot resolve: treat as outside.
// PowerShell registry and similar provider paths are not files in the worktree either.
const HOME_OR_VARIABLE = /^(~(?=$|[\\/])|\$|%[^%]+%|(?:[\w.]+\\)?(?:HK(?:CU|LM|CR|U|CC)|Registry|Env|Cert|WSMan):)/i
// FileSystem::C:\x (optionally module-qualified) is just C:\x.
const FILESYSTEM_PROVIDER = /^(?:[\w.]+\\)?FileSystem::/i
// A variable read in the middle of a path: its value is not known either.
const VARIABLE_ANYWHERE = /\$[\w{]|\$env:|%\w+%/i
const HOME_FORM = /~|\$\{?HOME\}?|\$env:(?:HOME|USERPROFILE)|%(?:USERPROFILE|HOMEPATH|HOMEDRIVE)%/i
const CLAUDE_WORD = /\.claude(?![\w-])/i
const CLAUDE_SEGMENT = /(?:^|\\)\.claude(?:\\|$)/i
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|[\\/])/
// The only places outside the worktree a command may name without a card are the null device
// and the standard streams. Program paths (`"C:\Program Files\nodejs\node.exe" x`) are the command
// itself, not an argument, so npm, node and git installs found through PATH need no exemption.
const NULL_TARGET = /^(\/dev\/(null|stdin|stdout|stderr)|nul|\$null)$/i
const CLIMBS_OUT = /(?:^|[\\/])\.\.(?:[\\/]|$)/
// PowerShell automatic variables and shell special parameters hold values, not paths.
const VALUE_VARIABLE = /^\$(?:true|false|_|psitem|lastexitcode|args|input|matches|pwd|[?#@*!$0-9-])$/i
const BARE_VARIABLE = /^(?:\$\{?\w+\}?|%\w+%)$/
// Claude Code saves long tool output under ~/.claude/projects/<project>/.../tool-results and tells the
// agent to Read it there; that is the agent's own output, so Read may open it without a card.
const TOOL_RESULTS = /\\\.claude\\projects\\.+\\tool-results\\[^\\]+$/i

// Folders and files that the next agent session or a git hook will load or execute.
const CONFIG_DIRECTORIES = new Set(['.claude', '.git', '.husky'])
const CONFIG_FILES = new Set(['.mcp.json', '.gitmodules', '.gitattributes'])

function isAgentConfigPath(segments: string[]): boolean {
  const lower = segments.map((s) => ntfsName(s).toLowerCase())
  const last = lower[lower.length - 1] ?? ''
  return (
    lower.some((s) => CONFIG_DIRECTORIES.has(s)) ||
    CONFIG_FILES.has(last) ||
    (last === 'tasks.json' && lower[lower.length - 2] === '.vscode')
  )
}

// Read-only PowerShell verbs; any other Verb-Noun command is treated as a write.
const READ_ONLY_VERBS = new Set(
  ['get', 'test', 'select', 'where', 'measure', 'format', 'sort', 'group', 'compare', 'resolve'].concat(
    ['find', 'show', 'convertto', 'convertfrom', 'join', 'split', 'read'],
  ),
)
const READ_ONLY_CMDLETS = new Set(
  ['out-string', 'out-host', 'out-null', 'write-output', 'write-host', 'write-verbose'].concat(
    ['write-error', 'write-warning', 'write-information'],
  ),
)

function isWriteCommand(name: string): boolean {
  if (WRITE_COMMANDS.has(name)) return true
  const verbNoun = /^([a-z]+)-[a-z][a-z0-9]*$/.exec(name)
  return verbNoun !== null && !READ_ONLY_VERBS.has(verbNoun[1]) && !READ_ONLY_CMDLETS.has(name)
}

interface Located {
  shown: string
  inside: boolean
  /** Folder names from the allowed root down to the target. */
  segments: string[]
}

function locate(rawPath: string, ctx: FolderContext & Where): Located {
  const p = rawPath.replace(FILESYSTEM_PROVIDER, '')
  if (HOME_OR_VARIABLE.test(p) || VARIABLE_ANYWHERE.test(p)) return { shown: p, inside: false, segments: [] }
  const roots = [ctx.worktree, ...ctx.additionalDirectories]
  const places = (ctx.bases ?? [ctx.cwd ?? ctx.worktree]).map((base): Located => {
    const resolved = win.resolve(base, fromGitBash(p))
    const root = roots.find((r) => isInside(resolved, [r]))
    return {
      shown: resolved,
      inside: root !== undefined,
      segments: root === undefined ? [] : win.relative(root, resolved).split('\\'),
    }
  })
  // Outside from any of the folders the command may be in is outside.
  return places.find((l) => !l.inside) ?? places.find((l) => isAgentConfigPath(l.segments)) ?? places[0]
}

/** The folder a cd-like command (argv[0] is cd, Set-Location, ...) names, if any; `-` for `cd -`. */
function cdTarget(argv: string[]): string | undefined {
  return argv
    .slice(1)
    .map((a) => NAMED_PATH.exec(a)?.[1] ?? a)
    .find((a) => a === '-' || !isFlag(a))
}

/**
 * True when `argv` is a cd (or chdir, pushd, Set-Location, ...) into the ticket's folder or a folder inside it,
 * resolved as the guard resolves every path. A bare `cd`, which goes home, and `cd -` are not.
 */
export function isCdInside(argv: string[], context: FolderContext): boolean {
  if (!CD_COMMANDS.has(commandName(argv[0] ?? ''))) return false
  const target = cdTarget(argv)
  return target !== undefined && target !== '-' && !target.startsWith('~') && locate(target, usable(context)).inside
}

type Destination = { to: 'path'; value: string } | { to: 'previous' | 'home' | 'stay' | 'unknown' }

/** Where a cd-like command goes, as far as it can be told. */
function destination(cmd: SimpleCommand, dialect: 'bash' | 'powershell'): Destination {
  if (!CD_COMMANDS.has(cmd.name)) return { to: 'unknown' } // popd, Pop-Location
  const target = cdTarget(cmd.argv)
  if (target === '-') return { to: 'previous' }
  if (target?.startsWith('~')) return { to: 'home' }
  if (target !== undefined) return { to: 'path', value: target }
  if (cmd.name === 'pushd') return { to: 'unknown' }
  // A bare `cd` goes home in Bash; PowerShell stays where it is.
  return dialect === 'bash' && (cmd.name === 'cd' || cmd.name === 'chdir') ? { to: 'home' } : { to: 'stay' }
}

/** Reason to ask before writing to this path, or null. */
function writeTargetReason(p: string, ctx: Ctx): string | null {
  const { shown, inside, segments } = locate(p, ctx)
  if (!inside) return `Writes outside the ticket's folder: ${shown}`
  if (isAgentConfigPath(segments)) return `Changes agent or git settings: ${shown}`
  return null
}

function isFlag(a: string): boolean {
  return a.startsWith('-')
}

/** Reasons to ask before a downloader runs. */
function* downloadReasons(d: Download, ctx: Ctx): Generator<string> {
  if (d.config) yield `Downloads with options from a file Mainbus can't check`
  if (!d.writes) return
  // A positional `$URL` is a URL, but an absolute or home path there means an option was misread.
  const paths = d.positional.filter((a) => !a.includes('://') && (ABSOLUTE.test(a) || HOME_FORM.test(a)))
  // `-` is standard output.
  const reason = firstReason([...d.targets, ...paths].filter((t) => t !== '-'), ctx)
  if (reason) yield reason
}

/** A folder a runner option makes the command run in behaves like `cd`. */
function folderReason(dir: string, ctx: Ctx): string | null {
  const { shown, inside, segments } = locate(dir, ctx)
  if (!inside) return `Runs in a folder outside the ticket's folder: ${shown}`
  return isAgentConfigPath(segments) ? `Runs inside agent or git settings: ${shown}` : null
}

/** Path arguments of a write command; `destination` is the one a copy writes to. */
function pathArguments(cmd: SimpleCommand): string[] {
  const args = cmd.argv.slice(1)
  if (cmd.name === 'dd') return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3))
  const positional: string[] = []
  let destination: string | undefined
  let named = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const attached = NAMED_PATH.exec(a)
    if (attached) {
      if (/^-destination:/i.test(a)) destination = attached[1]
      else {
        named = true
        positional.push(attached[1])
      }
    } else if (/^-destination$/i.test(a) && args[i + 1] !== undefined) {
      destination = args[++i]
    } else if (isFlag(a) || (CMD_SWITCH_COMMANDS.has(cmd.name) && /^\/[a-z](:.*)?$/i.test(a))) {
      continue
    } else {
      positional.push(a)
    }
  }
  if (COPY_COMMANDS.has(cmd.name)) {
    const target = destination ?? (named ? undefined : positional[positional.length - 1])
    return target === undefined ? [] : [target]
  }
  return destination === undefined ? positional : [...positional, destination]
}

function gitConfigWrites(rest: string[]): boolean {
  const readFlags = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool']
  if (rest.some((a) => readFlags.includes(a))) return false
  const writeFlags = ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit']
  if (rest.some((a) => writeFlags.includes(a))) return true
  const valueFlags = ['--file', '-f', '--blob', '--default', '--type']
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (valueFlags.includes(rest[i])) i++
    else if (!isFlag(rest[i])) positional.push(rest[i])
  }
  if (['get', 'list'].includes(positional[0])) return false
  if (['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(positional[0])) return true
  return positional.length >= 2 // key value
}

function checkoutDiscards(rest: string[]): boolean {
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--' || a === '-f' || a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) return true
    if (['-b', '-B', '--orphan'].includes(a)) i++
    else if (!isFlag(a)) positional.push(a)
  }
  // `.`, wildcards, ./x, :(magic), or an extension look like pathspecs; so do two or more names.
  return positional.length >= 2 || positional.some((a) => /^(\.|:)|[*?[]|\.[A-Za-z][A-Za-z0-9]*$/.test(a))
}

function branchReason(rest: string[], ctx: GuardContext): string | null {
  const letters = new Set(rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).flatMap((a) => [...a.slice(1)]))
  const has = (long: string): boolean => rest.includes(long)
  const force = letters.has('f') || has('--force')
  const del = letters.has('D') || ((letters.has('d') || has('--delete')) && force)
  const rename = letters.has('M') || letters.has('m') || has('--move')
  if (!del && !rename) return null
  if (rename) return 'Renames a branch'
  const other = rest.find((a) => !isFlag(a) && a !== ctx.ownBranch)
  return other === undefined ? null : `Deletes a branch other than the ticket's own: ${other}`
}

function* gitReasons(cmd: SimpleCommand, ctx: GuardContext): Generator<string> {
  const git = parseGit(cmd.argv)
  if (!git) return
  if (git.configs.some((c) => /^(alias|core)\./i.test(c))) yield 'Overrides git alias or core settings for one command'
  const reason = gitSubcommandReason(git.sub, git.rest, ctx)
  if (reason) yield reason
}

function gitSubcommandReason(sub: string | undefined, rest: string[], ctx: GuardContext): string | null {
  switch (sub) {
    case 'push':
      return isDestructivePushArgs(rest) ? 'Force-pushes to a remote' : 'Pushes commits to a remote'
    case 'reset':
      return rest.includes('--hard') ? 'Discards uncommitted work with git reset --hard' : null
    case 'clean':
      return rest.some((a) => a === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))
        ? null
        : 'Deletes untracked files with git clean'
    case 'checkout':
      return checkoutDiscards(rest) ? 'Discards file changes with git checkout' : null
    case 'restore':
      return 'Discards file changes with git restore'
    case 'switch':
      return rest.some((a) => ['-f', '--force', '--discard-changes'].includes(a)) ? 'Discards changes with git switch' : null
    case 'branch':
      return branchReason(rest, ctx)
    case 'stash':
      return ['drop', 'clear'].includes(rest[0]) ? 'Deletes stashed work' : null
    case 'gc':
      return rest.some((a) => a.startsWith('--prune')) ? 'Permanently prunes git objects' : null
    case 'reflog':
      return ['expire', 'delete'].includes(rest[0]) ? 'Deletes git reflog entries' : null
    case 'worktree':
      return rest[0] === 'list' ? null : 'Changes repository internals with git worktree'
    case 'update-ref':
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      return `Changes repository internals with git ${sub}`
    case 'config':
      return gitConfigWrites(rest) ? 'Changes git config' : null
    default:
      return null
  }
}

function packageManagerReason(cmd: SimpleCommand): string | null {
  if (!['npm', 'pnpm', 'yarn'].includes(cmd.name)) return null
  const [first, second] = cmd.argv.slice(1).filter((a) => !isFlag(a))
  return first === 'config' && ['set', 'delete', 'edit'].includes(second) ? 'Changes npm config' : null
}

function firstReason(paths: string[], ctx: Ctx): string | null {
  for (const p of paths) {
    if (NULL_TARGET.test(p)) continue
    const reason = writeTargetReason(p, ctx)
    if (reason) return reason
  }
  return null
}

function* commandReasons(cmd: SimpleCommand, ctx: Ctx): Generator<string> {
  for (const dir of cmd.dirs ?? []) {
    const reason = folderReason(dir, ctx)
    if (reason) yield reason
  }
  yield* gitReasons(cmd, ctx)
  const npm = packageManagerReason(cmd)
  if (npm) yield npm
  const download = readDownload(cmd.name, cmd.argv.slice(1))
  if (download) {
    yield* downloadReasons(download, ctx)
    const redirect = firstReason(cmd.redirects, ctx)
    if (redirect) yield redirect
    return
  }
  if (FOLDER_COMMANDS.has(cmd.name)) {
    const dest = destination(cmd, ctx.dialect ?? 'bash')
    if (dest.to === 'path') {
      const { shown, inside } = locate(dest.value, ctx)
      // In a loop, each round starts where the last ended, so a cd that climbs can walk out.
      if (!inside || (ctx.inLoop && CLIMBS_OUT.test(dest.value))) yield `Leaves the ticket's folder: ${shown}`
    } else if (dest.to === 'home') {
      yield "Leaves the ticket's folder: ~"
    } else if (ctx.inLoop && dest.to !== 'stay') {
      yield `Leaves the ticket's folder: ${cmd.argv.join(' ')}`
    }
  }
  const written = isWriteCommand(cmd.name) ? pathArguments(cmd) : []
  const edited = inPlaceFiles(cmd.name, cmd.argv.slice(1)) ?? []
  const reason = firstReason([...written, ...edited, ...cmd.redirects], ctx)
  if (reason) yield reason
}

/**
 * A path-looking argument (absolute, home, variable, or climbing out with ..) that is not inside the
 * allowed folders. `reading` looks only at the words a command reads files through (readArguments);
 * otherwise every argument counts, since a pipe can hand any of them to a write command.
 */
function outsidePathIn(cmds: SimpleCommand[], ctx: Ctx, reading = false): string | null {
  for (const cmd of cmds) {
    for (const a of reading ? readArguments(cmd) : [...cmd.argv.slice(1), ...cmd.redirects]) {
      const value = (NAMED_PATH.exec(a)?.[1] ?? a).replace(FILESYSTEM_PROVIDER, '')
      if (isFlag(value) || NULL_TARGET.test(value) || VALUE_VARIABLE.test(value)) continue
      // A downloader's bare `$URL` is the address it fetches.
      if (reading && DOWNLOAD_COMMANDS.has(cmd.name) && BARE_VARIABLE.test(value)) continue
      const variable = HOME_OR_VARIABLE.test(value) || (!reading && VARIABLE_ANYWHERE.test(value))
      if (!variable && !ABSOLUTE.test(value) && !CLIMBS_OUT.test(value)) continue
      const { shown, inside } = locate(value, ctx)
      if (!inside) return shown
    }
  }
  return null
}

function touchesClaudeFolder(command: string, cmds: SimpleCommand[], ctx: Ctx): boolean {
  if (HOME_FORM.test(command) && CLAUDE_WORD.test(command)) return true
  return cmds.some((cmd) =>
    cmd.argv.slice(1).some((a) => {
      if (!ABSOLUTE.test(a)) return false
      const { shown, inside } = locate(a, ctx)
      return !inside && CLAUDE_SEGMENT.test(shown)
    }),
  )
}

// The names of the variables that mean the scratch folder, per shell.
const BASH_TEMP = ['TEMP', 'TMP', 'TMPDIR']
const POWERSHELL_TEMP = ['env:temp', 'env:tmp', 'env:tmpdir']

/** True when this folder is inside the folders the agent may work in, and not in agent settings. */
function plainFolder(folder: string, ctx: GuardContext): boolean {
  const root = [ctx.worktree, ...ctx.additionalDirectories].find((r) => isInside(folder, [r]))
  return root !== undefined && !isAgentConfigPath(win.relative(root, folder).split('\\'))
}

/**
 * The variables a shell command may read: TEMP, TMP and TMPDIR name the scratch folder (childEnv points them there),
 * PWD the folder the shell starts in. A scratch folder with wildcards would glob, and one with a `$` would not stay a
 * plain value. `%TEMP%` is expanded by neither shell: it is a relative path, which lands in the folder the command
 * runs in, so it counts as the scratch folder only while that is plainly inside the folders the agent may use.
 */
function initialVars(dialect: 'bash' | 'powershell', ctx: GuardContext, start: string): ShellVars {
  const known = new Map<string, string>()
  known.set(dialect === 'bash' ? 'PWD' : 'pwd', start)
  let percent: string | undefined
  const scratch = ctx.scratch
  if (scratch !== undefined && !/[*?[\]$]/.test(scratch)) {
    for (const name of dialect === 'bash' ? BASH_TEMP : POWERSHELL_TEMP) known.set(name, scratch)
    if (plainFolder(start, ctx)) percent = scratch
  }
  return { dialect, known, ...(percent !== undefined ? { percent } : {}) }
}

/** The folders a statement that changes folder leaves the shell in, or null when that cannot be told. */
function movedTo(dest: Destination, bases: string[], previous: string[] | undefined): string[] | null {
  switch (dest.to) {
    case 'stay':
      return bases
    case 'previous':
      return previous ?? null
    case 'path': {
      const value = dest.value.replace(FILESYSTEM_PROVIDER, '')
      if (HOME_OR_VARIABLE.test(value) || VARIABLE_ANYWHERE.test(value)) return null
      const moved = [...new Set(bases.map((b) => win.resolve(b, fromGitBash(value))))]
      return moved.length > 8 ? null : moved
    }
    default:
      return null
  }
}

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])]

/**
 * Every reason to ask before a shell command, in order. `pick` stops at the first hard stop, so an automatic
 * reason early on (git reset --hard) never hides a hard stop later in the command (git push).
 */
function* shellReasons(toolName: string, command: string, context: GuardContext): Generator<string> {
  const dialect = toolName === 'PowerShell' ? 'powershell' : 'bash'
  const start = context.cwd ?? context.worktree
  const parsed = parseShellDetailed(command, initialVars(dialect, context, start))
  if (parsed.opaque) {
    yield `Runs a command Mainbus can't check: ${parsed.why}`
    return
  }
  const secret = credentialReason('Bash', { command }, { worktree: context.worktree, cwd: start })
  if (secret) yield secret
  if (touchesClaudeFolder(command, parsed.pipelines.flat(), { ...context, dialect, bases: [start] })) {
    yield 'Touches the .claude folder in the home directory'
  }
  // Where the shell is, statement by statement: every folder it can be in at that point. When that cannot be
  // told, the folders a command would be judged from without any of this: the worktree and where the shell started.
  const unknown = [...new Set([context.worktree, start])]
  let bases = [start]
  let previous: string[] | undefined
  // Where the shell is after the right side of `cd x || exit 1` has run.
  let pending: string[] | null = null
  const exists = context.exists ?? folderExists
  let read: string | null = null
  for (const [i, pipeline] of parsed.pipelines.entries()) {
    const ctx: Ctx = { ...context, dialect, bases, inLoop: parsed.loops[i] > 0 }
    for (const cmd of pipeline) yield* commandReasons(cmd, ctx)
    // `Get-ChildItem C:\x | Remove-Item`: the path reaches the write command through the pipe.
    const pathless = pipeline.some((c) => isWriteCommand(c.name) && pathArguments(c).length === 0)
    const outside = pathless ? outsidePathIn(pipeline, ctx) : null
    if (outside) yield `Writes outside the ticket's folder: ${outside}`
    read ??= outsidePathIn(pipeline, ctx, true)

    const changers = pipeline.filter((c) => FOLDER_COMMANDS.has(c.name))
    const next = parsed.joins[i + 1]
    if (changers.length === 0) {
      if (pending !== null && next !== '||') {
        bases = pending
        pending = null
      }
      continue
    }
    // A cd in a pipe or in an `if` may or may not have happened.
    const single = pipeline.length === 1 && !parsed.compound[i] && changers.length === 1
    const moved = single ? movedTo(destination(changers[0], dialect), bases, previous) : null
    const after = moved ?? unknown
    // Whatever runs regardless of the cd: where it went if the folder is there to go to, else either place.
    const settled = moved !== null && moved.every(exists) ? moved : union(after, bases)
    previous = bases
    pending = null
    // `a && cd x && b` runs b in x; `a || cd x` may have skipped the cd; `cd x || b` runs b only when the cd failed.
    if (next === '&&') bases = parsed.joins[i] === '||' ? union(after, bases) : after
    else if (next === '||') pending = settled
    else bases = settled
  }
  if (read !== null) yield `Reads outside the ticket's folder: ${read}`
}

/** Inputs of the read-only file tools that name where they read. */
const READ_PATH_KEYS: Record<string, string[]> = {
  Read: ['file_path'],
  NotebookRead: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path', 'pattern'],
}

function toolReadReason(toolName: string, input: Record<string, unknown>, ctx: GuardContext): string | null {
  for (const key of READ_PATH_KEYS[toolName]) {
    const p = input[key]
    if (typeof p !== 'string' || p === '') continue
    // A Glob pattern is relative to its path unless it is rooted itself.
    if (key === 'pattern' && !ABSOLUTE.test(p) && !HOME_OR_VARIABLE.test(p) && !CLIMBS_OUT.test(p)) continue
    const { shown, inside } = locate(p, ctx)
    if (!inside && !(toolName === 'Read' && TOOL_RESULTS.test(shown))) return `Reads outside the ticket's folder: ${shown}`
  }
  return null
}

/** Why Mainbus should ask first, and whether unattended mode may allow it anyway; null means no opinion. */
export function guardReason(toolName: string, input: Record<string, unknown>, context: GuardContext): GuardReason | null {
  return pick(reasonsFor(toolName, input, usable(context)))
}

/** Relative or empty extra folders (and scratch folder) would resolve against the process cwd: drop them. */
function usable<T extends FolderContext>(context: T): T {
  const { scratch, cwd, ...rest } = context
  const folders = { ...rest, additionalDirectories: context.additionalDirectories.filter((d) => d !== '' && win.isAbsolute(d)) }
  return {
    ...folders,
    ...(scratch !== undefined && scratch !== '' && win.isAbsolute(scratch) ? { scratch } : {}),
    ...(cwd !== undefined && win.isAbsolute(cwd) ? { cwd } : {}),
  } as T
}

function* reasonsFor(toolName: string, input: Record<string, unknown>, ctx: GuardContext): Generator<string> {
  if (Object.hasOwn(READ_PATH_KEYS, toolName)) {
    const reason = credentialReason(toolName, input, { worktree: ctx.worktree, cwd: ctx.cwd }) ?? toolReadReason(toolName, input, ctx)
    if (reason) yield reason
    return
  }
  const key = FILE_PATH_KEY[toolName]
  if (key) {
    const p = input[key]
    const reason = typeof p === 'string' && p !== '' ? writeTargetReason(p, ctx) : null
    if (reason) yield reason
    return
  }
  if (isShellTool(toolName)) {
    const command = commandOf(input)
    if (command !== null) yield* shellReasons(toolName, command, ctx)
  }
}

import path from 'node:path'
import { credentialReason, NAMED_PATH, ntfsName, readArguments } from './credentials'
import { type Download, DOWNLOAD_COMMANDS, readDownload } from './downloads'
import { inPlaceFiles } from './interpreters'
import { commandOf, isShellTool } from './policy'
import { commandName, isDestructivePushArgs, parseGit, parseShell, type SimpleCommand } from './shell'

/** The folders an agent may work in: the ticket's worktree and any extra ones. */
export interface FolderContext {
  worktree: string
  additionalDirectories: string[]
}

export interface GuardContext extends FolderContext {
  ownBranch: string
}

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
const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])

// `~`, `$anything` and `%VAR%` point somewhere we cannot resolve: treat as outside.
// PowerShell registry and similar provider paths are not files in the worktree either.
const HOME_OR_VARIABLE = /^(~(?=$|[\\/])|\$|%[^%]+%|(?:[\w.]+\\)?(?:HK(?:CU|LM|CR|U|CC)|Registry|Env|Cert|WSMan):)/i
// FileSystem::C:\x (optionally module-qualified) is just C:\x.
const FILESYSTEM_PROVIDER = /^(?:[\w.]+\\)?FileSystem::/i
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

/** Git Bash writes drive C: as /c/...; give it the Windows form. */
function fromGitBash(p: string): string {
  const m = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(p)
  return m ? `${m[1].toUpperCase()}:${m[2] === '' ? '\\' : m[2]}` : p
}

function isInside(resolved: string, roots: string[]): boolean {
  return roots.some((root) => {
    // win32.relative compares case-insensitively and across drives.
    const rel = win.relative(root, resolved)
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win.isAbsolute(rel))
  })
}

interface Located {
  shown: string
  inside: boolean
  /** Folder names from the allowed root down to the target. */
  segments: string[]
}

function locate(rawPath: string, ctx: FolderContext): Located {
  const p = rawPath.replace(FILESYSTEM_PROVIDER, '')
  if (HOME_OR_VARIABLE.test(p)) return { shown: p, inside: false, segments: [] }
  const resolved = win.resolve(ctx.worktree, fromGitBash(p))
  const root = [ctx.worktree, ...ctx.additionalDirectories].find((r) => isInside(resolved, [r]))
  return {
    shown: resolved,
    inside: root !== undefined,
    segments: root === undefined ? [] : win.relative(root, resolved).split('\\'),
  }
}

/** The folder a cd-like command (argv[0] is cd, Set-Location, ...) names, if any. */
function cdTarget(argv: string[]): string | undefined {
  return argv
    .slice(1)
    .map((a) => NAMED_PATH.exec(a)?.[1] ?? a)
    .find((a) => !isFlag(a))
}

/**
 * True when `argv` is a cd (or chdir, pushd, Set-Location, ...) into the ticket's folder or a folder inside it,
 * resolved as the guard resolves every path. A bare `cd`, which goes home, is not.
 */
export function isCdInside(argv: string[], context: FolderContext): boolean {
  if (!CD_COMMANDS.has(commandName(argv[0] ?? ''))) return false
  const target = cdTarget(argv)
  return target !== undefined && locate(target, usable(context)).inside
}

/** Reason to ask before writing to this path, or null. */
function writeTargetReason(p: string, ctx: GuardContext): string | null {
  const { shown, inside, segments } = locate(p, ctx)
  if (!inside) return `Writes outside the ticket's folder: ${shown}`
  if (isAgentConfigPath(segments)) return `Changes agent or git settings: ${shown}`
  return null
}

function isFlag(a: string): boolean {
  return a.startsWith('-')
}

/** Reasons to ask before a downloader runs. */
function* downloadReasons(d: Download, ctx: GuardContext): Generator<string> {
  if (d.config) yield `Downloads with options from a file Mainbus can't check`
  if (!d.writes) return
  // A positional `$URL` is a URL, but an absolute or home path there means an option was misread.
  const paths = d.positional.filter((a) => !a.includes('://') && (ABSOLUTE.test(a) || HOME_FORM.test(a)))
  // `-` is standard output.
  const reason = firstReason([...d.targets, ...paths].filter((t) => t !== '-'), ctx)
  if (reason) yield reason
}

/** A folder a runner option makes the command run in behaves like `cd`. */
function folderReason(dir: string, ctx: GuardContext): string | null {
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

function firstReason(paths: string[], ctx: GuardContext): string | null {
  for (const p of paths) {
    if (NULL_TARGET.test(p)) continue
    const reason = writeTargetReason(p, ctx)
    if (reason) return reason
  }
  return null
}

function* commandReasons(cmd: SimpleCommand, ctx: GuardContext): Generator<string> {
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
  if (CD_COMMANDS.has(cmd.name)) {
    const target = cdTarget(cmd.argv)
    if (target !== undefined && !locate(target, ctx).inside) yield `Leaves the ticket's folder: ${locate(target, ctx).shown}`
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
function outsidePathIn(cmds: SimpleCommand[], ctx: GuardContext, reading = false): string | null {
  for (const cmd of cmds) {
    for (const a of reading ? readArguments(cmd) : [...cmd.argv.slice(1), ...cmd.redirects]) {
      const value = (NAMED_PATH.exec(a)?.[1] ?? a).replace(FILESYSTEM_PROVIDER, '')
      if (isFlag(value) || NULL_TARGET.test(value) || VALUE_VARIABLE.test(value)) continue
      // A downloader's bare `$URL` is the address it fetches.
      if (reading && DOWNLOAD_COMMANDS.has(cmd.name) && BARE_VARIABLE.test(value)) continue
      if (!HOME_OR_VARIABLE.test(value) && !ABSOLUTE.test(value) && !CLIMBS_OUT.test(value)) continue
      const { shown, inside } = locate(value, ctx)
      if (!inside) return shown
    }
  }
  return null
}

function touchesClaudeFolder(command: string, cmds: SimpleCommand[], ctx: GuardContext): boolean {
  if (HOME_FORM.test(command) && CLAUDE_WORD.test(command)) return true
  return cmds.some((cmd) =>
    cmd.argv.slice(1).some((a) => {
      if (!ABSOLUTE.test(a)) return false
      const { shown, inside } = locate(a, ctx)
      return !inside && CLAUDE_SEGMENT.test(shown)
    }),
  )
}

/**
 * Every reason to ask before a shell command, in order. `pick` stops at the first hard stop, so an automatic
 * reason early on (git reset --hard) never hides a hard stop later in the command (git push).
 */
function* shellReasons(command: string, ctx: GuardContext): Generator<string> {
  const parsed = parseShell(command)
  if (parsed.opaque) {
    yield `Runs a command Mainbus can't check: ${parsed.why}`
    return
  }
  const all = parsed.pipelines.flat()
  const secret = credentialReason('Bash', { command })
  if (secret) yield secret
  if (touchesClaudeFolder(command, all, ctx)) yield 'Touches the .claude folder in the home directory'
  for (const pipeline of parsed.pipelines) {
    for (const cmd of pipeline) yield* commandReasons(cmd, ctx)
    // `Get-ChildItem C:\x | Remove-Item`: the path reaches the write command through the pipe.
    const pathless = pipeline.some((c) => isWriteCommand(c.name) && pathArguments(c).length === 0)
    const outside = pathless ? outsidePathIn(pipeline, ctx) : null
    if (outside) yield `Writes outside the ticket's folder: ${outside}`
  }
  const read = outsidePathIn(all, ctx, true)
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

/** Relative or empty extra folders would resolve against the process cwd: drop them. */
function usable<T extends FolderContext>(context: T): T {
  return { ...context, additionalDirectories: context.additionalDirectories.filter((d) => d !== '' && win.isAbsolute(d)) }
}

function* reasonsFor(toolName: string, input: Record<string, unknown>, ctx: GuardContext): Generator<string> {
  if (Object.hasOwn(READ_PATH_KEYS, toolName)) {
    const reason = credentialReason(toolName, input) ?? toolReadReason(toolName, input, ctx)
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
    if (command !== null) yield* shellReasons(command, ctx)
  }
}

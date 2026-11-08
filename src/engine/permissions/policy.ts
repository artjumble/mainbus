import type { AllowRule, PermissionRequestParts } from '../../shared/domain'
import type { PermissionRequest } from '../runtime/types'
import { credentialReason } from './credentials'
import { type FolderContext, isCdInside } from './guard'
import { commandName, isDestructivePush, parseShell, plainStages } from './shell'

export { isDestructivePush }

type Req = Pick<PermissionRequest, 'toolName' | 'input'>

/** Shell tools share one command-string parser (shell.ts). */
export const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']
const FILE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

// A rule for these gets the whole command, never a generalised prefix.
const INTERPRETERS = new Set([
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'sh',
  'zsh',
  'node',
  'python',
  'python3',
  'py',
  'deno',
  'bun',
  'ruby',
  'perl',
  'npx',
  'pnpx',
  'bunx',
  'dlx',
  'uv',
  'uvx',
  'pipx',
  'wsl',
  'env',
  'xargs',
])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn'])
const RUNNER_SUBCOMMANDS = new Set(['dlx', 'exec', 'x'])

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.includes(toolName)
}

export const BACKGROUND_DENIED =
  'Run this in the foreground instead, with the timeout parameter set as long as it needs (up to 30 minutes). Commands left running in the background are ended when your run ends, and ending your turn to wait for one fails the run.'

/** True for a Bash or PowerShell call that asks to run in the background; roles may not. */
export function isBackgroundShell(toolName: string, input: Record<string, unknown>): boolean {
  return isShellTool(toolName) && input.run_in_background === true
}

export function commandOf(input: Record<string, unknown>): string | null {
  return typeof input.command === 'string' ? input.command : null
}

function normalize(command: string): string {
  return command.trim().split(/\s+/).join(' ')
}

/**
 * The commands of a chain that prefix rules must cover: plain commands joined by && || ; or |,
 * with no redirect to a file, variable, backtick or lone & anywhere (2>&1 and >/dev/null are fine).
 * A cd into the ticket's folder needs no rule and is left out, so the list can be empty.
 * Null means only an exact rule fits.
 */
function plainParts(command: string, folders?: FolderContext): string[][] | null {
  if (parseShell(command).opaque) return null
  const parts = plainStages(command)
  if (parts === null || parts.length === 0) return null
  return folders ? parts.filter((words) => !isCdInside(words, folders)) : parts
}

/** The words a prefix rule for this command keeps, or null when it must get an exact rule. */
function prefixOf(tokens: string[]): string[] | null {
  const first = commandName(tokens[0] ?? '')
  const second = tokens[1] ?? ''
  // A prefix rule must never start with '=', which marks an exact rule.
  if ((tokens[0] ?? '').startsWith('=')) return null
  if (INTERPRETERS.has(first) || /^python[\d.]*$/.test(first)) return null
  if (PACKAGE_MANAGERS.has(first) && RUNNER_SUBCOMMANDS.has(second)) return null
  // `git -C x status` would generalise to `git *`.
  if (first === 'git' && second.startsWith('-')) return null
  const prefix = [tokens[0] ?? '']
  if (tokens[1] !== undefined && !tokens[1].startsWith('-')) prefix.push(tokens[1])
  // A quoted word with spaces in it would not read back as the same words.
  if (prefix.some((w) => w === '' || /\s/.test(w))) return null
  return prefix
}

/**
 * The rules "Always allow" saves: one prefix rule per command of a plain chain, so
 * `npm test && git commit -m x` saves `npm test *` and `git commit *`; otherwise one exact rule.
 * With `opts.folders`, a cd into the ticket's folder saves nothing.
 */
export function rulesFromRequest(
  workspaceId: string,
  r: Req,
  opts: { exact?: boolean; folders?: FolderContext } = {},
): Array<Omit<AllowRule, 'id'>> {
  const command = isShellTool(r.toolName) ? commandOf(r.input) : null
  if (command === null) return [{ workspaceId, toolName: r.toolName, pattern: null }]
  const exact = [{ workspaceId, toolName: r.toolName, pattern: `=${normalize(command)}` }]
  if (opts.exact) return exact
  const parts = plainParts(command, opts.folders)
  const prefixes = parts?.map(prefixOf)
  if (!prefixes || prefixes.some((p) => p === null)) return exact
  const patterns = [...new Set(prefixes.map((p) => `${(p as string[]).join(' ')} *`))]
  return patterns.map((pattern) => ({ workspaceId, toolName: r.toolName, pattern }))
}

function coveredBy(pattern: string, words: string[]): boolean {
  if (pattern.startsWith('=') || !pattern.endsWith(' *')) return false
  const prefix = normalize(pattern.slice(0, -2)).split(' ')
  return prefix.length <= words.length && prefix.every((w, i) => w === words[i])
}

/**
 * True when a rule allows the request. With `folders` (the ticket's), a cd into that folder needs no rule;
 * leave it out where only exact rules may match.
 */
export function isAllowed(rules: AllowRule[], r: Req, folders?: FolderContext): boolean {
  const own = rules.filter((rule) => rule.toolName === r.toolName)
  const command = isShellTool(r.toolName) ? commandOf(r.input) : null
  // No rule can allow these.
  if (command !== null && (parseShell(command).opaque || isDestructivePush(command))) return false
  if (credentialReason(r.toolName, r.input) !== null) return false
  if (own.some((rule) => rule.pattern === null)) return true
  if (command === null) return false
  const cmd = normalize(command)
  // Exact rules are stored as '=' + the normalised command, so a command that
  // ends in ' *' cannot be mistaken for a prefix rule.
  if (own.some((rule) => rule.pattern?.startsWith('=') && normalize(rule.pattern.slice(1)) === cmd)) return true
  // A chain is allowed only when a prefix rule covers every command in it.
  const parts = plainParts(command, folders)
  if (parts === null) return false
  return parts.every((words) => own.some((rule) => rule.pattern !== null && coveredBy(rule.pattern, words)))
}

export function describeRequest(r: Req, role: string): string {
  if (isShellTool(r.toolName)) return `${role} wants to run \`${commandOf(r.input) ?? ''}\``
  if (FILE_TOOLS.includes(r.toolName)) {
    const p = r.input.file_path ?? r.input.notebook_path
    return `${role} wants to edit \`${typeof p === 'string' ? p : ''}\``
  }
  return `${role} wants to use ${r.toolName}`
}

/** The request's parts, kept apart from `describeRequest`'s text so a card can show the command as code. */
export function requestParts(r: Req, role: string, reason: string | undefined): PermissionRequestParts {
  const base = { role, tool: r.toolName, reason: reason ?? null }
  if (isShellTool(r.toolName)) return { ...base, command: commandOf(r.input) ?? '', path: null, input: null }
  if (FILE_TOOLS.includes(r.toolName)) {
    const p = r.input.file_path ?? r.input.notebook_path
    return { ...base, command: null, path: typeof p === 'string' ? p : '', input: r.input }
  }
  return { ...base, command: null, path: null, input: r.input }
}

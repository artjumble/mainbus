import type { AllowRule } from '../../shared/domain'
import type { PermissionRequest } from '../runtime/types'
import { credentialReason } from './credentials'
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

export function commandOf(input: Record<string, unknown>): string | null {
  return typeof input.command === 'string' ? input.command : null
}

function normalize(command: string): string {
  return command.trim().split(/\s+/).join(' ')
}

/**
 * The commands of a chain that prefix rules may cover: plain commands joined by && || ; or |,
 * with no redirect, variable, backtick or lone & anywhere. Null means only an exact rule fits.
 */
function plainParts(command: string): string[][] | null {
  if (/[$`]/.test(command) || command.replace(/&&/g, '').includes('&')) return null
  if (parseShell(command).opaque) return null
  const parts = plainStages(command)
  return parts !== null && parts.length > 0 ? parts : null
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
 */
export function rulesFromRequest(
  workspaceId: string,
  r: Req,
  opts: { exact?: boolean } = {},
): Array<Omit<AllowRule, 'id'>> {
  const command = isShellTool(r.toolName) ? commandOf(r.input) : null
  if (command === null) return [{ workspaceId, toolName: r.toolName, pattern: null }]
  const exact = [{ workspaceId, toolName: r.toolName, pattern: `=${normalize(command)}` }]
  if (opts.exact) return exact
  const parts = plainParts(command)
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

export function isAllowed(rules: AllowRule[], r: Req): boolean {
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
  const parts = plainParts(command)
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

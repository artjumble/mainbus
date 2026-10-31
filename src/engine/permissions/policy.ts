import type { AllowRule } from '../../shared/domain'
import type { PermissionRequest } from '../runtime/types'
import { commandName, isDestructivePush, parseShell, type ShellParse } from './shell'

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

function mustBeExact(command: string, tokens: string[]): boolean {
  const first = commandName(tokens[0] ?? '')
  const second = tokens[1] ?? ''
  // A prefix rule must never start with '=', which marks an exact rule.
  if ((tokens[0] ?? '').startsWith('=')) return true
  if (INTERPRETERS.has(first) || /^python[\d.]*$/.test(first)) return true
  if (PACKAGE_MANAGERS.has(first) && RUNNER_SUBCOMMANDS.has(second)) return true
  // `git -C x status` would generalise to `git *`.
  if (first === 'git' && second.startsWith('-')) return true
  return parseShell(command).opaque || /[<>$&`]/.test(command)
}

export function ruleFromRequest(
  workspaceId: string,
  r: Req,
  opts: { exact?: boolean } = {},
): Omit<AllowRule, 'id'> {
  const command = isShellTool(r.toolName) ? commandOf(r.input) : null
  if (command === null) return { workspaceId, toolName: r.toolName, pattern: null }
  const normalized = normalize(command)
  const tokens = normalized.split(' ').filter(Boolean)
  if (opts.exact || mustBeExact(command, tokens)) return { workspaceId, toolName: r.toolName, pattern: `=${normalized}` }
  const prefix = [tokens[0] ?? '']
  if (tokens[1] !== undefined && !tokens[1].startsWith('-')) prefix.push(tokens[1])
  return { workspaceId, toolName: r.toolName, pattern: `${prefix.join(' ')} *` }
}

function isSingleSimpleCommand(parsed: Extract<ShellParse, { opaque: false }>): boolean {
  return parsed.pipelines.length === 1 && parsed.pipelines[0].length === 1 && parsed.pipelines[0][0].redirects.length === 0
}

function matches(pattern: string, command: string, parsed: Extract<ShellParse, { opaque: false }>): boolean {
  const cmd = normalize(command)
  // Exact rules are stored as '=' + the normalised command, so a command that
  // ends in ' *' cannot be mistaken for a prefix rule.
  if (pattern.startsWith('=')) return cmd === normalize(pattern.slice(1))
  if (!pattern.endsWith(' *')) return false
  if (!isSingleSimpleCommand(parsed) || /[$&`]/.test(command)) return false
  const prefix = normalize(pattern.slice(0, -2))
  return cmd === prefix || cmd.startsWith(`${prefix} `)
}

export function isAllowed(rules: AllowRule[], r: Req): boolean {
  const shell = isShellTool(r.toolName)
  const command = shell ? commandOf(r.input) : null
  let parsed: ShellParse | null = null
  if (command !== null) {
    parsed = parseShell(command)
    if (parsed.opaque || isDestructivePush(command)) return false // no rule can allow these
  }
  return rules.some((rule) => {
    if (rule.toolName !== r.toolName) return false
    if (rule.pattern === null) return true
    if (command === null || parsed === null || parsed.opaque) return false
    return matches(rule.pattern, command, parsed)
  })
}

export function describeRequest(r: Req, role: string): string {
  if (isShellTool(r.toolName)) return `${role} wants to run \`${commandOf(r.input) ?? ''}\``
  if (FILE_TOOLS.includes(r.toolName)) {
    const p = r.input.file_path ?? r.input.notebook_path
    return `${role} wants to edit \`${typeof p === 'string' ? p : ''}\``
  }
  return `${role} wants to use ${r.toolName}`
}

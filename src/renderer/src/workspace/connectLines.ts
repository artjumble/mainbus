import type { AgentLauncher } from '../../../shared/domain'
import { platform } from '../platform'

export interface SetupLine {
  id: 'claude' | 'codex' | 'copilot' | 'shell'
  title: string
  /** Where the text goes. */
  where: string
  text: string
}

/** Quotes an argument for PowerShell or cmd when it has spaces. */
function quote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

/** Quotes an argument for a POSIX shell: bare when it only has safe characters, else single-quoted. */
function posixQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-.,/:=@%+]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * The lines to copy into each agent client, built from the app's real launcher. Checked against each
 * client's docs (October 2026):
 * - Claude Code: `claude mcp add [options] <name> -- <command> [args...]`; --env must not sit directly
 *   before the name, so --scope comes between them.
 * - Codex: an [mcp_servers.<name>] table in ~/.codex/config.toml with command, args and env.
 * - VS Code (GitHub Copilot): a stdio entry under "servers" in mcp.json.
 * On Windows the stable launcher is a .cmd file, which clients can't always start directly, so it runs
 * through `cmd /c`. Elsewhere it is an executable script, started directly, and the lines use POSIX shell
 * quoting (the macOS data home has a space in its name).
 */
export function setupLines(launcher: AgentLauncher, os: string = platform()): SetupLine[] {
  const win = os === 'win32'
  const q = win ? quote : posixQuote
  const name = launcher.kind === 'stable' ? 'mainbus' : 'mainbus-dev'
  const [program, ...rest] =
    launcher.kind === 'stable' && win ? ['cmd', '/c', ...launcher.program, 'mcp'] : [...launcher.program, 'mcp']
  const env = Object.entries(launcher.env)

  const claudeEnv = env.map(([k, v]) => `--env ${q(`${k}=${v}`)} `).join('')
  const claude = `claude mcp add ${claudeEnv}--scope user ${name} -- ${[program, ...rest].map(q).join(' ')}`

  // JSON strings are valid TOML basic strings.
  const codex = [
    `[mcp_servers.${name}]`,
    `command = ${JSON.stringify(program)}`,
    `args = [${rest.map((a) => JSON.stringify(a)).join(', ')}]`,
    ...(env.length ? [`env = { ${env.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }`] : [])
  ].join('\n')

  const copilot = JSON.stringify(
    {
      servers: {
        [name]: { type: 'stdio', command: program, args: rest, ...(env.length ? { env: launcher.env } : {}) }
      }
    },
    null,
    2
  )

  const cli = launcher.program.map(q)
  let shell: string
  if (win) {
    // Single quotes keep PowerShell from expanding anything in the value; a quote inside is doubled.
    const shellEnv = env.map(([k, v]) => `$env:${k} = '${v.replace(/'/g, "''")}'; `).join('')
    shell = `${shellEnv}${cli[0]!.startsWith('"') ? '& ' : ''}${cli.join(' ')} ticket list`
  } else {
    // K=v prefixes the command for one run; the value is quoted when it needs it.
    const shellEnv = env.map(([k, v]) => `${k}=${posixQuote(v)} `).join('')
    shell = `${shellEnv}${cli.join(' ')} ticket list`
  }

  return [
    { id: 'claude', title: 'Claude Code', where: 'Run once in a terminal', text: claude },
    { id: 'codex', title: 'Codex', where: 'Add to ~/.codex/config.toml', text: codex },
    {
      id: 'copilot',
      title: 'GitHub Copilot in VS Code',
      where: 'Add to mcp.json (MCP: Open User Configuration)',
      text: copilot
    },
    {
      id: 'shell',
      title: 'Anything with a shell',
      where: win ? 'The mainbus CLI, in PowerShell' : 'The mainbus CLI, in a terminal',
      text: shell
    }
  ]
}

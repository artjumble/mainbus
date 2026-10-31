// One parser for the command string of the Bash and PowerShell tools, shared by
// policy.ts and guard.ts. It is fail-closed: anything it cannot fully understand
// comes back as `{ opaque: true }`, and callers treat that as "needs a card".

import { interpreterArgs, SHELLS } from './interpreters'
import { peelRunner } from './runners'

export interface SimpleCommand {
  /** Lower-case command name without directory or .exe/.cmd/.bat. */
  name: string
  /** Name first, then arguments, quotes removed. */
  argv: string[]
  /** Targets of > and >> (and &>) redirects. Fd duplication is dropped. */
  redirects: string[]
  /** Files read through < redirects; only present when there are some. */
  inputs?: string[]
  /** Folders a runner option makes the command run in (`pnpm -C`, `npm --prefix`, ...). */
  dirs?: string[]
}

export type ShellParse = { opaque: false; pipelines: SimpleCommand[][] } | { opaque: true; why: string }

/** Final command name: no directory, no .exe/.cmd/.bat, lower case. */
export function commandName(token: string): string {
  return token
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase()
}

interface Stage {
  argv: string[]
  redirects: string[]
  /** Files named by < redirects. */
  inputs: string[]
  /** Input comes from a < redirect. */
  stdin: boolean
}

type Scanned = { statements: Stage[][] } | { why: string }

/** Splits on && || ; | and newlines outside quotes. Quotes are removed from tokens. */
function scan(command: string): Scanned {
  const statements: Stage[][] = []
  let pipeline: Stage[] = []
  let stage: Stage = { argv: [], redirects: [], inputs: [], stdin: false }
  let token = ''
  let inToken = false
  let pending: 'out' | 'in' | null = null
  let quote: '"' | "'" | null = null

  const endToken = (): void => {
    if (inToken) {
      if (pending === 'out') stage.redirects.push(token)
      else if (pending === 'in') stage.inputs.push(token)
      else if (pending === null) stage.argv.push(token)
      pending = null
    }
    token = ''
    inToken = false
  }
  const endStage = (): void => {
    endToken()
    pending = null
    pipeline.push(stage)
    stage = { argv: [], redirects: [], inputs: [], stdin: false }
  }
  const endStatement = (): void => {
    endStage()
    statements.push(pipeline)
    pipeline = []
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && (c === '`' || (c === '$' && next === '('))) return { why: 'command substitution' }
      else token += c
      continue
    }
    switch (c) {
      case '"':
      case "'":
        quote = c
        inToken = true
        break
      case '`':
        return { why: 'a backtick' }
      case '(':
      case ')':
        return { why: 'parentheses' }
      case '{':
      case '}':
        return { why: 'braces' }
      case '<':
        if (next === '<') return { why: 'a heredoc' }
        // The leading file descriptor (0<) is not an argument.
        if (inToken && /^\d+$/.test(token)) {
          token = ''
          inToken = false
        } else endToken()
        pending = 'in'
        stage.stdin = true
        break
      case '>':
        if (inToken && /^\d+$/.test(token)) {
          token = ''
          inToken = false
        } else endToken()
        if (next === '>') i++
        if (command[i + 1] === '&' && /[\d-]/.test(command[i + 2] ?? '')) {
          i += 2 // fd duplication such as 2>&1: not a file
          while (/[\d-]/.test(command[i + 1] ?? '')) i++
        } else {
          if (command[i + 1] === '&') i++ // >&file
          pending = 'out'
        }
        break
      case '&':
        if (next === '&') {
          i++
          endStatement()
        } else if (next === '>') {
          endToken()
          i++
          if (command[i + 1] === '>') i++
          pending = 'out'
        } else if (!inToken && stage.argv.length === 0 && /\s/.test(next ?? ' ')) {
          // PowerShell call operator at the start of a command.
        } else {
          return { why: 'a background or call operator (&)' }
        }
        break
      case '|':
        if (next === '|') {
          i++
          endStatement()
        } else endStage()
        break
      case ';':
      case '\n':
        endStatement()
        break
      case ' ':
      case '\t':
      case '\r':
        endToken()
        break
      default:
        token += c
        inToken = true
    }
  }
  if (quote) return { why: 'an unbalanced quote' }
  endStatement()
  return { statements }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIXES = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'builtin', 'setsid'])
const ALWAYS_OPAQUE = new Set([
  'powershell',
  'pwsh',
  'iex',
  'invoke-expression',
  'start-process',
  'saps',
  'invoke-command',
  'icm',
  'wsl',
  'env',
  'xargs',
  'timeout',
  'nice',
  'runas',
])

function wrapperWhy(name: string, args: string[]): string | null {
  const lower = args.map((a) => a.toLowerCase())
  // `env` on its own runs nothing: it prints the environment, which credentials.ts checks.
  if (name === 'env' && args.length === 0) return null
  if (ALWAYS_OPAQUE.has(name)) return `it runs another command through ${name}`
  if (name === 'cmd' && lower.some((a) => ['/c', '/k', '/r'].includes(a))) return 'it runs another command through cmd'
  const program = interpreterArgs(name, args)
  if (program?.inline) {
    return SHELLS.has(name) ? `it runs another command through ${name} -c` : `it runs code given on the command line (${name})`
  }
  if (name === 'find' && lower.some((a) => ['-exec', '-execdir', '-ok', '-okdir', '-delete'].includes(a))) {
    return 'find runs or deletes things on its own'
  }
  return null
}

/** One stage's argv, with prefixes and runner wrappers peeled off, analysed as typed. */
function analyse(words: string[], redirects: string[], dirs: string[] = []): SimpleCommand | { why: string } | null {
  const argv = [...words]
  while (argv.length > 0 && (ASSIGNMENT.test(argv[0]) || PREFIXES.has(commandName(argv[0])))) {
    const wasSudo = commandName(argv[0]) === 'sudo'
    argv.shift()
    if (wasSudo && argv[0]?.startsWith('-')) return { why: 'sudo with options' }
  }
  if (argv.length === 0) return redirects.length > 0 ? { argv, name: '', redirects } : null
  if (/^[$%]/.test(argv[0])) return { why: 'the command name comes from a variable' }
  const name = commandName(argv[0])
  const why = wrapperWhy(name, argv.slice(1))
  if (why) return { why }
  const peeled = peelRunner(name, argv.slice(1))
  if ('why' in peeled) return peeled
  const folders = [...dirs, ...peeled.dirs]
  if (peeled.argv === null) return folders.length > 0 ? { name, argv, redirects, dirs: folders } : { name, argv, redirects }
  // Each peel drops at least the runner's name, so this ends.
  const inner = analyse(peeled.argv, redirects, folders)
  return inner !== null && 'why' in inner ? { why: `${name} runs another command: ${inner.why}` } : inner
}

// `... | node`, `... | python -` and `bash < x.sh` run whatever arrives on stdin.
function readsStdinAsCode(c: SimpleCommand): boolean {
  if (c.name === 'cmd') return true
  return interpreterArgs(c.name, c.argv.slice(1))?.stdin ?? false
}

/**
 * Each command's words as typed (quotes removed, nothing peeled), when the command is only plain
 * commands joined by && || ; | or newlines. Null when any of them has a redirect or reads a < file.
 */
export function plainStages(command: string): string[][] | null {
  const scanned = scan(command)
  if ('why' in scanned) return null
  const stages = scanned.statements.flat()
  if (stages.some((s) => s.redirects.length > 0 || s.stdin)) return null
  return stages.map((s) => s.argv).filter((argv) => argv.length > 0)
}

export function parseShell(command: string): ShellParse {
  const scanned = scan(command)
  if ('why' in scanned) return { opaque: true, why: scanned.why }
  const pipelines: SimpleCommand[][] = []
  for (const statement of scanned.statements) {
    const simple: SimpleCommand[] = []
    for (const [index, stage] of statement.entries()) {
      const s = analyse(stage.argv, stage.redirects)
      if (s === null) continue
      if ('why' in s) return { opaque: true, why: s.why }
      if ((index > 0 || stage.stdin) && readsStdinAsCode(s)) {
        return { opaque: true, why: `it feeds a script to ${s.name} on standard input` }
      }
      if (stage.inputs.length > 0) s.inputs = stage.inputs
      simple.push(s)
    }
    if (simple.length > 0) pipelines.push(simple)
  }
  return { opaque: false, pipelines }
}

export interface GitInvocation {
  sub: string | undefined
  rest: string[]
  /** `-c key=value` overrides, including --config-env. */
  configs: string[]
}

const GIT_VALUE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix'])

/** Parses `git [global options] <sub> <args>`; null when argv is not git. */
export function parseGit(argv: string[]): GitInvocation | null {
  if (argv.length === 0 || commandName(argv[0]) !== 'git') return null
  const configs: string[] = []
  let i = 1
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i]
    if (a === '-c' || a === '--config-env') {
      configs.push(argv[i + 1] ?? '')
      i += 2
    } else if (GIT_VALUE_OPTIONS.has(a)) {
      i += 2
    } else {
      if (a.startsWith('--config-env=')) configs.push(a.slice('--config-env='.length))
      else if (/^-c.+/.test(a)) configs.push(a.slice(2))
      i += 1
    }
  }
  return { sub: argv[i], rest: argv.slice(i + 1), configs }
}

const FORCE_PUSH_OPTIONS = ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune']

/** Arguments after `git push` that can overwrite or delete remote history. */
export function isDestructivePushArgs(rest: string[]): boolean {
  return rest.some((a) => {
    if (a.startsWith('--')) {
      const opt = a.split('=')[0]
      return opt.length > 2 && FORCE_PUSH_OPTIONS.some((o) => o.startsWith(opt))
    }
    if (a.startsWith('-')) return /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(a)
    return a.startsWith('+') || a.startsWith(':')
  })
}

/** True when any git push in the command can overwrite or delete remote history. */
export function isDestructivePush(command: string): boolean {
  const parsed = parseShell(command)
  if (!parsed.opaque) {
    return parsed.pipelines.flat().some((c) => {
      const git = parseGit(c.argv)
      return git?.sub === 'push' && isDestructivePushArgs(git.rest)
    })
  }
  // Opaque: we cannot parse it, so look for the words.
  const words = command.split(/[\s();&|`$"'{}]+/).filter(Boolean)
  const push = words.indexOf('push')
  return words.some((w) => commandName(w) === 'git') && push >= 0 && isDestructivePushArgs(words.slice(push + 1))
}

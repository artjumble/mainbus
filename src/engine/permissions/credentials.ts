// Credential files and commands that print secrets. A request that touches one always gets a
// card without "Always allow", and no allow rule covers it (policy.ts, ticketRunner.ts). Matching
// needs no worktree: the names are checked wherever the file is, so this is shared by the guard
// and the allow-rule check.

import fs from 'node:fs'
import path from 'node:path'
import { hostPathStyle, type PathStyle, pathRules } from './paths'
import { parseGit, parseShell, type SimpleCommand } from './shell'

/** PowerShell `-Name:value`; the value of a path parameter written in one word. */
export const NAMED_PATH = /^-(?:path|literalpath|destination|destinationpath|filepath|outfile|target):(.+)$/i
const ATTACHED_VALUE = /^(?:-{1,2}[A-Za-z][\w-]*[=:]|[A-Za-z][\w.-]*=)(.+)$/
const FILESYSTEM_PROVIDER = /^(?:[\w.]+\\)?FileSystem::/i
// PowerShell's environment drive: `Get-ChildItem env:`, `dir Env:\`.
const ENV_DRIVE = /^(?:[\w.]+\\)?(?:env:|environment::)/i

/** NTFS ignores trailing dots and spaces and treats `name:stream` / `name::$DATA` as the same file. */
export function ntfsName(segment: string): string {
  return segment.replace(/:.*$/, '').replace(/[. ]+$/, '')
}

// These hold credentials only when they have auth-like settings; the others always do.
const CONDITIONAL_FILES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml'])
const SECRET_FILES = new Set([...CONDITIONAL_FILES, '.pypirc', '.netrc', '_netrc', '.git-credentials'])
const SECRET_FOLDERS = new Set(['.ssh', '.aws', '.azure', '.kube', 'gnupg', '.gnupg', '.password-store'])
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])
const KEY_FILE = /\.(?:pem|key|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa)/
/**
 * Consecutive lower-case segments that name a secret file or folder, anywhere in a path. `etc\npmrc` is
 * npm's global config next to Node. The keyrings entry has three segments because `/usr/share/keyrings`
 * holds public apt keys.
 */
const SECRET_PATHS = [
  ['.docker', 'config.json'],
  ['.config', 'gh'],
  ['.config', 'gcloud'],
  ['.claude', '.credentials.json'],
  ['.codex', 'auth.json'],
  ['etc', 'npmrc'],
  ['library', 'keychains'],
  ['.local', 'share', 'keyrings'],
]
// Names a wildcard is tried against.
const SAMPLE_NAMES = [...SECRET_FILES, ...SECRET_FOLDERS, '.env', '.env.local', 'x.pem', 'x.key', 'x.p12', 'x.pfx'].concat(
  ['id_rsa', 'id_ed25519', 'id_ecdsa'],
)

/** Where to read a conditional file: the ticket's worktree, and the folder relative paths start from. */
export interface CredentialFiles {
  worktree: string
  cwd?: string
  /** How paths are read; the host's style when absent. */
  pathStyle?: PathStyle
}

const AUTH_LIKE = /auth|token|passw|secret|credential|username|:_|(?:^|\W)(?:cert|key)(?:file)?\s*[=:]/im
const MAX_CONFIG_BYTES = 64 * 1024

/** True when a file we can read in the worktree has no auth-like setting. Anything else counts as a credential. */
function holdsNoCredentials(typed: string, files: CredentialFiles | undefined): boolean {
  if (files === undefined || /[$~*?[\]%-]/.test(typed)) return false
  const last = typed.split(/[\\/]/).pop() ?? ''
  // Only the plain name: NTFS also reads `.npmrc:stream` and `.npmrc.`.
  if (!CONDITIONAL_FILES.has(last.toLowerCase())) return false
  const rules = pathRules(files.pathStyle ?? hostPathStyle())
  const resolved = rules.resolve(files.cwd ?? files.worktree, typed)
  if (!rules.isInside(resolved, [files.worktree])) return false
  try {
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return false
    return !AUTH_LIKE.test(fs.readFileSync(resolved, 'utf8'))
  } catch {
    return false
  }
}

function isSecretName(name: string): boolean {
  if (SECRET_FILES.has(name) || SECRET_FOLDERS.has(name) || KEY_FILE.test(name)) return true
  return name === '.env' || (name.startsWith('.env.') && !ENV_TEMPLATES.has(name))
}

function globRegex(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) out += '\\['
      else {
        out += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'
        i = end
      }
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * A wildcard that could name a secret. Like bash, a wildcard matches a leading dot only when it
 * starts with one, and a segment of nothing but `*` is ignored so `cat src/*` stays quiet.
 */
function globMatchesSecret(glob: string): boolean {
  if (/^\*+$/.test(glob)) return false
  const re = globRegex(glob)
  return SAMPLE_NAMES.some((n) => (glob.startsWith('.') || !n.startsWith('.')) && re.test(n))
}

/** True when the path, as typed or with its `..` folded away, names a credential file or a folder of them. */
export function isCredentialPath(p: string, files?: CredentialFiles): boolean {
  const typed = p.replace(FILESYSTEM_PROVIDER, '')
  // Fold `..` with the active style's rules: win32 normalisation would turn `y/.npmrc` into `y\.npmrc` on POSIX,
  // which then resolves to a file that doesn't exist.
  const normalize = (files?.pathStyle ?? hostPathStyle()) === 'win32' ? path.win32.normalize : path.posix.normalize
  return namesCredential(typed, files) || namesCredential(normalize(typed), files)
}

function namesCredential(p: string, files: CredentialFiles | undefined): boolean {
  const segments = p
    .split(/[\\/]+/)
    .map((s) => ntfsName(s).toLowerCase())
    .filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => (/[*?[]/.test(s) ? globMatchesSecret(s) : SECRET_FOLDERS.has(s)))) return true
  if (SECRET_PATHS.some((seq) => segments.some((_, i) => seq.every((part, j) => segments[i + j] === part)))) return true
  const last = segments[segments.length - 1] ?? ''
  if (CONDITIONAL_FILES.has(last) && holdsNoCredentials(p, files)) return false
  return isSecretName(last)
}

// Commands whose arguments are text, not files.
const ECHO_COMMANDS = new Set(['echo', 'printf', 'write-output', 'write', 'write-host', 'write-information'].concat(
  ['write-verbose', 'write-warning', 'write-error', 'write-debug'],
))

interface Search {
  /** Options that replace the positional pattern. */
  pattern: string[]
  /** Options followed by a value that is text, not a file. */
  text: string[]
  /** Options followed by a value that may be a file. */
  files: string[]
}
// The first positional argument of these is a pattern or script, not a file.
const SEARCH: Record<string, Search> = {
  grep: {
    pattern: ['-e', '--regexp', '-f', '--file'],
    text: ['-e', '--regexp', '-A', '-B', '-C', '-m', '--max-count'],
    files: ['-f', '--file', '--include', '--exclude'],
  },
  rg: {
    pattern: ['-e', '--regexp', '-f', '--file'],
    text: ['-e', '--regexp', '-A', '-B', '-C', '-m', '--max-count', '-t', '--type', '-T', '--type-not', '-r'].concat(
      ['--replace', '-M', '--max-columns', '-j', '--threads', '-d', '--max-depth'],
    ),
    files: ['-f', '--file', '-g', '--glob', '--iglob'],
  },
  sed: { pattern: ['-e', '--expression', '-f', '--file'], text: ['-e', '--expression', '-l'], files: ['-f', '--file'] },
  awk: { pattern: ['-f', '--file'], text: ['-v', '--assign', '-F', '--field-separator'], files: ['-f', '--file'] },
  'select-string': {
    pattern: ['-pattern'],
    text: ['-pattern', '-encoding', '-context'],
    files: ['-path', '-literalpath', '-include', '-exclude'],
  },
}
SEARCH.egrep = SEARCH.grep
SEARCH.fgrep = SEARCH.grep
SEARCH.gawk = SEARCH.awk
SEARCH.sls = SEARCH['select-string']
// cmd.exe programs take /x switches.
const CMD_SWITCHES = new Set(['dir', 'type', 'more', 'sort', 'findstr', 'where', 'tree', 'fc', 'comp', 'xcopy'].concat(
  ['robocopy', 'attrib', 'del', 'erase', 'rd', 'rmdir', 'move', 'copy', 'mklink'],
))
const CMD_SWITCH = /^\/[a-z?]+(?::.*)?$/i

/**
 * The words of a command that may name a file it reads: positional arguments, values of named and
 * `--opt=value` options, and `<` inputs. Patterns, scripts, commit messages and echoed text are left out.
 */
export function readArguments(cmd: SimpleCommand): string[] {
  if (ECHO_COMMANDS.has(cmd.name)) return [...(cmd.inputs ?? [])]
  const args = cmd.argv.slice(1)
  const search = Object.hasOwn(SEARCH, cmd.name) ? SEARCH[cmd.name] : undefined
  const lower = (a: string): string => (cmd.name.includes('-') || cmd.name === 'sls' ? a.toLowerCase() : a)
  const isGit = parseGit(cmd.argv) !== null
  const out: string[] = []
  const positional: string[] = []
  let patternGiven = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (isGit && ['-m', '--message', '-c'].includes(a)) {
      i++
      continue
    }
    if (isGit && (/^-m./.test(a) || a.startsWith('--message='))) continue
    if (search?.pattern.includes(lower(a))) patternGiven = true
    if (search?.text.includes(lower(a))) {
      i++
      continue
    }
    if (search?.files.includes(lower(a))) {
      if (args[i + 1] !== undefined) out.push(args[++i])
      continue
    }
    if (CMD_SWITCHES.has(cmd.name) && CMD_SWITCH.test(a)) {
      // findstr /c:text is the pattern; /g:file and /f:file are files.
      if (cmd.name === 'findstr' && /^\/[cg]:/i.test(a)) patternGiven = true
      if (cmd.name === 'findstr' && /^\/[gf]:/i.test(a)) out.push(a.slice(3))
      continue
    }
    const attached = NAMED_PATH.exec(a) ?? ATTACHED_VALUE.exec(a)
    if (attached) out.push(attached[1])
    else if (!a.startsWith('-')) positional.push(a)
  }
  const files = search && !patternGiven ? positional.slice(1) : positional
  return [...files, ...out, ...(cmd.inputs ?? []), ...(cmd.dirs ?? [])]
}

/** Keys whose values are secrets: `//registry.npmjs.org/:_authToken`, `http.extraheader`, ... */
const SECRET_KEY = /auth|token|passw|secret|credential|extraheader/i

// `security` subcommands that print or export Keychain secrets, with or without -w / -g.
const KEYCHAIN_SECRET_COMMANDS = new Set(['find-generic-password', 'find-internet-password', 'dump-keychain', 'export'])
// `pass` subcommands that print entry names only.
const PASS_NAME_ONLY = new Set(['ls', 'list', 'find', 'search', 'help', 'version'])

/** macOS `security`: a secret subcommand, or interactive mode (-i), which reads any subcommand from stdin. */
function keychainRead(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) return KEYCHAIN_SECRET_COMMANDS.has(a)
    if (a.startsWith('--')) continue
    const letters = a.slice(1)
    const p = letters.indexOf('p')
    if ((p < 0 ? letters : letters.slice(0, p)).includes('i')) return true
    // -p takes the next word as a prompt.
    if (p >= 0 && p === letters.length - 1) i++
  }
  return false
}

/** True when the command prints secrets without naming a file. */
function printedSecrets(cmd: SimpleCommand): boolean {
  const args = cmd.argv.slice(1)
  const words = args.filter((a) => !a.startsWith('-'))
  switch (cmd.name) {
    case 'printenv':
      return true
    case 'env':
    case 'set':
      return args.length === 0
    case 'gh':
      return words[0] === 'auth' && (words[1] === 'token' || (words[1] === 'status' && args.some((a) => a === '-t' || a === '--show-token')))
    case 'security':
      return keychainRead(args)
    case 'secret-tool':
      // Libsecret (GNOME keyring): lookup and search print secrets; store, clear and lock don't.
      return words[0] === 'lookup' || words[0] === 'search'
    case 'pass':
      // Bare `pass` and the name-only subcommands are quiet; show, the implicit show, -c, grep, otp, ... print or use secrets.
      return words[0] !== undefined && !PASS_NAME_ONLY.has(words[0])
    case 'npm':
    case 'pnpm':
    case 'yarn': {
      const [first, second, third] = words
      const config = first === 'config' || first === 'c'
      // `npm get` is `npm config get`; with no key it prints every setting.
      if (first === 'get') return second === undefined || SECRET_KEY.test(second)
      if (config && second === 'get') return third === undefined || SECRET_KEY.test(third)
      return config && ['list', 'ls'].includes(second ?? '') && args.includes('--json')
    }
  }
  const git = parseGit(cmd.argv)
  if (git?.sub !== undefined) {
    if (git.sub === 'credential' || git.sub.startsWith('credential-')) return true
    if (git.sub === 'config') return git.rest.some((a) => !a.startsWith('-') && SECRET_KEY.test(a))
  }
  return readArguments(cmd).some((a) => ENV_DRIVE.test(a))
}

function commandCredentialReason(cmd: SimpleCommand, files: CredentialFiles | undefined): string | null {
  if (printedSecrets(cmd)) return `Prints credentials: ${cmd.argv.join(' ')}`
  const file = readArguments(cmd).find((a) => isCredentialPath(a, files))
  return file === undefined ? null : `Reads a credentials file: ${file}`
}

// Inputs of the read-only file tools that name a path or a filename pattern.
const TOOL_PATH_KEYS: Record<string, string[]> = {
  Read: ['file_path'],
  NotebookRead: ['notebook_path'],
  Grep: ['path', 'glob'],
  Glob: ['path', 'pattern'],
}

/** The credentials-card reason for a tool call, or null. Unparseable commands are left to the guard. */
export function credentialReason(toolName: string, input: Record<string, unknown>, files?: CredentialFiles): string | null {
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    if (typeof input.command !== 'string') return null
    const parsed = parseShell(input.command)
    if (parsed.opaque) return null
    for (const cmd of parsed.pipelines.flat()) {
      const reason = commandCredentialReason(cmd, files)
      if (reason) return reason
    }
    return null
  }
  for (const key of Object.hasOwn(TOOL_PATH_KEYS, toolName) ? TOOL_PATH_KEYS[toolName] : []) {
    const p = input[key]
    if (typeof p === 'string' && isCredentialPath(p, files)) return `Reads a credentials file: ${p}`
  }
  return null
}

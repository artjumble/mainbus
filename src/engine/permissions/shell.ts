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

/** How a statement is joined to the one before it. */
export type Join = '&&' | '||' | ';'

/**
 * The variables a caller lets the parser read. Bash names are case-sensitive; PowerShell names are keyed in lower
 * case, environment variables as `env:name`. `known` is copied, never changed.
 */
export interface ShellVars {
  dialect: 'bash' | 'powershell'
  known: Map<string, string>
  /** What `%TEMP%` and `%TMP%` name (neither shell expands them, but the guard treats them as the scratch folder). */
  percent?: string
}

export interface ParsedShell {
  pipelines: SimpleCommand[][]
  /** How each pipeline is joined to the one before it; `;` for the first. */
  joins: Join[]
  /** How many loops (`for`, `while`, `until`) enclose each pipeline. */
  loops: number[]
  /** Whether each pipeline sits inside an `if` or a loop. */
  compound: boolean[]
}

export const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])

/** Final command name: no directory, no .exe/.cmd/.bat, lower case. */
export function commandName(token: string): string {
  return token
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase()
}

interface Stage {
  argv: string[]
  /** Whether each word of argv is made only of quoted text. */
  quoted: boolean[]
  redirects: string[]
  /** Files named by < redirects. */
  inputs: string[]
  /** Input comes from a < redirect or a heredoc. */
  stdin: boolean
  /** Input comes from a heredoc. */
  heredoc: boolean
}

interface Statement {
  stages: Stage[]
  join: Join
  /** PowerShell `$name = 'literal'`: sets a variable and does nothing else. */
  assign?: boolean
  /** The statement opens an `if`, a loop or a `for`; `close` ends one (`fi`, `done`). */
  open?: 'if' | 'loop' | 'for'
  close?: boolean
  /** A `for` over literal words: the placeholder the body reads, and the words. */
  forInfo?: { placeholder: string; values: string[] }
}

/**
 * `special`: the command has a `$` (other than a `$null` redirect target) or an `&` that is not `&&`, `&>` or a
 * fd duplication such as `2>&1`, quoted or not. Prefix rules don't cover such a command.
 */
type Scanned = { statements: Statement[]; special: boolean } | { why: string }

// Private-use characters stand for loop variables and for reads that only a quoted use may resolve.
const PLACEHOLDER_START = ''
const PLACEHOLDER_END = ''
const GLOB_MARK = ''
const PRIVATE_USE = /[-]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// `X+=1`, `X[0]=1`: assignments the rest of the code does not model.
const OTHER_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\+|\[[^\]]*\]\+?)=/
const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'done', 'fi'])
const EXPORTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])
// Builtins that set or unset variables by a name they are given, which may be computed (`export "${n}MP=1"`).
const SETS_VARIABLES = new Set(
  ['unset', 'read', 'readarray', 'mapfile', 'let', 'getopts', 'wait', 'alias', 'select', 'coproc'].concat(Array.from(EXPORTERS)),
)
// Commands that run code in the shell itself, where it can change the variables. PowerShell dot-sourcing is `.`.
const RUNS_IN_SHELL = new Set(['source', '.', 'eval', 'trap', 'iex', 'invoke-expression', 'import-module', 'ipmo', 'using'])
const POWERSHELL_VARIABLE_COMMANDS = new Set(
  ['set-variable', 'set', 'sv', 'new-variable', 'nv', 'remove-variable', 'rv', 'clear-variable', 'clv'].concat(['set-item', 'si']),
)
const MAX_LOOP_VALUES = 16
const MAX_STATEMENTS = 400

/** PowerShell runs a script (`.\x.ps1`, or a path that may resolve to one) in its own process. */
export function runsScriptInProcess(word: string): boolean {
  return /\.psm?1$/i.test(word) || (/[\\/]/.test(word) && !/\.(?:exe|com|cmd|bat)$/i.test(word))
}

/** The leading `if`, `then`, `do`, `!` and the like, which are not the command itself. */
export function peelReserved(argv: string[]): string[] {
  let k = 0
  while (k < argv.length && RESERVED.has(argv[k])) k++
  return k === 0 ? argv : argv.slice(k)
}

interface Read {
  /** The key in `known`. */
  key: string
  /** The text of the read as typed. */
  text: string
}

function readAt(command: string, i: number, dialect: 'bash' | 'powershell'): Read | null {
  const rest = command.slice(i, i + 80)
  const braced = /^\$\{([A-Za-z_]\w*)\}/.exec(rest)
  if (braced) return { key: dialect === 'bash' ? braced[1] : braced[1].toLowerCase(), text: braced[0] }
  if (dialect === 'powershell') {
    const env = /^\$env:([A-Za-z_]\w*)/i.exec(rest)
    if (env) return { key: `env:${env[1].toLowerCase()}`, text: env[0] }
    // `$name:` is a drive or scope qualifier, not a plain variable.
    const plain = /^\$([A-Za-z_]\w*)(?!\w|:)/.exec(rest)
    return plain ? { key: plain[1].toLowerCase(), text: plain[0] } : null
  }
  const plain = /^\$([A-Za-z_]\w*)/.exec(rest)
  return plain ? { key: plain[1], text: plain[0] } : null
}

interface LoopStack {
  /** Per open `if` or loop: whether it is a loop, and its loop variable's key. */
  frames: { loop: boolean; key: string | null }[]
  counter: number
  /** Keys read inside the outermost open loop. */
  reads: Set<string>
  /** A loop body changed something it had read: the next round would read a different value. */
  bad: boolean
}

const loopDepth = (loop: LoopStack): number => loop.frames.filter((f) => f.loop).length

/** Notes that a key (or, with null, any of them) is about to change. */
function touch(loop: LoopStack, key: string | null): void {
  if (loopDepth(loop) > 0 && (key === null ? loop.reads.size > 0 : loop.reads.has(key))) loop.bad = true
}

function newStage(): Stage {
  return { argv: [], quoted: [], redirects: [], inputs: [], stdin: false, heredoc: false }
}

/** Splits on && || ; | and newlines outside quotes. Quotes are removed from tokens. */
function scan(command: string, vars?: ShellVars): Scanned {
  if (vars && PRIVATE_USE.test(command)) return { why: 'private-use characters' }
  const known = vars?.known
  const loopStack: LoopStack = { frames: [], counter: 0, reads: new Set(), bad: false }
  const statements: Statement[] = []
  let special = false
  let pipeline: Stage[] = []
  let stage: Stage = newStage()
  let token = ''
  // The token as typed: what a token with an unresolved read goes back to.
  let raw = ''
  let inToken = false
  let bare = false
  let unresolved = false
  let changed = false
  let pending: 'out' | 'in' | null = null
  let quote: '"' | "'" | null = null
  let join: Join = ';'
  const heredocs: { delimiter: string; strip: boolean; expands: boolean }[] = []

  const key = (name: string): string => (vars?.dialect === 'powershell' ? name.toLowerCase() : name)

  const endToken = (): void => {
    if (inToken) {
      const text = changed && unresolved ? raw : token
      if (text.includes('$') && !(pending === 'out' && /^\$null$/i.test(text))) special = true
      if (pending === 'out') stage.redirects.push(text)
      else if (pending === 'in') stage.inputs.push(text)
      else if (pending === null) {
        // `X=1 cmd`: the assignment is the command's own, so a name it sets is no longer known.
        if (known && ASSIGNMENT.test(text) && stage.argv.every((w) => ASSIGNMENT.test(w))) {
          touch(loopStack, key(text.slice(0, text.indexOf('='))))
          known.delete(key(text.slice(0, text.indexOf('='))))
        }
        stage.argv.push(text)
        stage.quoted.push(!bare)
      }
      pending = null
    }
    token = ''
    raw = ''
    inToken = false
    bare = false
    unresolved = false
    changed = false
  }
  const endStage = (): void => {
    endToken()
    pending = null
    pipeline.push(stage)
    stage = newStage()
  }
  const endStatement = (next: Join): void => {
    endStage()
    const statement: Statement = { stages: pipeline, join }
    statements.push(statement)
    if (vars) noteStatement(statement, vars, loopStack)
    pipeline = []
    join = next
  }

  /** Reads a variable at `i`; returns the number of characters it covers, or 0 when it stays as typed. */
  const expand = (i: number, quoted: boolean): number => {
    if (!vars || !known || command[i - 1] === '\\') return 0
    const read = readAt(command, i, vars.dialect)
    if (!read) return 0
    // A read where the command's name goes stays opaque; so does `$x = ...`.
    if (!quoted && !inToken && pending === null && stage.argv.length === 0) return 0
    let value = known.get(read.key)
    if (value === undefined || value === '') return 0
    if (value.startsWith(GLOB_MARK)) {
      if (!quoted) return 0
      value = value.slice(1)
    } else if (!quoted && vars.dialect === 'bash' && /[\s*?[]/.test(value)) return 0
    if (loopDepth(loopStack) > 0) loopStack.reads.add(read.key)
    token += value
    raw += read.text
    inToken = true
    changed = true
    special = true
    return read.text.length
  }
  const expandPercent = (i: number): number => {
    if (vars?.percent === undefined) return 0
    const m = /^%(?:TEMP|TMP)%/i.exec(command.slice(i, i + 6))
    if (!m) return 0
    token += vars.percent
    raw += m[0]
    inToken = true
    changed = true
    return m[0].length
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && (c === '`' || (c === '$' && next === '('))) return { why: 'command substitution' }
      else {
        if (quote === '"' && (c === '$' || c === '%')) {
          const n = c === '$' ? expand(i, true) : expandPercent(i)
          if (n > 0) {
            i += n - 1
            continue
          }
          if (c === '$') unresolved = true
        }
        if (c === '&') special = true
        token += c
        raw += c
      }
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
      case '$': {
        const n = expand(i, false)
        if (n > 0) {
          i += n - 1
          break
        }
        // `${TEMP}`, `${TMP}` and `${TMPDIR}` are plain reads; every other `${` stays opaque at its brace.
        const braced = /^\$\{(?:TMPDIR|TMP|TEMP)\}/.exec(command.slice(i))?.[0] ?? c
        token += braced
        raw += braced
        inToken = true
        bare = true
        unresolved = true
        i += braced.length - 1
        break
      }
      case '{':
      case '}':
        return { why: 'braces' }
      case '<': {
        if (next === '<') {
          const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\)?([A-Za-z0-9_.-]+))(?=[\s;&|<>]|$)/.exec(command.slice(i))
          if (!m || command[i + 2] === '<') return { why: 'a heredoc' }
          if (inToken && /^\d+$/.test(token)) {
            token = ''
            raw = ''
            inToken = false
          } else endToken()
          const delimiter = m[2] ?? m[3] ?? m[5] ?? ''
          heredocs.push({ delimiter, strip: m[1] === '-', expands: m[2] === undefined && m[3] === undefined && m[4] === undefined })
          stage.stdin = true
          stage.heredoc = true
          i += m[0].length - 1
          break
        }
        // The leading file descriptor (0<) is not an argument.
        if (inToken && /^\d+$/.test(token)) {
          token = ''
          raw = ''
          inToken = false
        } else endToken()
        pending = 'in'
        stage.stdin = true
        break
      }
      case '>':
        if (inToken && /^\d+$/.test(token)) {
          token = ''
          raw = ''
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
          endStatement('&&')
        } else if (next === '>') {
          endToken()
          i++
          if (command[i + 1] === '>') i++
          pending = 'out'
        } else if (!inToken && stage.argv.length === 0 && /\s/.test(next ?? ' ')) {
          // PowerShell call operator at the start of a command.
          special = true
        } else {
          return { why: 'a background or call operator (&)' }
        }
        break
      case '|':
        if (next === '|') {
          i++
          endStatement('||')
        } else endStage()
        break
      case ';':
        endStatement(';')
        break
      case '\n': {
        endStatement(';')
        if (heredocs.length === 0) break
        // The bodies follow this line, one after the other, each ending at a line of its delimiter.
        let pos = i + 1
        for (const h of heredocs) {
          let found = false
          while (pos < command.length) {
            let eol = command.indexOf('\n', pos)
            if (eol < 0) eol = command.length
            const line = command.slice(pos, eol).replace(/\r$/, '')
            pos = eol + 1
            if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delimiter) {
              found = true
              break
            }
            // An unquoted delimiter lets the text run commands.
            if (h.expands && (line.includes('`') || line.includes('$('))) return { why: 'a heredoc whose text would run commands' }
          }
          if (!found) return { why: 'an unterminated heredoc' }
        }
        heredocs.length = 0
        i = pos - 1
        break
      }
      case ' ':
      case '\t':
      case '\r':
        endToken()
        break
      default: {
        const n = c === '%' ? expandPercent(i) : 0
        if (n > 0) {
          i += n - 1
          break
        }
        token += c
        raw += c
        inToken = true
        bare = true
      }
    }
  }
  if (quote) return { why: 'an unbalanced quote' }
  if (loopStack.bad) return { why: 'a loop that changes a variable it reads' }
  if (heredocs.length > 0) return { why: 'an unterminated heredoc' }
  endStatement(';')
  return { statements, special }
}

function setKnown(vars: ShellVars, loop: LoopStack, name: string, value: string): void {
  const key = vars.dialect === 'bash' ? name : name.toLowerCase()
  // IFS changes how an unquoted read splits into words.
  if (vars.dialect === 'bash' && name === 'IFS') {
    clearKnown(vars, loop)
    return
  }
  touch(loop, key)
  if (value === '' || value.includes('$')) vars.known.delete(key)
  else vars.known.set(key, value)
}

function clearKnown(vars: ShellVars, loop: LoopStack): void {
  touch(loop, null)
  vars.known.clear()
}

/** The loop words that make a placeholder safe (`values`) or a quoted-only read (`glob`), else null. */
function loopWords(words: string[]): { values: string[] } | { glob: true } | null {
  if (words.length === 0 || words.length > MAX_LOOP_VALUES) return null
  let glob = false
  for (const w of words) {
    if (w === '' || /[\s$~\\-]/.test(w) || /^(?:[a-zA-Z]:|[\\/])/.test(w)) return null
    if (w.split('/').some((s) => s === '..' || s.startsWith('.'))) return null
    if (/[*?[\]]/.test(w)) glob = true
  }
  return glob ? { glob: true } : { values: words }
}

/** Updates the known variables for a finished statement, and marks what kind of statement it is. */
function noteStatement(st: Statement, vars: ShellVars, loop: LoopStack): void {
  const bash = vars.dialect === 'bash'
  const key = (name: string): string => (bash ? name : name.toLowerCase())
  const first = st.stages[0]?.argv ?? []
  const peeled = peelReserved(first)
  const lead = first.slice(0, first.length - peeled.length)
  for (const w of lead) {
    if (w === 'if') st.open = 'if'
    else if (w === 'while' || w === 'until') st.open = 'loop'
    else if (w === 'done' || w === 'fi') st.close = true
  }
  let opened: string | null | undefined
  if (st.stages.length === 1 && peeled[0] === 'for' && /^[A-Za-z_]\w*$/.test(peeled[1] ?? '')) {
    const name = peeled[1]
    st.open = 'for'
    opened = key(name)
    touch(loop, opened)
    vars.known.delete(opened)
    const words = loopWords(peeled[2] === 'in' ? peeled.slice(3) : [])
    if (words !== null && 'values' in words) {
      const placeholder = `${PLACEHOLDER_START}${loop.counter++}${PLACEHOLDER_END}`
      st.forInfo = { placeholder, values: words.values }
      vars.known.set(opened, placeholder)
    } else if (words !== null) vars.known.set(opened, GLOB_MARK + name)
  } else if (st.open !== undefined) opened = null
  if (st.close) {
    const frame = loop.frames.pop()
    if (frame?.key) {
      vars.known.delete(frame.key)
    }
    if (loopDepth(loop) === 0) loop.reads.clear()
  }
  if (opened !== undefined) loop.frames.push({ loop: st.open !== 'if', key: opened })
  if (opened !== undefined && st.open === 'for') return

  const dropCd = (): void => {
    for (const k of bash ? ['PWD', 'OLDPWD'] : ['pwd', 'oldpwd']) {
      touch(loop, k)
      vars.known.delete(k)
    }
  }
  for (const s of st.stages) {
    let w = peelReserved(s.argv)
    while (w[0] === 'builtin' || (w[0] === 'command' && !w[1]?.startsWith('-'))) w = w.slice(1)
    if (w.length === 0) continue
    const single = st.stages.length === 1
    if (bash && w.every((a) => ASSIGNMENT.test(a))) {
      if (single) for (const a of w) setKnown(vars, loop, a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1))
      continue
    }
    // `X=1 export TEMP=y`: the prefix is the builtin's own, the builtin still runs.
    while (w.length > 1 && (ASSIGNMENT.test(w[0]) || PREFIXES.has(commandName(w[0])))) w = w.slice(1)
    const name = commandName(w[0])
    if (bash && w.some((a, idx) => OTHER_ASSIGNMENT.test(a) && w.slice(0, idx).every((p) => ASSIGNMENT.test(p) || OTHER_ASSIGNMENT.test(p)))) {
      clearKnown(vars, loop)
      return
    }
    if (bash && EXPORTERS.has(name)) {
      const args = w.slice(1)
      if (!single || args.some((a) => a.startsWith('-')) || !args.every((a) => ASSIGNMENT.test(a))) clearKnown(vars, loop)
      else for (const a of args) setKnown(vars, loop, a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1))
      continue
    }
    if (!bash && single && w.length === 3 && w[1] === '=' && /^\$[A-Za-z_]\w*$/.test(w[0]) && s.quoted[s.argv.length - 1] && s.redirects.length === 0) {
      setKnown(vars, loop, w[0].slice(1), w[2])
      st.assign = true
      continue
    }
    const setter =
      SETS_VARIABLES.has(name) ||
      RUNS_IN_SHELL.has(name) ||
      (name === 'printf' && w.some((a) => a.startsWith('-v'))) ||
      (!bash &&
        (POWERSHELL_VARIABLE_COMMANDS.has(name) ||
          w.some((a) => /(?<!\$)\benv:|\bvariable:/i.test(a)) ||
          runsScriptInProcess(w[0])))
    if (setter) {
      clearKnown(vars, loop)
      return
    }
    if (CD_COMMANDS.has(name)) dropCd()
  }
}

// `time`, `nohup` and the like only run what follows.
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
  const argv = [...peelReserved(words)]
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

// Redirects that write nowhere. Fd duplications such as 2>&1 never reach a stage's redirects.
const NULL_REDIRECT = /^(\/dev\/null|nul|\$null)$/i

/**
 * Each command's words as typed (quotes removed, nothing peeled), when the command is only plain
 * commands joined by && || ; | or newlines. Null when any of them has a `$`, an `&` of its own,
 * reads a < file, or redirects to a file; fd duplications (2>&1) and redirects to null don't count.
 */
export function plainStages(command: string): string[][] | null {
  const scanned = scan(command)
  if ('why' in scanned || scanned.special) return null
  const stages = scanned.statements.flatMap((s) => s.stages)
  if (stages.some((s) => s.redirects.some((r) => !NULL_REDIRECT.test(r)) || s.stdin)) return null
  return stages.map((s) => s.argv).filter((argv) => argv.length > 0)
}

interface Item {
  stages: Stage[]
  join: Join
  assign: boolean
  loops: number
  compound: boolean
}

function substitute(stages: Stage[], from: string, to: string): Stage[] {
  const sub = (s: string): string => s.split(from).join(to)
  return stages.map((s) => ({ ...s, argv: s.argv.map(sub), redirects: s.redirects.map(sub), inputs: s.inputs.map(sub) }))
}

/** The statements in order, each loop over literal words repeated once per word. */
function layout(statements: Statement[]): Item[] | { why: string } {
  const out: Item[] = []
  const stack: { kind: 'if' | 'loop' | 'for'; start: number; info?: Statement['forInfo'] }[] = []
  const unroll = (): void => {
    const frame = stack.pop()
    if (frame?.info === undefined) return
    const body = out.splice(frame.start + 1)
    for (const value of frame.info.values) {
      for (const item of body) out.push({ ...item, stages: substitute(item.stages, frame.info.placeholder, value) })
    }
  }
  for (const st of statements) {
    if (st.close) unroll()
    // A loop over literal words is repeated below, so its rounds follow one another like plain statements.
    const loops = stack.filter((f) => f.kind !== 'if' && f.info === undefined).length
    const compound = stack.some((f) => f.kind !== 'for' || f.info === undefined)
    out.push({ stages: st.stages, join: st.join, assign: st.assign === true, loops, compound })
    if (st.open !== undefined) stack.push({ kind: st.open, start: out.length - 1, info: st.forInfo })
    if (out.length > MAX_STATEMENTS) return { why: 'a loop with too many commands' }
  }
  while (stack.length > 0) unroll()
  if (out.length > MAX_STATEMENTS) return { why: 'a loop with too many commands' }
  return out
}

/**
 * Parses a command. With `vars`, reads of known variables are replaced by their values and loops over literal words
 * are repeated once per word; without them it behaves as the plain parser.
 */
export function parseShellDetailed(command: string, vars?: ShellVars): ({ opaque: false } & ParsedShell) | { opaque: true; why: string } {
  const scanned = scan(command, vars && { ...vars, known: new Map(vars.known) })
  if ('why' in scanned) return { opaque: true, why: scanned.why }
  const items = vars ? layout(scanned.statements) : scanned.statements.map((s) => ({ stages: s.stages, join: s.join, assign: false, loops: 0, compound: false }))
  if ('why' in items) return { opaque: true, why: items.why }
  const result: ParsedShell = { pipelines: [], joins: [], loops: [], compound: [] }
  let dropped = false
  for (const item of items) {
    const simple: SimpleCommand[] = []
    if (item.assign) {
      dropped = true
      continue
    }
    for (const [index, stage] of item.stages.entries()) {
      const s = analyse(stage.argv, stage.redirects)
      if (s === null) {
        // A heredoc with no command still reads its body.
        if (stage.heredoc) return { opaque: true, why: 'a heredoc' }
        continue
      }
      if ('why' in s) return { opaque: true, why: s.why }
      // Only cat and tee take a heredoc as text; anything else may run it.
      if (stage.heredoc && s.name !== 'cat' && s.name !== 'tee') return { opaque: true, why: 'a heredoc' }
      if ((index > 0 || stage.stdin) && readsStdinAsCode(s)) {
        return { opaque: true, why: `it feeds a script to ${s.name} on standard input` }
      }
      if (stage.inputs.length > 0) s.inputs = stage.inputs
      simple.push(s)
    }
    if (simple.length === 0) {
      dropped = true
      continue
    }
    if (vars && simple.some((c) => c.argv.some((a) => PRIVATE_USE.test(a)) || c.redirects.some((a) => PRIVATE_USE.test(a)))) {
      return { opaque: true, why: 'a loop variable used outside its loop' }
    }
    result.pipelines.push(simple)
    result.joins.push(dropped ? ';' : item.join)
    result.loops.push(item.loops)
    result.compound.push(item.compound)
    dropped = false
  }
  return { opaque: false, ...result }
}

export function parseShell(command: string): ShellParse {
  const parsed = parseShellDetailed(command)
  return parsed.opaque ? parsed : { opaque: false, pipelines: parsed.pipelines }
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

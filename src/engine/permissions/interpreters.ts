// How interpreters and shells get their program: code on the command line, a
// script file, or standard input. Each language has its own option grammar, so
// that options which take a value are not mistaken for the script, and options
// after the script (which belong to it) are not mistaken for interpreter options.

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])

/** How an interpreter or shell gets its program. */
export interface Program {
  /** Code is given on the command line (`node -e`, `python -c`, `bash -c`). */
  inline: boolean
  /** The program comes from standard input: no script file, `-`, or an interactive flag. */
  stdin: boolean
}

/** Looks like a script file rather than a command name. */
export function looksLikeScript(arg: string): boolean {
  return (
    !arg.startsWith('-') &&
    /\.(m?[jt]sx?|c[jt]s|py[wz]?|rb|pl|pm|t|sh|bash|zsh|ksh|fish|ps1|psm1|cmd|bat|php|lua)$/i.test(arg)
  )
}

function finish(script: string | undefined, unclear: boolean, stdinFlag = false): Program {
  const fromStdin = unclear || stdinFlag || script === undefined || script === '-' || !looksLikeScript(script)
  return { inline: false, stdin: fromStdin }
}

/** Option grammar of an interpreter whose options are whole words (node, bun, deno, php). */
interface Grammar {
  inline?: (a: string) => boolean
  interactive?: string[]
  values: Set<string>
  flag: (a: string) => boolean
  /** Options whose value is the script file (`php -f x.php`). */
  scriptOptions?: string[]
  /** A subcommand word before the script, such as `run`. */
  subcommands?: string[]
  /** Subcommands that take code interactively, such as `repl`. */
  inlineWords?: string[]
}

// Options come before the script; what follows the script belongs to it. An option
// the grammar doesn't know may take a value, so after one the script can't be told
// apart from that value: the scan goes on to the end and the script counts as unknown.
function walk(args: string[], g: Grammar): Program {
  let unclear = false
  let interactive = false
  let sub = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return finish(unclear ? undefined : args[i + 1], unclear, interactive)
    if (a === '-' || !a.startsWith('-')) {
      if (unclear) continue
      if (!sub && g.inlineWords?.includes(a)) return { inline: true, stdin: false }
      if (!sub && g.subcommands?.includes(a)) {
        sub = true
        continue
      }
      return finish(a, false, interactive)
    }
    if (g.inline?.(a)) return { inline: true, stdin: false }
    if (g.scriptOptions?.includes(a)) return finish(args[i + 1], unclear, interactive)
    if (g.interactive?.includes(a)) interactive = true
    if (a.startsWith('--') && a.includes('=')) continue
    if (g.values.has(a)) i++
    else if (!g.flag(a)) unclear = true
  }
  return finish(undefined, unclear, interactive)
}

const NODE: Grammar = {
  inline: (a) => /^(-[pe]|--eval|--print)/.test(a),
  interactive: ['-i', '--interactive'],
  values: new Set(
    ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file'].concat(
      ['--input-type', '--title', '--inspect-port', '--redirect-warnings', '--watch-path', '--test-reporter'],
      ['--test-reporter-destination', '--run', '--tsconfig'],
      // bun
      ['--preload', '--cwd', '--config', '-F', '--filter', '--install', '--tsconfig-override', '-d', '--define'],
      ['-l', '--loader', '--main-fields', '--port', '--elide-lines', '--console-depth'],
    ),
  ),
  flag: (a) =>
    /^--no-/.test(a) ||
    ['-c', '--check', '--test', '--watch', '--inspect', '--inspect-brk', '--enable-source-maps', '--expose-gc'].includes(a) ||
    ['--trace-warnings', '--trace-deprecation', '--trace-uncaught', '--preserve-symlinks', '--experimental-vm-modules'].includes(a) ||
    ['--experimental-strip-types', '--experimental-transform-types', '--abort-on-uncaught-exception'].includes(a) ||
    ['--bun', '-b', '--hot', '--smol', '--silent', '--if-present'].includes(a),
  subcommands: ['run'],
  inlineWords: ['repl'],
}
const DENO: Grammar = {
  values: new Set(['-c', '--config', '--import-map', '--lock', '--cert', '--location', '--seed', '--ext']),
  flag: (a) =>
    /^--(allow|deny|unstable)(-|$)/.test(a) ||
    ['-A', '-q', '--quiet', '--no-check', '--check', '-r', '--reload', '--watch', '--no-prompt', '--cached-only'].includes(a) ||
    ['--no-lock', '--no-npm', '--no-remote', '--inspect', '--inspect-brk', '--inspect-wait', '--env-file'].includes(a),
  subcommands: ['run'],
}
// php -r, -B, -R and -E take code; the code can be attached (`-rcode`).
const PHP: Grammar = {
  inline: (a) => /^-[rBRE]/.test(a) || /^--(run|process-begin|process-code|process-end)(=|$)/.test(a),
  interactive: ['-a', '--interactive'],
  values: new Set(['-d', '--define', '-c', '--php-ini', '-z', '--zend-extension', '-S', '--server', '-t', '--docroot', '-F']),
  flag: (a) =>
    ['-n', '--no-php-ini', '-q', '--no-header', '-l', '--syntax-check', '-s', '--syntax-highlight', '-w', '--strip'].includes(a) ||
    ['-h', '--help', '-v', '--version', '-i', '--info', '-m', '--modules', '-e', '-H', '--hide-args'].includes(a),
  scriptOptions: ['-f', '--file'],
}

// Python options are single letters that cluster (`-Bc`); -c and -m end the options.
const PYTHON_DATA_MODULES = new Set(['json', 'json.tool', 'base64', 'gzip', 'quopri', 'tokenize', 'uu'])
const PYTHON_CODE_MODULES = new Set(['timeit', 'pdb'])
const PYTHON_LONG_FLAGS = new Set(['--help', '--help-env', '--help-xoptions', '--help-all', '--version', '--list', '--list-paths'])

function pythonProgram(args: string[]): Program {
  let unclear = false
  let interactive = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return finish(unclear ? undefined : args[i + 1], unclear, interactive)
    if (a === '-' || !a.startsWith('-')) {
      if (unclear) continue
      return finish(a, false, interactive)
    }
    if (a.startsWith('--')) {
      if (a === '--check-hash-based-pycs') i++
      else if (!a.includes('=') && !PYTHON_LONG_FLAGS.has(a)) unclear = true
      continue
    }
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]
      if (letter === 'c') return { inline: true, stdin: false }
      if (letter === 'm') {
        const module = a.slice(j + 1) || (args[i + 1] ?? '')
        return { inline: PYTHON_CODE_MODULES.has(module), stdin: interactive || !PYTHON_DATA_MODULES.has(module) }
      }
      if (letter === 'i') interactive = true
      if (letter === 'W' || letter === 'X') {
        if (j === a.length - 1) i++
        break
      }
    }
  }
  return finish(undefined, unclear, interactive)
}

// Ruby and perl clusters: only an e/E that isn't part of another option's value is code.
interface Letters {
  code: string
  /** The rest of the cluster is the value. */
  rest: string
  /** ...or the next argument, when the cluster ends there. */
  next: string
  /** Followed by an optional number. */
  digits: string
  /** The rest is a value only after a colon (`-d:Mod`, `-V:name`, `-W:no-x`). */
  colon: string
}
const RUBY: Letters = { code: 'e', rest: 'rICEFxi', next: 'rICE', digits: '0TW', colon: 'W' }
const PERL: Letters = { code: 'eE', rest: 'IMmixF', next: 'IMm', digits: '0lCD', colon: 'dV' }
const RUBY_PERL_LONG_FLAGS = new Set(['--help', '--version', '--copyright', '--verbose', '--jit', '--yjit'])

interface Clusters {
  code: boolean
  /** `-i`: the files after the program are edited in place. */
  inPlace: boolean
  unclear: boolean
  /** The first argument after the options, and everything after it. */
  operands: string[]
}

function readClusters(s: Letters, args: string[]): Clusters {
  const c: Clusters = { code: false, inPlace: false, unclear: false, operands: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      c.operands = args.slice(i + 1)
      return c
    }
    if (a === '-' || !a.startsWith('-')) {
      if (c.unclear) continue
      c.operands = args.slice(i)
      return c
    }
    if (a.startsWith('--')) {
      if (!a.includes('=') && !RUBY_PERL_LONG_FLAGS.has(a)) c.unclear = true
      continue
    }
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]
      const rest = a.slice(j + 1)
      if (s.code.includes(letter)) {
        // The code is the rest of the cluster or the next argument; more options may follow.
        c.code = true
        if (rest === '') i++
        break
      }
      if (letter === 'i') c.inPlace = true
      if (s.rest.includes(letter)) {
        // Never take a following option as the value: fail closed on `-M -e`.
        const next = args[i + 1]
        if (rest === '' && s.next.includes(letter) && next !== undefined && !next.startsWith('-')) i++
        break
      }
      if (s.colon.includes(letter) && (rest.startsWith(':') || (s === PERL && letter === 'd' && rest.startsWith('t')))) break
      if (s.digits.includes(letter)) j += /^(x[0-9a-fA-F]*|\d*)/.exec(rest)?.[0].length ?? 0
    }
  }
  return c
}

function clusterProgram(s: Letters, args: string[]): Program {
  const c = readClusters(s, args)
  if (c.code) return { inline: true, stdin: false }
  return finish(c.unclear ? undefined : c.operands[0], c.unclear)
}

const SHELL_LONG_FLAGS = new Set(
  ['--norc', '--noprofile', '--login', '--posix', '--noediting', '--restricted', '--verbose'].concat(
    ['--private', '--no-config', '--interactive', '--no-execute'],
  ),
)
const SHELL_LONG_VALUES = new Set(['--rcfile', '--init-file', '--profile', '--debug', '--features', '--debug-output'])

/** sh-family shells: -c is code, -s/-i read stdin, -o/-O take a value. fish also has -C code and -p/-d/-f/-o values. */
function shellProgram(args: string[], fish: boolean): Program {
  const code = fish ? 'cC' : 'c'
  const values = fish ? 'pdfo' : 'oO'
  let unclear = false
  let interactive = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return finish(unclear ? undefined : args[i + 1], unclear, interactive)
    if (a === '-') return finish(a, unclear)
    if (!a.startsWith('-') && !a.startsWith('+')) {
      if (unclear) continue
      return finish(a, false, interactive)
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0]
      if (name === '--command' || name === '--init-command') return { inline: true, stdin: false }
      if (name === '--interactive') interactive = true
      if (SHELL_LONG_VALUES.has(a)) i++
      else if (!a.includes('=') && !SHELL_LONG_FLAGS.has(a)) unclear = true
      continue
    }
    for (const letter of a.slice(1)) {
      if (code.includes(letter) && a.startsWith('-')) return { inline: true, stdin: false }
      if (letter === 'i' || (!fish && letter === 's')) interactive = true
      if (values.includes(letter)) i++
    }
  }
  return finish(undefined, unclear, interactive)
}

function isPython(name: string): boolean {
  return name === 'py' || /^(python|pypy)[\d.]*$/.test(name)
}

/** How an interpreter or shell gets its program; null when `name` is neither. */
export function interpreterArgs(name: string, args: string[]): Program | null {
  if (SHELLS.has(name)) return shellProgram(args, name === 'fish')
  if (isPython(name)) return pythonProgram(args)
  if (name === 'ruby') return clusterProgram(RUBY, args)
  if (name === 'perl') return clusterProgram(PERL, args)
  if (name === 'php') return walk(args, PHP)
  // node --import data:text/javascript,... runs the URL's code.
  const dataUrl = args.some((a) => /(^|=)data:/i.test(a))
  if (['node', 'bun', 'tsx', 'ts-node'].includes(name)) {
    const p = walk(args, NODE)
    return { inline: p.inline || dataUrl, stdin: p.stdin }
  }
  if (name === 'deno') {
    return { inline: dataUrl || args.some((a) => a === 'eval' || a === 'repl'), stdin: walk(args, DENO).stdin }
  }
  return null
}

// GNU sed: -i[SUFFIX] / --in-place[=SUFFIX]; -e, -f and -l take a value. Long options
// match by prefix, as getopt accepts abbreviations.
function sedInPlace(args: string[]): string[] | null {
  let inPlace = false
  let script = false
  const operands: string[] = []
  const long = (a: string, option: string): boolean => {
    const name = a.split('=')[0]
    return name.length > 3 && option.startsWith(name)
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      if (long(a, '--in-place')) inPlace = true
      else if (long(a, '--expression') || long(a, '--file')) {
        script = true
        if (!a.includes('=')) i++
      } else if (long(a, '--line-length') && !a.includes('=')) i++
      continue
    }
    if (a.length < 2 || !a.startsWith('-')) {
      operands.push(a)
      continue
    }
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]
      if (letter === 'i') inPlace = true
      if (letter === 'e' || letter === 'f') script = true
      if ('efl'.includes(letter) && j === a.length - 1) i++
      if ('iefl'.includes(letter)) break
    }
  }
  if (!inPlace) return null
  return script ? operands : operands.slice(1)
}

/** Files a command edits in place (`sed -i`, `perl -i`, `ruby -i`); null when it edits none. */
export function inPlaceFiles(name: string, args: string[]): string[] | null {
  if (name === 'sed') return sedInPlace(args)
  if (name !== 'perl' && name !== 'ruby') return null
  const c = readClusters(name === 'perl' ? PERL : RUBY, args)
  if (!c.inPlace) return null
  // With -e the operands are all files; otherwise the first is the script.
  const files = c.code ? c.operands : c.operands.slice(1)
  return files.filter((a) => !a.startsWith('-'))
}

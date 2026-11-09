// Shared by the engine and the renderer: pure functions only, no Node imports.

/** What a tool call spends its time on. */
export type ToolCategory = 'tests' | 'build' | 'install' | 'git' | 'reading' | 'editing' | 'web' | 'mainbus' | 'other_tool'

/** Splits a shell command on `&&`, `||`, `;`, `|` and newlines that are not inside quotes. */
function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== null) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '&' && command[i + 1] === '&') {
      out.push(cur)
      cur = ''
      i++
    } else if (c === '|' && command[i + 1] === '|') {
      out.push(cur)
      cur = ''
      i++
    } else if (c === ';' || c === '|' || c === '\n') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

const NEUTRAL = new Set(['cd', 'set-location', 'pushd', 'popd', 'echo', 'printf', 'export', 'set', 'true', ':', 'write-host', 'write-output', 'sleep', 'start-sleep', 'source', '.', 'exit'])
const READING = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'ls', 'find', 'wc', 'get-content', 'select-string', 'get-childitem', 'type', 'dir', 'pwd', 'tree', 'diff',
  'stat', 'file', 'which', 'where', 'get-item', 'test-path', 'less', 'more', 'sort', 'uniq', 'cut', 'awk', 'jq', 'resolve-path', 'get-location', 'measure-object', 'select-object', 'where-object', 'format-table', 'out-string'
])
const EDITING = new Set(['tee', 'set-content', 'out-file', 'add-content', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'copy-item', 'move-item', 'remove-item', 'new-item', 'rmdir', 'del', 'copy', 'move', 'ni', 'ren', 'rename-item', 'clear-content'])
const RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'pnpx'])
const BUILDERS = new Set(['tsc', 'gcc', 'g++', 'clang', 'clang++', 'cc', 'make', 'cmake', 'msbuild', 'ninja', 'rustc', 'javac'])
const BUNDLERS = new Set(['vite', 'electron-vite', 'webpack', 'esbuild', 'rollup', 'electron-builder', 'next', 'tsup'])

/** A redirect to a file, not to the null device or another stream. */
const FILE_REDIRECT = /(?:^|[\s\w])(?:\d?>>?|&>)\s*(?!&|\/dev\/null|nul\b|\$null)[^\s>]/i

function programOf(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/** The segment's tokens without what only wraps a command: `&`, environment assignments, `time`, `timeout 30`, `cross-env`. */
function tokensOf(segment: string): string[] {
  const tokens = segment.replace(/^&\s+/, '').split(/\s+/)
  for (;;) {
    const t = tokens[0]
    if (t === undefined) return tokens
    if (/^[A-Za-z_]\w*=/.test(t) || ['time', 'nohup', 'command', 'cross-env'].includes(programOf(t))) tokens.shift()
    else if (programOf(t) === 'timeout') tokens.splice(0, 2)
    else return tokens
  }
}

type SegmentCategory = 'neutral' | 'tests' | 'build' | 'install' | 'git' | 'editing' | 'reading' | 'other_tool'

function segmentCategory(segment: string): SegmentCategory {
  const tokens = tokensOf(segment)
  if (tokens.length === 0 || tokens[0] === '') return 'neutral'
  const prog = programOf(tokens[0]!)
  const rest = tokens.slice(1).map((t) => t.toLowerCase())
  const redirects = FILE_REDIRECT.test(segment)
  if (NEUTRAL.has(prog) || /^\w+=/.test(tokens[0]!)) return redirects ? 'editing' : 'neutral'
  if (prog === 'git') return 'git'
  if (prog === 'sed') return rest.some((t) => /^-[a-z]*i/.test(t) && !t.startsWith('--')) || rest.includes('--in-place') ? 'editing' : redirects ? 'editing' : 'reading'
  if (EDITING.has(prog)) return 'editing'
  if (READING.has(prog)) return redirects ? 'editing' : 'reading'

  const runner = RUNNERS.has(prog)
  const sub = rest.find((t) => !t.startsWith('-'))
  const isTestToken = (t: string): boolean => /^(vitest|jest|mocha|pytest|py\.test)$/.test(t) || /[\\/](vitest|jest|mocha|pytest)(\.\w+)?$/.test(t)
  if (isTestToken(prog) || rest.some(isTestToken)) return 'tests'
  if (rest.includes('playwright') && rest.includes('test')) return 'tests'
  if (prog === 'playwright' && sub === 'test') return 'tests'
  if (['go', 'cargo', 'dotnet', 'pio', 'platformio', 'mvn', 'gradle', 'gradlew'].includes(prog) && rest.includes('test')) return 'tests'
  if (runner && rest.some((t) => /^(test|e2e)(:[\w:-]+)?$/.test(t) || t === 'playwright')) {
    if (!(rest.includes('install') && rest.includes('playwright'))) return 'tests'
  }

  if (runner && (sub === 'install' || sub === 'i' || sub === 'ci' || sub === 'add' || sub === 'remove' || sub === 'rebuild' || sub === 'dedupe' || sub === 'up' || sub === 'update')) return 'install'
  if (runner && rest.includes('playwright') && rest.includes('install')) return 'install'
  if (['pip', 'pip3', 'uv', 'virtualenv', 'venv', 'poetry', 'pipx'].includes(prog) && (prog !== 'pip' && prog !== 'pip3' ? true : sub === 'install')) return 'install'
  if (/^python3?(\.\d+)?$|^py$/.test(prog) && rest[0] === '-m' && ['venv', 'pip', 'virtualenv'].includes(rest[1] ?? '')) return 'install'

  if (BUILDERS.has(prog) || rest.some((t) => t === 'tsc')) return 'build'
  if (BUNDLERS.has(prog) && rest.includes('build')) return 'build'
  if (runner && rest.some((t) => /^(typecheck|build|compile)(:[\w:-]+)?$/.test(t) || t === 'electron-vite' || t === 'vue-tsc')) return 'build'
  if (['pio', 'platformio'].includes(prog) && sub === 'run') return 'build'
  if (['cargo', 'go', 'dotnet', 'mvn', 'gradle'].includes(prog) && ['build', 'check', 'vet', 'compile', 'package'].includes(sub ?? '')) return 'build'

  return redirects ? 'editing' : 'other_tool'
}

const CHAIN_ORDER: SegmentCategory[] = ['tests', 'build', 'install', 'git', 'other_tool', 'editing', 'reading']

/** The category of a shell command; a chain takes the first match in the order tests, build, install, git, other, editing, reading. */
export function classifyCommand(command: string): Exclude<ToolCategory, 'web' | 'mainbus'> {
  const cats = new Set(segments(command).map(segmentCategory))
  for (const c of CHAIN_ORDER) if (cats.has(c)) return c as Exclude<ToolCategory, 'web' | 'mainbus'>
  return 'other_tool'
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}

/** The category of a tool call by its name and input. */
export function classifyTool(name: string, command: string | null): ToolCategory {
  if (SHELL_TOOLS.has(name)) return classifyCommand(command ?? '')
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(name)) return 'reading'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'editing'
  if (name === 'WebFetch' || name === 'WebSearch') return 'web'
  if (name.startsWith('mcp__mainbus__')) return 'mainbus'
  return 'other_tool'
}

// Runner wrappers (`npx`, `pnpm exec`, `uv run`, ...) run another command. shell.ts
// peels them off and analyses the wrapped argv as if it had been typed directly.
// A runner's own options are recognised only before the wrapped command name. An
// option this file does not know might take a value and so shift which word is the
// command: if either reading lets the runner run a wrapped command, it is opaque.

import { looksLikeScript } from './interpreters'

/**
 * What a runner runs: the wrapped argv (null when it runs nothing but itself) and
 * the folders its options make it run in, or a reason the command can't be checked.
 */
export type Peeled = { argv: string[] | null; dirs: string[] } | { why: string }

type Inner = { argv: string[] } | { why: string } | null

interface Options {
  /** Options without a value. */
  flags?: string[]
  /** Options followed by a separate value (or written --name=value). */
  values?: string[]
  /** Options that make the runner pass a string to a shell. */
  shell?: string[]
  /** Value options that set the folder the runner works in (`pnpm -C`, `npm --prefix`). */
  cwd?: string[]
}

type Skipped = { index: number } | { why: string; unknown?: true }
/** How to read an option the lists don't know: stop, or assume it takes no value or one. */
type Unknown = 'stop' | 'flag' | 'value'

/** Values of folder options anywhere before `--`, once the options can't be read in order. */
function collectDirs(args: string[], o: Options, dirs: string[]): void {
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const a = args[i]
    for (const option of o.cwd ?? []) {
      if (a === option && args[i + 1] !== undefined) dirs.push(args[i + 1])
      else if (a.startsWith(`${option}=`)) dirs.push(a.slice(option.length + 1))
    }
  }
}

/** Index of the first argument after the runner's options. Folder option values go to `dirs`. */
function skipOptions(runner: string, args: string[], o: Options, dirs: string[], unknown: Unknown = 'stop'): Skipped {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return { index: i + 1 }
    if (!a.startsWith('-') || a === '-') return { index: i }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const name = eq < 0 ? a : a.slice(0, eq)
    if (o.shell?.includes(name)) return { why: `${runner} runs a shell string` }
    if (o.values?.includes(name)) {
      const value = eq < 0 ? args[++i] : a.slice(eq + 1)
      if (o.cwd?.includes(name) && value !== undefined) dirs.push(value)
    } else if (!o.flags?.includes(name) && eq < 0) {
      if (unknown === 'flag') continue
      if (unknown === 'value') {
        if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++
        continue
      }
      collectDirs(args.slice(i + 1), o, dirs)
      return { why: `${runner} has an option Mainbus doesn't know: ${a}`, unknown: true }
    }
  }
  return { index: args.length }
}

/** `node@20` and `@scope/pkg@1.2` name the same program as `node` and `@scope/pkg`. */
function withoutVersion(name: string): string {
  return name.replace(/(?<=.)@[^@/\\]*$/, '')
}

function runs(runner: string, args: string[], o: Options, dirs: string[], packages = false): Inner {
  const skipped = skipOptions(runner, args, o, dirs)
  if ('why' in skipped) {
    // A runner with nothing but flags (`npx --foo`) runs no command.
    return skipped.unknown && args.every((a) => a.startsWith('-') && a !== '-') ? null : skipped
  }
  const rest = args.slice(skipped.index)
  if (rest.length === 0) return null
  if (rest[0] === '-') return { why: `${runner} reads a script from standard input` }
  return { argv: [packages ? withoutVersion(rest[0]) : rest[0], ...rest.slice(1)] }
}

// Runners that pass their arguments through a shell: anything beyond plain words can't be checked.
function runsShellWords(runner: string, args: string[]): Inner {
  if (args.some((a) => !/^[\w@%+=:,./-]+$/.test(a))) return { why: `${runner} runs a shell string` }
  return args.length === 0 ? null : { argv: args }
}

/** Given the subcommand and its arguments, what the runner runs; null for built-ins. */
type Pick = (sub: string | undefined, rest: string[], dirs: string[]) => Inner

/** `<runner> [global options] <subcommand> <args>`. */
function dispatch(runner: string, args: string[], global: Options, dirs: string[], pick: Pick): Inner {
  const skipped = skipOptions(runner, args, global, dirs)
  if ('index' in skipped) return pick(args[skipped.index], args.slice(skipped.index + 1), dirs)
  if (!skipped.unknown) return skipped
  // Read the unknown option both ways; opaque only if either reading runs a wrapped command.
  for (const mode of ['flag', 'value'] as const) {
    const t = skipOptions(runner, args, global, [], mode)
    if ('why' in t || pick(args[t.index], args.slice(t.index + 1), []) !== null) return skipped
  }
  return null
}

const HELP = ['-v', '--version', '-h', '--help']
const NPX: Options = {
  flags: ['-y', '--yes', '--no', '--no-install', '--ignore-existing', '-q', '--quiet', '-s', '--silent'].concat(
    ['--prefer-offline', '--prefer-online', '--offline', '--workspaces', '-ws', '--include-workspace-root'],
    HELP,
  ),
  values: ['-p', '--package', '--registry', '--cache', '--loglevel', '-w', '--workspace', '--prefix', '-C', '--userconfig'],
  shell: ['-c', '--call'],
  cwd: ['--prefix', '-C'],
}
const NPM_GLOBAL: Options = {
  flags: ['-g', '--global', '-s', '--silent', '-q', '--quiet', '-d', '--verbose', '--json', '-y', '--yes'].concat(
    ['--workspaces', '-ws', '--include-workspace-root', '--offline', '--prefer-offline', '--prefer-online'],
    ['--if-present', '--ignore-scripts', '--no-audit', '--no-fund'],
    HELP,
  ),
  values: ['--prefix', '-C', '-w', '--workspace', '--registry', '--cache', '--loglevel', '--userconfig'],
  cwd: ['--prefix', '-C'],
}
const PNPM_GLOBAL: Options = {
  flags: ['-r', '--recursive', '-w', '--workspace-root', '-s', '--silent', '--parallel', '--stream'].concat(
    ['--aggregate-output', '--sequential', '--reverse', '--include-workspace-root', '--fail-if-no-match'],
    ['--no-bail', '--bail', '--color', '--no-color', '--report-summary', '--no-reporter-hide-prefix'],
    ['--if-present', '--prefer-offline', '--offline', '--frozen-lockfile', '--no-frozen-lockfile', '--ignore-scripts'],
    HELP,
  ),
  values: ['-C', '--dir', '-F', '--filter', '--filter-prod', '--reporter', '--loglevel', '--workspace-concurrency'].concat(
    ['--resume-from', '--test-pattern', '--changed-files-ignore-pattern'],
  ),
  shell: ['-c', '--shell-mode'],
  cwd: ['-C', '--dir'],
}
const PNPM_DLX: Options = {
  flags: ['-s', '--silent'],
  values: ['--package', '--allow-build', '--reporter'],
  shell: ['-c', '--shell-mode'],
}
const YARN_GLOBAL: Options = {
  flags: ['-s', '--silent', '--offline', '--verbose', '--frozen-lockfile', '--immutable', '--prefer-offline'].concat(
    ['--ignore-scripts', '--non-interactive', '--no-progress', '--if-present'],
    HELP,
  ),
  values: ['--cwd', '--mutex'],
  cwd: ['--cwd'],
}
const YARN_RUN: Options = {
  flags: ['-T', '--top-level', '-B', '--binaries-only', '--inspect', '--inspect-brk'],
  values: ['--require'],
}
const YARN_DLX: Options = { flags: ['-q', '--quiet'], values: ['-p', '--package'] }
const YARN_FOREACH: Options = {
  flags: ['-A', '--all', '-R', '--recursive', '-W', '--worktree', '-v', '--verbose', '-p', '--parallel'].concat(
    ['-i', '--interlaced', '-t', '--topological', '--topological-dev', '--since', '-n', '--no-private'],
  ),
  values: ['-j', '--jobs', '--include', '--exclude', '--from'],
}
const BUN_GLOBAL: Options = {
  flags: ['--bun', '-b', '--silent', '--watch', '--hot', '--smol', '--no-install', '--if-present', '-i'].concat(
    ['--prefer-offline', '--frozen-lockfile'],
    HELP,
  ),
  values: ['--cwd', '-F', '--filter', '--elide-lines', '-r', '--preload', '--env-file', '--config'],
  cwd: ['--cwd'],
}
const BUN_X: Options = { flags: ['--bun', '-b', '--silent', '--verbose', '--no-install'], values: ['-p', '--package'] }
const UV_GLOBAL: Options = {
  flags: ['-q', '--quiet', '-v', '--verbose', '--offline', '--no-cache', '-n', '--native-tls', '--preview'].concat(
    ['--no-progress', '--no-config', '--managed-python', '--no-managed-python', '--no-python-downloads'],
    ['-V', '--version', '-h', '--help'],
  ),
  values: ['--directory', '--project', '--cache-dir', '--config-file', '--color', '--python-preference'],
  cwd: ['--directory'],
}
const UV_RUN: Options = {
  flags: [...(UV_GLOBAL.flags ?? [])].concat(
    ['--all-extras', '--all-packages', '--all-groups', '--no-dev', '--dev', '--no-sync', '--frozen', '--locked'],
    ['--isolated', '--no-project', '--active', '-s', '--script', '--gui-script', '--no-env-file', '--exact'],
    ['--no-editable', '--refresh'],
  ),
  values: [...(UV_GLOBAL.values ?? [])].concat(
    ['--with', '--with-editable', '--with-requirements', '-p', '--python', '--package', '--env-file', '--extra'],
    ['--group', '--only-group', '--no-group', '--index', '--default-index', '--index-url', '--extra-index-url'],
  ),
  cwd: UV_GLOBAL.cwd,
}
const UVX: Options = {
  flags: [...(UV_GLOBAL.flags ?? []), '--isolated', '--refresh'],
  values: [...(UV_GLOBAL.values ?? [])].concat(
    ['--from', '--with', '--with-editable', '--with-requirements', '-p', '--python', '--env-file'],
    ['--index', '--default-index', '--index-url', '--extra-index-url'],
  ),
  cwd: UV_GLOBAL.cwd,
}
const POETRY: Options = {
  flags: ['-q', '--quiet', '-v', '-vv', '-vvv', '--verbose', '-n', '--no-interaction', '--ansi', '--no-ansi'].concat(
    ['--no-plugins', '--no-cache', '-V', '--version', '-h', '--help'],
  ),
  values: ['-C', '--directory', '-P', '--project'],
  cwd: ['-C', '--directory'],
}
const PIPENV: Options = { flags: ['-q', '--quiet', '-v', '--verbose', '--site-packages', '--system'], values: ['--python'] }
const CONDA_RUN: Options = {
  flags: ['--no-capture-output', '--live-stream', '-v', '--verbose', '--dev', '--debug-wrapper-scripts'],
  values: ['-n', '--name', '-p', '--prefix', '--cwd', '-a', '--attach'],
  cwd: ['--cwd'],
}
const PIPX_RUN: Options = {
  flags: ['--no-cache', '--path', '--pypackages', '-v', '--verbose', '-q', '--quiet', '--system-site-packages'].concat(
    ['-e', '--editable'],
  ),
  values: ['--spec', '--python', '--pip-args', '-i', '--index-url'],
}
const VOLTA_RUN: Options = {
  flags: ['--bundled-npm', '--no-yarn', '-v', '--verbose', '-q', '--quiet'],
  values: ['--node', '--npm', '--pnpm', '--yarn', '--env'],
}
const BUNDLE_GLOBAL: Options = { flags: ['--verbose', '-V', '--no-color', ...HELP] }
const BUNDLE_EXEC: Options = { flags: ['--keep-file-descriptors'], values: ['--gemfile'] }
const DOTENV: Options = {
  flags: ['-o', '--override', '--debug', '--no-expand', '--quiet'],
  values: ['-e', '-v'],
}
const SHX: Options = { flags: ['--silent', '--verbose', '--noglob'] }
const BUSYBOX: Options = { flags: ['--help', '--list', '--list-full'] }

// Built-in subcommands that do not run another command.
const PNPM_BUILTINS = new Set(
  ['add', 'install', 'i', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'link', 'ln', 'unlink'].concat(
    ['import', 'rebuild', 'rb', 'prune', 'fetch', 'install-test', 'it', 'patch', 'patch-commit', 'patch-remove'],
    ['audit', 'list', 'ls', 'll', 'la', 'outdated', 'why', 'licenses', 'run', 'run-script', 'test', 't', 'tst'],
    ['start', 'publish', 'pack', 'server', 'store', 'root', 'bin', 'setup', 'config', 'c', 'get', 'set', 'env'],
    ['deploy', 'doctor', 'init', 'help', 'self-update', 'approve-builds', 'ignored-builds', 'create', 'dedupe'],
    ['login', 'logout', 'whoami', 'version', 'view', 'info', 'cat-file', 'cat-index', 'find-hash', 'sbom'],
  ),
)
const YARN_BUILTINS = new Set(
  ['add', 'audit', 'autoclean', 'bin', 'cache', 'check', 'config', 'constraints', 'create', 'dedupe'].concat(
    ['explain', 'global', 'help', 'import', 'info', 'init', 'install', 'licenses', 'link', 'list', 'login'],
    ['logout', 'npm', 'outdated', 'owner', 'pack', 'patch', 'patch-commit', 'plugin', 'policies', 'publish'],
    ['rebuild', 'remove', 'search', 'set', 'stage', 'tag', 'team', 'unlink', 'unplug', 'up', 'upgrade'],
    ['upgrade-interactive', 'version', 'versions', 'why'],
  ),
)
const BUN_BUILTINS = new Set(
  ['test', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'outdated', 'link', 'unlink', 'pm', 'build'].concat(
    ['init', 'create', 'c', 'upgrade', 'publish', 'patch', 'patch-commit', 'audit', 'info', 'why', 'help'],
    ['completions', 'repl'],
  ),
)

const npm: Pick = (sub, rest, dirs) => {
  if (sub === 'explore') return rest.includes('--') ? { why: 'npm explore runs a shell command' } : null
  if (sub !== 'exec' && sub !== 'x') return null
  // npm exec reads its own options anywhere before `--`, not only before the command.
  const dashes = rest.indexOf('--')
  const before = dashes < 0 ? rest : rest.slice(0, dashes)
  if (before.some((a) => a === '-c' || a === '--call' || a.startsWith('--call='))) return { why: 'npm runs a shell string' }
  return runs('npm', dashes < 0 ? rest : [...before, ...rest.slice(dashes + 1)], NPX, dirs, true)
}

const pnpm: Pick = (sub, rest, dirs) => {
  if (sub === undefined || PNPM_BUILTINS.has(sub)) return null
  if (sub === 'exec') return runs('pnpm', rest, PNPM_GLOBAL, dirs)
  if (sub === 'dlx') return runs('pnpm', rest, PNPM_DLX, dirs, true)
  if (['recursive', 'multi', 'm'].includes(sub)) return { argv: ['pnpm', ...rest] }
  // pnpm runs an unknown command as `pnpm exec`.
  return { argv: [sub, ...rest] }
}

const yarn: Pick = (sub, rest, dirs) => {
  if (sub === undefined || YARN_BUILTINS.has(sub)) return null
  if (sub === 'run') return runs('yarn', rest, YARN_RUN, dirs)
  if (sub === 'dlx') return runs('yarn', rest, YARN_DLX, dirs, true)
  if (sub === 'exec') return runsShellWords('yarn exec', rest)
  if (sub === 'workspace') return rest.length > 1 ? { argv: ['yarn', ...rest.slice(1)] } : null
  if (sub === 'workspaces') {
    if (rest[0] !== 'foreach') return null
    const inner = runs('yarn', rest.slice(1), YARN_FOREACH, dirs)
    return inner !== null && 'argv' in inner ? { argv: ['yarn', ...inner.argv] } : inner
  }
  // yarn runs a package script or binary of that name.
  return { argv: [sub, ...rest] }
}

const bun: Pick = (sub, rest, dirs) => {
  if (sub === undefined || BUN_BUILTINS.has(sub) || looksLikeScript(sub)) return null
  if (sub === 'x') return runs('bun', rest, BUN_X, dirs, true)
  if (sub === 'exec') return runsShellWords('bun exec', rest)
  if (sub === 'run') {
    // `bun run x.ts` and `bun run -` are bun itself running a script.
    const target = rest.find((a) => !a.startsWith('-'))
    if (target === undefined || rest[0] === '-' || looksLikeScript(target)) return null
    return runs('bun', rest, BUN_GLOBAL, dirs)
  }
  return { argv: [sub, ...rest] }
}

const uv: Pick = (sub, rest, dirs) => {
  if (sub === 'tool' && rest[0] === 'run') return runs('uv', rest.slice(1), UVX, dirs, true)
  if (sub !== 'run') return null
  // `uv run -m mod` is `python -m mod`, when -m comes before the command name.
  const m = rest.findIndex((a) => a === '-m' || a === '--module')
  const before = m < 0 ? null : skipOptions('uv', rest.slice(0, m), UV_RUN, dirs)
  if (before !== null && 'index' in before && before.index === m) return { argv: ['python', '-m', ...rest.slice(m + 1)] }
  return runs('uv', rest, UV_RUN, dirs)
}

/** A runner whose only wrapping subcommand is `word` (`poetry run`, `bundle exec`). */
function only(runner: string, word: string, inner: Options): Pick {
  return (sub, rest, dirs) => (sub === word ? runs(runner, rest, inner, dirs) : null)
}

type Runner = (args: string[], dirs: string[]) => Inner

const RUNNERS: Record<string, Runner> = {
  npx: (args, dirs) => runs('npx', args, NPX, dirs, true),
  pnpx: (args, dirs) => runs('pnpx', args, PNPM_DLX, dirs, true),
  bunx: (args, dirs) => runs('bunx', args, BUN_X, dirs, true),
  uvx: (args, dirs) => runs('uvx', args, UVX, dirs, true),
  npm: (args, dirs) => dispatch('npm', args, NPM_GLOBAL, dirs, npm),
  pnpm: (args, dirs) => dispatch('pnpm', args, PNPM_GLOBAL, dirs, pnpm),
  yarn: (args, dirs) => dispatch('yarn', args, YARN_GLOBAL, dirs, yarn),
  bun: (args, dirs) => dispatch('bun', args, BUN_GLOBAL, dirs, bun),
  uv: (args, dirs) => dispatch('uv', args, UV_GLOBAL, dirs, uv),
  poetry: (args, dirs) => dispatch('poetry', args, POETRY, dirs, only('poetry', 'run', POETRY)),
  pipenv: (args, dirs) => dispatch('pipenv', args, PIPENV, dirs, only('pipenv', 'run', PIPENV)),
  conda: (args, dirs) => dispatch('conda', args, {}, dirs, only('conda', 'run', CONDA_RUN)),
  mamba: (args, dirs) => dispatch('mamba', args, {}, dirs, only('mamba', 'run', CONDA_RUN)),
  micromamba: (args, dirs) => dispatch('micromamba', args, {}, dirs, only('micromamba', 'run', CONDA_RUN)),
  pipx: (args, dirs) => dispatch('pipx', args, {}, dirs, only('pipx', 'run', PIPX_RUN)),
  volta: (args, dirs) => dispatch('volta', args, {}, dirs, only('volta', 'run', VOLTA_RUN)),
  bundle: (args, dirs) => dispatch('bundle', args, BUNDLE_GLOBAL, dirs, only('bundle', 'exec', BUNDLE_EXEC)),
  bundler: (args, dirs) => dispatch('bundler', args, BUNDLE_GLOBAL, dirs, only('bundler', 'exec', BUNDLE_EXEC)),
  corepack: (args, dirs) => runs('corepack', args, {}, dirs, true),
  'cross-env': (args, dirs) => runs('cross-env', args, {}, dirs),
  'cross-env-shell': () => ({ why: 'cross-env-shell runs a shell string' }),
  dotenv: (args, dirs) => runs('dotenv', args, DOTENV, dirs),
  shx: (args, dirs) => runs('shx', args, SHX, dirs),
  busybox: (args, dirs) => runs('busybox', args, BUSYBOX, dirs),
}

/** What a runner wrapper runs; `argv: null` when `name` runs no other command. */
export function peelRunner(name: string, args: string[]): Peeled {
  const dirs: string[] = []
  const inner = Object.hasOwn(RUNNERS, name) ? RUNNERS[name](args, dirs) : null
  if (inner === null) return { argv: null, dirs }
  return 'why' in inner ? inner : { argv: inner.argv, dirs }
}

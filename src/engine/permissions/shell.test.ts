import { describe, expect, test } from 'vitest'
import { isDestructivePushArgs, parseGit, parseShell } from './shell'

function argvs(command: string): string[][][] {
  const p = parseShell(command)
  if (p.opaque) throw new Error(`opaque: ${p.why}`)
  return p.pipelines.map((pl) => pl.map((c) => c.argv))
}

describe('parseShell', () => {
  test('splits chains and pipes outside quotes only', () => {
    expect(argvs('a && b || c; d\ne')).toEqual([[['a']], [['b']], [['c']], [['d']], [['e']]])
    expect(argvs('a | b | c')).toEqual([[['a'], ['b'], ['c']]])
    expect(argvs('git commit -m "a; b | c && d"')).toEqual([[['git', 'commit', '-m', 'a; b | c && d']]])
    expect(argvs("echo 'it is (fine) {ok} $(x)'")).toEqual([[['echo', 'it is (fine) {ok} $(x)']]])
  })

  test('keeps Windows backslashes literal', () => {
    expect(argvs('rm C:\\Users\\u\\x')).toEqual([[['rm', 'C:\\Users\\u\\x']]])
  })

  test('collects output redirects and drops fd duplication and input', () => {
    const p = parseShell('echo hi 2> err.txt >> out.txt 2>&1 < in.txt')
    expect(p).toEqual({
      opaque: false,
      pipelines: [[{ name: 'echo', argv: ['echo', 'hi'], redirects: ['err.txt', 'out.txt'] }]],
    })
  })

  test('strips assignments and sudo, and lower-cases the command name', () => {
    const p = parseShell('FOO=1 BAR=2 sudo C:\\Tools\\RM.exe -rf x')
    expect(p).toMatchObject({ opaque: false, pipelines: [[{ name: 'rm', argv: ['C:\\Tools\\RM.exe', '-rf', 'x'] }]] })
  })

  test.each([
    ['a & b', 'background'],
    ['a $(b)', 'parentheses'],
    ['a `b`', 'backtick'],
    ['(a)', 'parentheses'],
    ['{ a; }', 'braces'],
    ['a <<EOF', 'heredoc'],
    ['a "b', 'unbalanced'],
    ['cmd /c dir', 'cmd'],
    ['sh -c x', 'sh'],
    ['pwsh x.ps1', 'pwsh'],
    ['$x y', 'variable'],
    ['node -e "1"', 'command line'],
    ['python3 -c "1"', 'command line'],
    ['deno eval "1"', 'command line'],
    ['python "-cimport os"', 'command line'],
    ['perl "-eunlink 1"', 'command line'],
    ['npx node -e 1', 'npx'],
    ['uv run python -c 1', 'uv'],
    ['echo 1 | node', 'standard input'],
    ['bash < x.sh', 'standard input'],
  ])('%s is opaque', (command, why) => {
    const p = parseShell(command)
    expect(p.opaque).toBe(true)
    expect(p.opaque && p.why).toContain(why)
  })

  test('interpreters running a script file are not opaque', () => {
    expect(argvs('node scripts/x.js --check')).toEqual([[['node', 'scripts/x.js', '--check']]])
    expect(argvs('python -m pytest')).toEqual([[['python', '-m', 'pytest']]])
  })

  test('runner wrappers are peeled to the command they run', () => {
    expect(argvs('npx -y prettier -c .')).toEqual([[['prettier', '-c', '.']]])
    expect(argvs('npm exec -- vitest -c x')).toEqual([[['vitest', '-c', 'x']]])
    expect(argvs('pnpm --filter app exec rm -rf x')).toEqual([[['rm', '-rf', 'x']]])
    expect(argvs('corepack yarn workspace app run build')).toEqual([[['build']]])
    expect(argvs('uv run -m pytest')).toEqual([[['python', '-m', 'pytest']]])
    expect(argvs('uv run tool -m x')).toEqual([[['tool', '-m', 'x']]])
    expect(argvs('npx node@20 x.js')).toEqual([[['node', 'x.js']]])
    expect(argvs('pnpm install zod')).toEqual([[['pnpm', 'install', 'zod']]])
  })

  test.each([
    ['npx --call x', 'shell string'],
    ['yarn exec "a b"', 'shell string'],
    ['npx --weird x y', "doesn't know"],
    ['pnpm exec env x', 'pnpm runs another command'],
    ['echo 1 | uv run python', 'standard input'],
  ])('%s is opaque (runners)', (command, why) => {
    const p = parseShell(command)
    expect(p.opaque).toBe(true)
    expect(p.opaque && p.why).toContain(why)
  })

  test('a call operator at the start is not opaque', () => {
    expect(argvs('& git status')).toEqual([[['git', 'status']]])
  })
})

describe('parseGit', () => {
  test('skips global options with separate values', () => {
    expect(parseGit(['git', '-C', 'x', '--no-pager', '--namespace', 'n', '--git-dir=y', 'push', '-f'])).toEqual({
      sub: 'push',
      rest: ['-f'],
      configs: [],
    })
    expect(parseGit(['git', '-c', 'alias.x=push', 'x'])).toMatchObject({ sub: 'x', configs: ['alias.x=push'] })
    expect(parseGit(['npm', 'push'])).toBeNull()
  })
})

describe('isDestructivePushArgs', () => {
  test('recognises options by prefix and short clusters', () => {
    expect(isDestructivePushArgs(['--force-w'])).toBe(true)
    expect(isDestructivePushArgs(['-uf'])).toBe(true)
    expect(isDestructivePushArgs(['origin', '+x'])).toBe(true)
    expect(isDestructivePushArgs(['-u', 'origin', 'x'])).toBe(false)
  })
})

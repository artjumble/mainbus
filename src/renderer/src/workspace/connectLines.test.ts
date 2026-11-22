import { spawnSync } from 'node:child_process'
import type { AgentLauncher } from '../../../shared/domain'
import { setupLines } from './connectLines'

const launcher = 'C:\\Users\\steve\\AppData\\Local\\Mainbus\\bin\\mainbus.cmd'
const stable: AgentLauncher = { kind: 'stable', program: [launcher], env: {}, exists: true }

const byId = (l: AgentLauncher, os = 'win32') => Object.fromEntries(setupLines(l, os).map((line) => [line.id, line.text]))

test('stable lines run the launcher through cmd /c for Claude Code, Codex and Copilot', () => {
  const lines = byId(stable)
  expect(lines.claude).toBe(`claude mcp add --scope user mainbus -- cmd /c ${launcher} mcp`)
  expect(lines.codex).toBe(
    '[mcp_servers.mainbus]\ncommand = "cmd"\nargs = ["/c", "C:\\\\Users\\\\steve\\\\AppData\\\\Local\\\\Mainbus\\\\bin\\\\mainbus.cmd", "mcp"]'
  )
  expect(JSON.parse(lines.copilot!)).toEqual({
    servers: { mainbus: { type: 'stdio', command: 'cmd', args: ['/c', launcher, 'mcp'] } }
  })
  expect(lines.shell).toBe(`${launcher} ticket list`)
})

test('paths with spaces are quoted', () => {
  const spaced = 'C:\\Users\\Jo Doe\\AppData\\Local\\Mainbus\\bin\\mainbus.cmd'
  const lines = byId({ ...stable, program: [spaced] })
  expect(lines.claude).toBe(`claude mcp add --scope user mainbus -- cmd /c "${spaced}" mcp`)
  expect(lines.shell).toBe(`& "${spaced}" ticket list`)
})

test('dev lines run Node on the bundle, under their own name, with the home override', () => {
  const bundle = 'C:\\src\\mainbus\\out\\cli\\mainbus.cjs'
  const lines = byId({ kind: 'dev', program: ['node', bundle], env: { MAINBUS_HOME: 'C:\\tmp\\home' }, exists: true })
  // --env must not come directly before the server name.
  expect(lines.claude).toBe(`claude mcp add --env MAINBUS_HOME=C:\\tmp\\home --scope user mainbus-dev -- node ${bundle} mcp`)
  expect(lines.codex).toBe(
    [
      '[mcp_servers.mainbus-dev]',
      'command = "node"',
      `args = [${JSON.stringify(bundle)}, "mcp"]`,
      'env = { MAINBUS_HOME = "C:\\\\tmp\\\\home" }'
    ].join('\n')
  )
  expect(JSON.parse(lines.copilot!)).toEqual({
    servers: { 'mainbus-dev': { type: 'stdio', command: 'node', args: [bundle, 'mcp'], env: { MAINBUS_HOME: 'C:\\tmp\\home' } } }
  })
  expect(lines.shell).toBe(`$env:MAINBUS_HOME = 'C:\\tmp\\home'; node ${bundle} ticket list`)
})

test("the PowerShell line single-quotes the home, so spaces, $ and quotes in it survive", () => {
  const home = "C:\\Users\\Jo O'Neil\\$tmp home"
  const lines = byId({ kind: 'dev', program: ['node', 'C:\\b.cjs'], env: { MAINBUS_HOME: home }, exists: true })
  expect(lines.shell).toBe(`$env:MAINBUS_HOME = 'C:\\Users\\Jo O''Neil\\$tmp home'; node C:\\b.cjs ticket list`)
})

describe('on macOS', () => {
  const home = '/Users/jo/Library/Application Support/Mainbus'
  const mac = (l: AgentLauncher) => byId(l, 'darwin')
  const sh = (l: AgentLauncher) => setupLines(l, 'darwin').find((line) => line.id === 'shell')!

  test('the stable launcher runs directly, with no cmd, and a plain path stays bare', () => {
    const lines = mac({ kind: 'stable', program: ['/opt/mainbus/bin/mainbus'], env: {}, exists: true })
    expect(lines.claude).toBe('claude mcp add --scope user mainbus -- /opt/mainbus/bin/mainbus mcp')
    expect(lines.claude).not.toContain('cmd')
    expect(lines.shell).toBe('/opt/mainbus/bin/mainbus ticket list')
    expect(JSON.parse(lines.copilot!).servers.mainbus).toEqual({
      type: 'stdio',
      command: '/opt/mainbus/bin/mainbus',
      args: ['mcp']
    })
  })

  test('the Application Support path is single-quoted, and JSON stays intact', () => {
    const file = `${home}/bin/mainbus`
    const l: AgentLauncher = { kind: 'stable', program: [file], env: {}, exists: true }
    const lines = mac(l)
    expect(lines.claude).toBe(`claude mcp add --scope user mainbus -- '${file}' mcp`)
    expect(lines.shell).toBe(`'${file}' ticket list`)
    expect(lines.codex).toBe(`[mcp_servers.mainbus]\ncommand = ${JSON.stringify(file)}\nargs = ["mcp"]`)
    expect(JSON.parse(lines.copilot!).servers.mainbus.command).toBe(file)
    expect(sh(l).where).toBe('The mainbus CLI, in a terminal')
  })

  test('quotes, $, ! and backticks in the path are quoted correctly', () => {
    const file = `/Users/Jo O'Neil/"q" $HOME !x \`id\`/bin/mainbus`
    const lines = mac({ kind: 'stable', program: [file], env: {}, exists: true })
    const quoted = `'/Users/Jo O'\\''Neil/"q" $HOME !x \`id\`/bin/mainbus'`
    expect(lines.claude).toBe(`claude mcp add --scope user mainbus -- ${quoted} mcp`)
    expect(lines.shell).toBe(`${quoted} ticket list`)
  })

  test('a dev launcher puts a spaced, quoted MAINBUS_HOME in --env and in the shell line', () => {
    const h = "/tmp/Jo's home"
    const lines = mac({ kind: 'dev', program: ['node', '/src/mainbus/out/cli/mainbus.cjs'], env: { MAINBUS_HOME: h }, exists: true })
    expect(lines.claude).toBe(
      "claude mcp add --env 'MAINBUS_HOME=/tmp/Jo'\\''s home' --scope user mainbus-dev -- node /src/mainbus/out/cli/mainbus.cjs mcp"
    )
    expect(lines.shell).toBe("MAINBUS_HOME='/tmp/Jo'\\''s home' node /src/mainbus/out/cli/mainbus.cjs ticket list")
  })

  test.runIf(process.platform !== 'win32')('a POSIX shell reads the quoted words back as the original arguments', () => {
    const file = `/tmp/Jo O'Neil/"q" $HOME !x \`id\` *?/bin/mainbus`
    const claude = mac({ kind: 'stable', program: [file], env: { MAINBUS_HOME: "/a b/'c'" }, exists: true }).claude!
    const words = claude.split(' -- ')[1]!
    const out = spawnSync('sh', ['-c', `for a in ${words}; do printf '%s\0' "$a"; done`], { encoding: 'utf8' })
    expect(out.stdout.split('\0').slice(0, -1)).toEqual([file, 'mcp'])
    const env = claude.match(/--env (.*) --scope/)![1]!
    const e = spawnSync('sh', ['-c', `for a in ${env}; do printf '%s' "$a"; done`], { encoding: 'utf8' })
    expect(e.stdout).toBe("MAINBUS_HOME=/a b/'c'")
  })
})

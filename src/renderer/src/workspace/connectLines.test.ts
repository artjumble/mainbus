import type { AgentLauncher } from '../../../shared/domain'
import { setupLines } from './connectLines'

const launcher = 'C:\\Users\\steve\\AppData\\Local\\Mainbus\\bin\\mainbus.cmd'
const stable: AgentLauncher = { kind: 'stable', program: [launcher], env: {}, exists: true }

const byId = (l: AgentLauncher) => Object.fromEntries(setupLines(l).map((line) => [line.id, line.text]))

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

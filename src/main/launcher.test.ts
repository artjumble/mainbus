import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentLauncher } from './launcher'

describe('agentLauncher', () => {
  it('points the stable build at bin\mainbus.cmd two folders above its Mainbus.exe', () => {
    const appRoot = path.win32.join('C:', 'Users', 'x', 'AppData', 'Local', 'Mainbus')
    const seen: string[] = []
    const launcher = agentLauncher({
      platform: 'win32',
      packaged: true,
      execPath: path.win32.join(appRoot, 'app', '20261031-0900-abc1234', 'Mainbus.exe'),
      appPath: 'unused',
      home: null,
      exists: (file) => {
        seen.push(file)
        return false
      }
    })
    const file = path.win32.resolve(appRoot, 'bin', 'mainbus.cmd')
    expect(launcher).toEqual({ kind: 'stable', program: [file], env: {}, exists: false })
    expect(seen).toEqual([file])
  })

  it('runs Node on the dev bundle and passes a MAINBUS_HOME override along', () => {
    const launcher = agentLauncher({
      platform: 'win32',
      packaged: false,
      execPath: 'electron.exe',
      appPath: path.win32.join('C:', 'src', 'mainbus'),
      home: 'C:\tmp\home',
      exists: () => true
    })
    expect(launcher).toEqual({
      kind: 'dev',
      program: ['node', path.win32.join('C:', 'src', 'mainbus', 'out', 'cli', 'mainbus.cjs')],
      env: { MAINBUS_HOME: 'C:\tmp\home' },
      exists: true
    })
  })

  it("points the macOS stable build at bin/mainbus above Mainbus.app, in a folder with a space and a quote", () => {
    const home = "/Users/Jo O'Neil/Library/Application Support/Mainbus"
    const seen: string[] = []
    const launcher = agentLauncher({
      platform: 'darwin',
      packaged: true,
      execPath: `${home}/app/20261122-1200-abc1234/Mainbus.app/Contents/MacOS/Mainbus`,
      appPath: 'unused',
      home: null,
      exists: (file) => {
        seen.push(file)
        return true
      }
    })
    expect(launcher).toEqual({ kind: 'stable', program: [`${home}/bin/mainbus`], env: {}, exists: true })
    expect(seen).toEqual([`${home}/bin/mainbus`])
  })

  it('runs Node on the dev bundle on macOS, with a MAINBUS_HOME override', () => {
    const launcher = agentLauncher({
      platform: 'darwin',
      packaged: false,
      execPath: '/x/Electron',
      appPath: '/Users/jo/src/mainbus',
      home: '/tmp/Jo home',
      exists: () => false
    })
    expect(launcher).toEqual({
      kind: 'dev',
      program: ['node', '/Users/jo/src/mainbus/out/cli/mainbus.cjs'],
      env: { MAINBUS_HOME: '/tmp/Jo home' },
      exists: false
    })
  })
})

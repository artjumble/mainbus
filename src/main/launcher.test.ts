import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentLauncher } from './launcher'

describe('agentLauncher', () => {
  it('points the stable build at bin\\mainbus.cmd two folders above its Mainbus.exe', () => {
    const appRoot = path.join('C:', 'Users', 'x', 'AppData', 'Local', 'Mainbus')
    const seen: string[] = []
    const launcher = agentLauncher({
      packaged: true,
      execPath: path.join(appRoot, 'app', '20261031-0900-abc1234', 'Mainbus.exe'),
      appPath: 'unused',
      home: null,
      exists: (file) => {
        seen.push(file)
        return false
      }
    })
    const file = path.resolve(appRoot, 'bin', 'mainbus.cmd')
    expect(launcher).toEqual({ kind: 'stable', program: [file], env: {}, exists: false })
    expect(seen).toEqual([file])
  })

  it('runs Node on the dev bundle and passes a MAINBUS_HOME override along', () => {
    const launcher = agentLauncher({
      packaged: false,
      execPath: 'electron.exe',
      appPath: path.join('C:', 'src', 'mainbus'),
      home: 'C:\\tmp\\home',
      exists: () => true
    })
    expect(launcher).toEqual({
      kind: 'dev',
      program: ['node', path.join('C:', 'src', 'mainbus', 'out', 'cli', 'mainbus.cjs')],
      env: { MAINBUS_HOME: 'C:\\tmp\\home' },
      exists: true
    })
  })
})

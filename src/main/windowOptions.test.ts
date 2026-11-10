import { expect, test } from 'vitest'
import { mainWindowOptions } from './windowOptions'

test('the window gets the app icon', () => {
  expect(mainWindowOptions({ preload: 'p.cjs', icon: 'C:\\icons\\mainbus-256.png', background: null }).icon).toBe('C:\\icons\\mainbus-256.png')
})

test('the background is set only when the scheme is known', () => {
  expect(mainWindowOptions({ preload: 'p.cjs', icon: 'i.png', background: '#011627' }).backgroundColor).toBe('#011627')
  expect(mainWindowOptions({ preload: 'p.cjs', icon: 'i.png', background: null })).not.toHaveProperty('backgroundColor')
})

test('the page stays sandboxed behind the preload', () => {
  expect(mainWindowOptions({ preload: 'p.cjs', icon: 'i.png', background: null }).webPreferences).toEqual({
    preload: 'p.cjs',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  })
})

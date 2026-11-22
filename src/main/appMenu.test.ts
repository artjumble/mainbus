import { expect, test, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from './appMenu'

const build = (platform: NodeJS.Platform, dev = false, openSettings = vi.fn()): MenuItemConstructorOptions[] | null =>
  appMenuTemplate({ platform, dev, openSettings })

const sub = (item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] => (item?.submenu ?? []) as MenuItemConstructorOptions[]

test.each(['win32', 'linux'] as const)('%s keeps the default menu', (platform) => {
  expect(build(platform)).toBeNull()
})

test('macOS has the app, Edit and Window menus, and View only in development', () => {
  const menus = build('darwin')!
  expect(menus.map((m) => m.label ?? m.role)).toEqual(['Mainbus', 'editMenu', 'window'])
  expect(build('darwin', true)!.map((m) => m.label ?? m.role)).toEqual(['Mainbus', 'editMenu', 'View', 'window'])
})

test('the app menu has About, Settings… on ⌘,, Hide and Quit, and Settings… opens the settings', () => {
  const openSettings = vi.fn()
  const app = sub(build('darwin', false, openSettings)![0])
  expect(app.filter((i) => i.type !== 'separator').map((i) => i.role ?? i.label)).toEqual([
    'about',
    'Settings…',
    'services',
    'hide',
    'hideOthers',
    'unhide',
    'quit'
  ])
  const settings = app.find((i) => i.label === 'Settings…')!
  expect(settings.accelerator).toBe('Command+,')
  ;(settings.click as () => void)()
  expect(openSettings).toHaveBeenCalledTimes(1)
})

test('the Window menu can minimize and close', () => {
  const roles = sub(build('darwin')!.find((m) => m.role === 'window')).map((i) => i.role)
  expect(roles).toContain('minimize')
  expect(roles).toContain('close')
})

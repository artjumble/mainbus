import { expect, test } from 'vitest'
import { shortcutNeedsWrite } from './shortcut'

const wanted = { target: 'C:\\Apps\\Mainbus\\Mainbus.exe', appUserModelId: 'app.mainbus' }

test('a missing shortcut is written', () => {
  expect(shortcutNeedsWrite(null, wanted)).toBe(true)
})

test('one that already points at the running build with the app ID is left alone, whatever the path case', () => {
  expect(shortcutNeedsWrite({ ...wanted }, wanted)).toBe(false)
  expect(shortcutNeedsWrite({ ...wanted, target: wanted.target.toUpperCase() }, wanted)).toBe(false)
})

test('one pointing at another build, or without the app ID, is rewritten', () => {
  expect(shortcutNeedsWrite({ ...wanted, target: 'C:\\Old\\Mainbus.exe' }, wanted)).toBe(true)
  expect(shortcutNeedsWrite({ ...wanted, appUserModelId: '' }, wanted)).toBe(true)
})

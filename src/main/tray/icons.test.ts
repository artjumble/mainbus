import { describe, expect, test } from 'vitest'
import { badgeIcon, pixelAt, trayIcon } from './icons'

describe('trayIcon', () => {
  test.each([16, 32])('is a %i px BGRA bitmap with transparent corners', (size) => {
    const bm = trayIcon(size, false)
    expect(bm.buffer.length).toBe(size * size * 4)
    expect(pixelAt(bm, 0, 0)[3]).toBe(0)
    expect(pixelAt(bm, size / 2, size / 2)[3]).toBe(255)
  })

  test('the dot is drawn in the bottom right only when asked', () => {
    const plain = trayIcon(32, false)
    const dotted = trayIcon(32, true)
    expect(pixelAt(dotted, 23, 23)).not.toEqual(pixelAt(plain, 23, 23))
    expect(pixelAt(dotted, 23, 23)).toEqual([0xf0, 0x5a, 0x1a, 255])
    expect(pixelAt(dotted, 4, 4)).toEqual(pixelAt(plain, 4, 4))
  })
})

describe('badgeIcon', () => {
  test.each(['1', '9', '9+'])('draws %s as white pixels on a red disc', (text) => {
    for (const size of [16, 32]) {
      const bm = badgeIcon(text, size)
      expect(bm.buffer.length).toBe(size * size * 4)
      expect(pixelAt(bm, 0, 0)[3]).toBe(0)
      const white = [...Array(size * size).keys()].filter((i) => {
        const [r, g, b, a] = pixelAt(bm, i % size, Math.floor(i / size))
        return a === 255 && r === 255 && g === 255 && b === 255
      })
      expect(white.length).toBeGreaterThan(5)
    }
  })

  test('different counts look different', () => {
    expect(badgeIcon('1').buffer.equals(badgeIcon('2').buffer)).toBe(false)
  })
})

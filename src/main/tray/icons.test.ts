import { describe, expect, test } from 'vitest'
import { TRAY_SIZES } from '../appIcon'
import { badgeIcon, pixelAt, trayIcon, trayIconSet, type Bitmap } from './icons'

/** A stand-in for the tray glyph's PNG: transparent, with one opaque black pixel in the top left. */
function glyph(size: number): Bitmap {
  const buffer = Buffer.alloc(size * size * 4)
  buffer[3] = 255
  return { width: size, height: size, buffer }
}

describe('trayIcon', () => {
  test.each([...TRAY_SIZES])('is the glyph unchanged at %i px without the dot', (size) => {
    const base = glyph(size)
    const bm = trayIcon(base, false)
    expect(bm.width).toBe(size)
    expect(bm.buffer.equals(base.buffer)).toBe(true)
  })

  test.each([...TRAY_SIZES])('at %i px, the orange dot is drawn in the bottom right only when asked', (size) => {
    const base = glyph(size)
    const dotted = trayIcon(base, true)
    const c = Math.floor(size * 0.72)
    expect(pixelAt(dotted, c, c)).toEqual([0xf0, 0x5a, 0x1a, 255])
    expect(pixelAt(trayIcon(base, false), c, c)[3]).toBe(0)
    // The rest of the glyph is kept, and the glyph itself isn't drawn on.
    expect(pixelAt(dotted, 0, 0)).toEqual([0, 0, 0, 255])
    expect(pixelAt(base, c, c)[3]).toBe(0)
  })
})

describe('trayIconSet', () => {
  test('has the glyph at every size, each for its display scale', () => {
    const loaded: number[] = []
    const set = trayIconSet((size) => {
      loaded.push(size)
      return glyph(size)
    }, false)
    expect(loaded).toEqual([16, 20, 24, 32, 40, 48])
    expect(set.map((r) => [r.scaleFactor, r.bitmap.width])).toEqual([
      [1, 16],
      [1.25, 20],
      [1.5, 24],
      [2, 32],
      [2.5, 40],
      [3, 48]
    ])
  })

  test('puts the dot on every size when asked, and on none otherwise', () => {
    const at = (bm: Bitmap) => pixelAt(bm, Math.floor(bm.width * 0.72), Math.floor(bm.width * 0.72))
    for (const { bitmap } of trayIconSet(glyph, true)) expect(at(bitmap)).toEqual([0xf0, 0x5a, 0x1a, 255])
    for (const { bitmap } of trayIconSet(glyph, false)) expect(at(bitmap)[3]).toBe(0)
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

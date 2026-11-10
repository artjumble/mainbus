import { TRAY_SIZES } from '../appIcon'

/**
 * Raw BGRA pixels, as Electron's nativeImage.toBitmap gives them and createFromBitmap takes them. The tray glyph comes
 * from the app's icon files (resources/icons); the needs-you dot and the taskbar badge are drawn here.
 */
export interface Bitmap {
  width: number
  height: number
  buffer: Buffer
}

type Rgb = readonly [number, number, number]

const DOT: Rgb = [0xf0, 0x5a, 0x1a]
const BADGE: Rgb = [0xd9, 0x2d, 0x20]
const WHITE: Rgb = [255, 255, 255]

function blank(size: number): Bitmap {
  return { width: size, height: size, buffer: Buffer.alloc(size * size * 4) }
}

function put(bm: Bitmap, x: number, y: number, [r, g, b]: Rgb): void {
  if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return
  const i = (y * bm.width + x) * 4
  bm.buffer[i] = b
  bm.buffer[i + 1] = g
  bm.buffer[i + 2] = r
  bm.buffer[i + 3] = 255
}

function disc(bm: Bitmap, cx: number, cy: number, radius: number, color: Rgb): void {
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius) put(bm, x, y, color)
    }
  }
}

/** The pixel at (x, y) as [r, g, b, a]. */
export function pixelAt(bm: Bitmap, x: number, y: number): [number, number, number, number] {
  const i = (y * bm.width + x) * 4
  return [bm.buffer[i + 2]!, bm.buffer[i + 1]!, bm.buffer[i]!, bm.buffer[i + 3]!]
}

/** The tray icon: the app's tray glyph; with `dot`, an orange dot over its bottom right. `glyph` is left as it is. */
export function trayIcon(glyph: Bitmap, dot: boolean): Bitmap {
  const bm: Bitmap = { width: glyph.width, height: glyph.height, buffer: Buffer.from(glyph.buffer) }
  if (dot) disc(bm, bm.width * 0.72, bm.height * 0.72, bm.width * 0.26, DOT)
  return bm
}

/**
 * The tray icon at every size in TRAY_SIZES, each with the display scale it is for (16 px is 100%), so Windows shows
 * a sharp one at any scale. `load` gives the glyph at a size.
 */
export function trayIconSet(load: (size: number) => Bitmap, dot: boolean): { scaleFactor: number; bitmap: Bitmap }[] {
  return TRAY_SIZES.map((size) => ({ scaleFactor: size / 16, bitmap: trayIcon(load(size), dot) }))
}

// A 3x5 pixel font, one string per row, for 1 to 9 and "+".
const GLYPHS: Record<string, string[]> = {
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

/** The taskbar overlay: a red disc with the count ("1" to "9", or "9+") in white. */
export function badgeIcon(text: string, size = 16): Bitmap {
  const bm = blank(size)
  disc(bm, size / 2, size / 2, size / 2, BADGE)
  const glyphs = [...text].map((c) => GLYPHS[c]).filter((g): g is string[] => !!g)
  const width = glyphs.length * 3 + (glyphs.length - 1)
  const scale = Math.max(1, Math.floor((size * 0.6) / 5))
  const x0 = Math.floor((size - width * scale) / 2)
  const y0 = Math.floor((size - 5 * scale) / 2)
  glyphs.forEach((glyph, n) => {
    glyph.forEach((row, gy) =>
      [...row].forEach((bit, gx) => {
        if (bit !== '1') return
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) put(bm, x0 + (n * 4 + gx) * scale + sx, y0 + gy * scale + sy, WHITE)
        }
      })
    )
  })
  return bm
}

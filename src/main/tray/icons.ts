/** Raw BGRA pixels, as Electron's nativeImage.createFromBitmap takes them. Drawn in code: the repo has no icon files. */
export interface Bitmap {
  width: number
  height: number
  buffer: Buffer
}

type Rgb = readonly [number, number, number]

const THEME: Rgb = [0x34, 0x6b, 0xd8]
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

/** The tray icon: a filled rounded square in the theme colour; with `dot`, an orange dot in the bottom right. */
export function trayIcon(size: number, dot: boolean): Bitmap {
  const bm = blank(size)
  const radius = size * 0.22
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Distance outside the inner rectangle, for the rounded corners.
      const dx = Math.max(radius - (x + 0.5), 0, x + 0.5 - (size - radius))
      const dy = Math.max(radius - (y + 0.5), 0, y + 0.5 - (size - radius))
      if (dx * dx + dy * dy <= radius * radius) put(bm, x, y, THEME)
    }
  }
  if (dot) disc(bm, size * 0.72, size * 0.72, size * 0.26, DOT)
  return bm
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

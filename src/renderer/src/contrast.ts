/** WCAG 2 contrast maths, for the theme test: colours as '#rgb', '#rrggbb' or 'rgba(r, g, b, a)'. */
export type Rgb = [number, number, number]

export function parseColor(color: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb, alpha: 1 }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(color.trim())
  if (fn) {
    const [r, g, b, a] = fn[1].split(',').map((p) => parseFloat(p))
    return { rgb: [r, g, b], alpha: a ?? 1 }
  }
  throw new Error(`Cannot parse the colour "${color}"`)
}

/** The colour `fg` shows as when painted over the opaque `bg`. */
export function composite(fg: string, bg: string): Rgb {
  const { rgb, alpha } = parseColor(fg)
  const under = parseColor(bg).rgb
  return rgb.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha))) as Rgb
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** The contrast ratio of `fg` on `bg` (1 to 21); a translucent `fg` is composited over `bg` first. */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(composite(fg, bg))
  const b = relativeLuminance(parseColor(bg).rgb)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

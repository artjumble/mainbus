import type { Workspace } from './domain'

/**
 * The colours a workspace's rail tile can have. Red, orange and yellow are left out because they already mean error,
 * "Needs you" and warning in the app; indigo is too close to blue and violet.
 */
export const RAIL_COLORS = ['blue', 'cyan', 'teal', 'green', 'lime', 'violet', 'grape', 'pink'] as const
export type RailColor = (typeof RAIL_COLORS)[number]

export const RAIL_COLOR_NAMES: Record<RailColor, string> = {
  blue: 'Blue',
  cyan: 'Cyan',
  teal: 'Teal',
  green: 'Green',
  lime: 'Lime',
  violet: 'Violet',
  grape: 'Grape',
  pink: 'Pink'
}

export function isRailColor(value: unknown): value is RailColor {
  return typeof value === 'string' && (RAIL_COLORS as readonly string[]).includes(value)
}

/** What the rail needs of a workspace. */
export type RailBadgeSource = Pick<Workspace, 'id' | 'name' | 'railLabel' | 'railColor'>

export const RAIL_LABEL_MAX = 3
const RAIL_LABEL_UNITS_MAX = 64

/** The form labels are compared in: case-insensitive, and the same for composed and decomposed letters. */
export function labelKey(label: string): string {
  return label.trim().normalize('NFC').toUpperCase()
}

let segmenter: Intl.Segmenter | null = null
/** The user-perceived characters of a string, so an emoji or a letter with accents counts once. */
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), (s) => s.segment)
}

export type RailLabelCheck = { ok: true; label: string | null } | { ok: false; reason: string }

/** Checks a custom short label: 1 to 3 characters with no spaces; empty (or null) clears it. Emoji are fine. */
export function checkRailLabel(input: string | null): RailLabelCheck {
  const label = (input ?? '').trim().normalize('NFC')
  if (label === '') return { ok: true, label: null }
  if (label.length > RAIL_LABEL_UNITS_MAX || graphemes(label).length > RAIL_LABEL_MAX) {
    return { ok: false, reason: `The short label can be at most ${RAIL_LABEL_MAX} characters.` }
  }
  if (/[\s\p{Cc}]/u.test(label)) return { ok: false, reason: 'The short label can’t contain spaces or control characters.' }
  return { ok: true, label }
}

const VOWELS = new Set('AEIOUY')

function wordsOf(name: string): string[] {
  return name
    .normalize('NFC')
    .toUpperCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean)
}

/** The labels a name can take, best first, each 1 to 3 characters and none repeated (by key). */
function candidatesOf(name: string): string[] {
  const words = wordsOf(name).map(graphemes)
  const out: string[] = []
  const seen = new Set<string>()
  const add = (parts: Array<string | undefined>): void => {
    if (parts.some((p) => p === undefined)) return
    const label = parts.join('')
    if (label === '' || graphemes(label).length > RAIL_LABEL_MAX) return
    const key = labelKey(label)
    if (seen.has(key)) return
    seen.add(key)
    out.push(label)
  }
  /** first letter + one later letter, consonants first, then vowels (digits and non-Latin letters count as consonants). */
  const pairs = (g: string[]): void => {
    const later = g.slice(2)
    for (const wantVowel of [false, true]) {
      for (const c of later) if (VOWELS.has(c) === wantVowel) add([g[0], c])
    }
    for (const c of later) add([g[0], g[1], c])
  }

  if (words.length === 0) {
    add([graphemes(name.trim().toUpperCase()).slice(0, 2).join('') || '?'])
    return out
  }
  const first = words[0]!
  if (words.length >= 2) {
    add([first[0], words[1]![0]])
    if (words.length >= 3) add([first[0], words[1]![0], words[2]![0]])
    const last = words[words.length - 1]!
    for (let k = 1; k < last.length; k++) add([first[0], last[0], last[k]])
    pairs(words.flat())
  } else {
    add([first.slice(0, 2).join('')])
    const trailing = /\d+$/.exec(first.join(''))?.[0]
    if (trailing !== undefined) {
      if (trailing.length === 1 && first.length >= 3) add([first[0], first[1], trailing])
      else if (first.length >= 3) add([first[0], trailing.slice(-2)])
    }
    pairs(first)
  }
  return out
}

/** The label each workspace shows: its custom one, or a distinct automatic one of 1 to 3 characters. */
export function railLabels(workspaces: readonly RailBadgeSource[]): Map<string, string> {
  const result = new Map<string, string>()
  const taken = new Set<string>()
  const auto: Array<{ id: string; cands: string[]; at: number; numbered: boolean }> = []

  for (const w of workspaces) {
    const custom = w.railLabel === null ? null : w.railLabel.trim().normalize('NFC')
    if (custom && !taken.has(labelKey(custom))) {
      taken.add(labelKey(custom))
      result.set(w.id, custom)
    } else {
      auto.push({ id: w.id, cands: candidatesOf(w.name), at: 0, numbered: false })
    }
  }
  const keyOf = (a: (typeof auto)[number]): string => labelKey(a.cands[a.at]!)

  for (;;) {
    const live = auto.filter((a) => !a.numbered)
    const counts = new Map<string, number>()
    for (const a of live) counts.set(keyOf(a), (counts.get(keyOf(a)) ?? 0) + 1)
    const colliders = live.filter((a) => taken.has(keyOf(a)) || counts.get(keyOf(a))! > 1)
    if (colliders.length === 0) break
    const settled = new Set(taken)
    for (const a of live) if (!colliders.includes(a)) settled.add(keyOf(a))
    for (const a of colliders) {
      let next = a.at + 1
      while (next < a.cands.length && settled.has(labelKey(a.cands[next]!))) next++
      if (next < a.cands.length) a.at = next
      else a.numbered = true
    }
  }

  for (const a of auto) if (!a.numbered) taken.add(keyOf(a))
  for (const a of auto) {
    if (a.numbered) {
      const base = graphemes(a.cands[0]!)
      const options: string[] = []
      if (base.length < RAIL_LABEL_MAX) for (let n = 1; n <= 9; n++) options.push(`${a.cands[0]}${n}`)
      for (let n = 10; n <= 99; n++) options.push(`${base[0]}${n}`)
      for (let n = 100; n <= 999; n++) options.push(String(n))
      const pick = options.find((o) => !taken.has(labelKey(o))) ?? '?'
      taken.add(labelKey(pick))
      result.set(a.id, pick)
    } else {
      result.set(a.id, a.cands[a.at]!)
    }
  }
  return result
}

/**
 * Why `label` can't be this workspace's custom label, or null when it can: it is malformed, or another open
 * workspace already shows it (as its own label or as its automatic one).
 */
export function railLabelProblem(label: string, id: string, workspaces: readonly RailBadgeSource[]): string | null {
  const checked = checkRailLabel(label)
  if (!checked.ok) return checked.reason
  if (checked.label === null) return null
  const shown = railLabels(workspaces.map((w) => (w.id === id ? { ...w, railLabel: null } : w)))
  const key = labelKey(checked.label)
  for (const w of workspaces) {
    if (w.id !== id && labelKey(shown.get(w.id) ?? '') === key) {
      return `${w.name} already shows ${shown.get(w.id)}. Pick another short label.`
    }
  }
  return null
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * The colour each workspace shows: its own, or one picked from its id and moved along to a colour no earlier workspace
 * has, so adding a newer workspace never changes an older one's automatic colour.
 */
export function railColors(workspaces: readonly RailBadgeSource[]): Map<string, RailColor> {
  const result = new Map<string, RailColor>()
  const used = new Set<RailColor>()
  for (const w of workspaces) {
    if (w.railColor && isRailColor(w.railColor)) {
      result.set(w.id, w.railColor)
      used.add(w.railColor)
    }
  }
  for (const w of workspaces) {
    if (result.has(w.id)) continue
    const start = fnv1a(w.id) % RAIL_COLORS.length
    let pick = RAIL_COLORS[start]!
    for (let i = 0; i < RAIL_COLORS.length; i++) {
      const c = RAIL_COLORS[(start + i) % RAIL_COLORS.length]!
      if (!used.has(c)) {
        pick = c
        break
      }
    }
    used.add(pick)
    result.set(w.id, pick)
  }
  return result
}

/** The tile each workspace shows in the rail. */
export function railBadges(workspaces: readonly RailBadgeSource[]): Map<string, { label: string; color: RailColor }> {
  const labels = railLabels(workspaces)
  const colors = railColors(workspaces)
  return new Map(workspaces.map((w) => [w.id, { label: labels.get(w.id)!, color: colors.get(w.id)! }]))
}

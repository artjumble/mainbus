import {
  checkRailLabel,
  graphemes,
  RAIL_COLORS,
  railBadges,
  railColors,
  railLabelProblem,
  railLabels,
  type RailBadgeSource
} from './railBadge'

const ws = (name: string, extra: Partial<RailBadgeSource> = {}): RailBadgeSource => ({
  id: `id-${name}`,
  name,
  railLabel: null,
  railColor: null,
  ...extra
})
const labelsOf = (...names: string[]): string[] => {
  const list = names.map((n, i) => ({ ...ws(n), id: `w${i}` }))
  const out = railLabels(list)
  return list.map((w) => out.get(w.id)!)
}

describe('railLabels', () => {
  test('a name alone keeps the old rule', () => {
    expect(labelsOf('mainbus')).toEqual(['MA'])
    expect(labelsOf('hunter')).toEqual(['HU'])
    expect(labelsOf('Waveshare esp30-c6')).toEqual(['WE'])
  })

  test('the screenshot workspaces', () => {
    expect(labelsOf('mainbus', 'hunter', 'Waveshare esp30-c6', 'mainbus-anything')).toEqual(['MN', 'HU', 'WE', 'MAN'])
  })

  test('single names with the same start', () => {
    expect(labelsOf('hunter', 'hugo')).toEqual(['HN', 'HG'])
  })

  test('names that differ only by a suffix or number', () => {
    expect(labelsOf('api', 'api2')).toEqual(['AI', 'AP2'])
    expect(labelsOf('web1', 'web2')).toEqual(['WE1', 'WE2'])
    expect(labelsOf('web10', 'web20')).toEqual(['W10', 'W20'])
  })

  test('identical names are numbered', () => {
    expect(labelsOf('app', 'app')).toEqual(['AP1', 'AP2'])
    expect(labelsOf('app', 'app', 'app')).toEqual(['AP1', 'AP2', 'AP3'])
  })

  test('a three-way collision', () => {
    expect(labelsOf('mainbus', 'mainbus-anything', 'mainframe')).toEqual(['MB', 'MAN', 'MF'])
  })

  test('very short and odd names', () => {
    expect(labelsOf('a')).toEqual(['A'])
    expect(labelsOf('x', 'x2')).toEqual(['X', 'X2'])
    expect(labelsOf('---')).toEqual(['--'])
    expect(labelsOf('')).toEqual(['?'])
    expect(labelsOf('a', 'a')).toEqual(['A1', 'A2'])
  })

  test('non-Latin names', () => {
    expect(labelsOf('日本語プロジェクト')).toEqual(['日本'])
    expect(labelsOf('проект')).toEqual(['ПР'])
    expect(graphemes(labelsOf('नमस्ते')[0]!).length).toBeLessThanOrEqual(2)
    const two = labelsOf('проект', 'проба')
    expect(two[0]).not.toBe(two[1])
  })

  test('adding a workspace that collides with nobody changes nothing', () => {
    const base = [ws('mainbus'), ws('hunter')]
    const before = railLabels(base)
    const after = railLabels([...base, ws('zeta')])
    for (const w of base) expect(after.get(w.id)).toBe(before.get(w.id))
  })

  test('adding mainbus-anything changes only mainbus', () => {
    const base = [ws('mainbus'), ws('hunter'), ws('Waveshare esp30-c6')]
    const before = railLabels(base)
    const after = railLabels([...base, ws('mainbus-anything')])
    expect(base.filter((w) => after.get(w.id) !== before.get(w.id)).map((w) => w.name)).toEqual(['mainbus'])
  })

  test('the order of the list does not change labels when names differ', () => {
    const list = [ws('mainbus'), ws('mainbus-anything'), ws('mainframe'), ws('hunter'), ws('hugo')]
    const a = railLabels(list)
    const b = railLabels([...list].reverse())
    for (const w of list) expect(b.get(w.id)).toBe(a.get(w.id))
  })

  test('custom labels win over automatic ones, and a duplicate custom label falls back', () => {
    const a = ws('alpha', { railLabel: 'MA' })
    const m = ws('mainbus')
    const labels = railLabels([a, m])
    expect(labels.get(a.id)).toBe('MA')
    expect(labels.get(m.id)).not.toBe('MA')
    const x = ws('one', { railLabel: '🚀' })
    const y = ws('two', { railLabel: '🚀' })
    const both = railLabels([x, y])
    expect(both.get(x.id)).toBe('🚀')
    expect(both.get(y.id)).toBe('TW')
  })

  test('random names always get distinct labels of 1 to 3 characters', () => {
    let seed = 12345
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const pool = ['main', 'bus', 'web', 'api', 'app', 'x', '1', '日本', 'проект', 'e-commerce', 'Mainbus']
    const list = Array.from({ length: 200 }, (_, i) => {
      const parts = Array.from({ length: 1 + rand(3) }, () => pool[rand(pool.length)]!)
      return { ...ws(parts.join(rand(2) ? '-' : '')), id: `f${i}` }
    })
    const labels = railLabels(list)
    const keys = new Set<string>()
    for (const w of list) {
      const l = labels.get(w.id)!
      expect(graphemes(l).length).toBeGreaterThanOrEqual(1)
      expect(graphemes(l).length).toBeLessThanOrEqual(3)
      keys.add(l.toUpperCase())
    }
    expect(keys.size).toBe(list.length)
  })
})

describe('checkRailLabel', () => {
  test('accepts 1 to 3 characters, emoji included, trimmed', () => {
    expect(checkRailLabel(' ab ')).toEqual({ ok: true, label: 'ab' })
    expect(checkRailLabel('🚀🚀🚀')).toEqual({ ok: true, label: '🚀🚀🚀' })
    expect(checkRailLabel('👩‍💻')).toEqual({ ok: true, label: '👩‍💻' })
  })
  test('empty or null clears', () => {
    expect(checkRailLabel('  ')).toEqual({ ok: true, label: null })
    expect(checkRailLabel(null)).toEqual({ ok: true, label: null })
  })
  test('refuses four characters, spaces and control characters', () => {
    expect(checkRailLabel('abcd').ok).toBe(false)
    expect(checkRailLabel('a b').ok).toBe(false)
    expect(checkRailLabel('a\u0007').ok).toBe(false)
    expect(checkRailLabel('a'.repeat(100)).ok).toBe(false)
  })
})

describe('railLabelProblem', () => {
  const a = ws('mainbus')
  const b = ws('hunter', { railLabel: 'HX' })
  test('refuses what another workspace shows, in any case', () => {
    expect(railLabelProblem('hx', a.id, [a, b])).toMatch(/hunter already shows HX/)
    expect(railLabelProblem('HU', a.id, [a, ws('hugo')])).toMatch(/hugo already shows/)
  })
  test('lets a workspace keep its own label and take a free one', () => {
    expect(railLabelProblem('HX', b.id, [a, b])).toBeNull()
    expect(railLabelProblem('ZZ', a.id, [a, b])).toBeNull()
  })
  test('passes malformed labels on', () => {
    expect(railLabelProblem('abcd', a.id, [a])).toMatch(/at most 3/)
  })
})

describe('railColors', () => {
  test('are deterministic and distinct while there are no more workspaces than colours', () => {
    const list = Array.from({ length: RAIL_COLORS.length }, (_, i) => ({ ...ws(`n${i}`), id: `id-${i}` }))
    const a = railColors(list)
    expect(railColors(list)).toEqual(a)
    expect(new Set(a.values()).size).toBe(RAIL_COLORS.length)
  })
  test('custom colours are kept and avoided by the automatic ones', () => {
    const custom = ws('a', { id: 'x', railColor: 'pink' })
    const other = ws('b', { id: 'y' })
    const colors = railColors([custom, other])
    expect(colors.get('x')).toBe('pink')
    expect(colors.get('y')).not.toBe('pink')
  })
  test('a newer workspace never changes an older one', () => {
    const list = Array.from({ length: 5 }, (_, i) => ({ ...ws(`n${i}`), id: `id-${i}` }))
    const before = railColors(list)
    const after = railColors([...list, { ...ws('new'), id: 'id-new' }])
    for (const w of list) expect(after.get(w.id)).toBe(before.get(w.id))
  })
  test('railBadges pairs them up', () => {
    const a = ws('mainbus')
    expect(railBadges([a]).get(a.id)).toEqual({ label: 'MA', color: railColors([a]).get(a.id) })
  })
})

import { describe, expect, it } from 'vitest'
import { branchName, slugify } from './slug'

describe('slugify', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(slugify('Rate-limit login!')).toBe('rate-limit-login')
  })

  it('falls back to "ticket" when nothing usable is left', () => {
    expect(slugify('🔥🔥')).toBe('ticket')
    expect(slugify('')).toBe('ticket')
  })

  it('suffixes Windows reserved names with -t', () => {
    expect(slugify('CON')).toBe('con-t')
    expect(slugify('com1')).toBe('com1-t')
    expect(slugify('LPT9')).toBe('lpt9-t')
    expect(slugify('console')).toBe('console')
  })

  it('normalizes with NFKD and strips diacritics', () => {
    expect(slugify('Café crème')).toBe('cafe-creme')
  })

  it('limits the slug to 40 characters with no trailing hyphen', () => {
    const slug = slugify('word '.repeat(20))
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
    expect(slugify('a'.repeat(100))).toHaveLength(40)
  })
})

describe('branchName', () => {
  it('prefixes the ticket number and slug with mainbus/', () => {
    expect(branchName(14, 'Rate-limit login')).toBe('mainbus/14-rate-limit-login')
  })
})

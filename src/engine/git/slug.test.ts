import { describe, expect, it } from 'vitest'
import { branchName, folderName, slugify } from './slug'

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

describe('folderName', () => {
  it('keeps a slug of 16 characters or fewer', () => {
    expect(folderName(14, 'Rate-limit login')).toBe('14-rate-limit-login')
  })

  it('cuts a longer slug at a word boundary', () => {
    expect(folderName(88, 'Tidy leftover npm mentions after the switch to pnpm')).toBe('88-tidy-leftover')
  })

  it('keeps 16 characters when the next one is a word boundary', () => {
    expect(folderName(5, 'abcdefghijklmnop qrs')).toBe('5-abcdefghijklmnop')
  })

  it('cuts one long word hard at 16 characters', () => {
    expect(folderName(7, 'internationalizationfeature')).toBe('7-internationaliza')
  })

  it('leaves the branch name on the longer slug', () => {
    expect(branchName(88, 'Tidy leftover npm mentions after the switch to pnpm')).toBe('mainbus/88-tidy-leftover-npm-mentions-after-the-swi')
  })
})

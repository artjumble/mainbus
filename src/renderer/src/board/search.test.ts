import { describe, expect, it } from 'vitest'
import type { BoardTicket } from '../store'
import { matchesSearch } from './search'

const ticket = {
  number: 12,
  title: 'Fix the Login bug',
  labels: ['auth', 'urgent'],
  intent: [{ text: 'Users cannot sign in on Safari', at: '2026-01-01T00:00:00Z' }]
} as unknown as BoardTicket

describe('matchesSearch', () => {
  it('matches everything when empty or blank', () => {
    expect(matchesSearch(ticket, '')).toBe(true)
    expect(matchesSearch(ticket, '   ')).toBe(true)
  })
  it('matches by number with or without #', () => {
    expect(matchesSearch(ticket, '#12')).toBe(true)
    expect(matchesSearch(ticket, '12')).toBe(true)
    expect(matchesSearch(ticket, '#13')).toBe(false)
    expect(matchesSearch(ticket, '#1')).toBe(false)
  })
  it('matches plain digits inside text too', () => {
    const t = { ...ticket, number: 3, title: 'Upgrade to v12' } as BoardTicket
    expect(matchesSearch(t, '12')).toBe(true)
    expect(matchesSearch(t, '#12')).toBe(false)
  })
  it('matches title, label and the user words, ignoring case', () => {
    expect(matchesSearch(ticket, 'login')).toBe(true)
    expect(matchesSearch(ticket, 'URGE')).toBe(true)
    expect(matchesSearch(ticket, 'safari')).toBe(true)
    expect(matchesSearch(ticket, 'nothing')).toBe(false)
  })
})

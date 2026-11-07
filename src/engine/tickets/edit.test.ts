import { describe, expect, test } from 'vitest'
import type { Ticket } from '../../shared/domain'
import { ProposalInvalid } from '../proposals/kind'
import { carryTicks, NOTHING_TO_CHANGE, parseEditInput, planEdit, whyNotEditable } from './edit'

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    workspaceId: 'w1',
    number: 7,
    kind: 'change',
    title: 'Login',
    intent: [{ text: 'Add login', at: '2026-11-01T00:00:00.000Z' }],
    spec: 'A form',
    criteria: [
      { position: 0, text: 'renders', checked: true },
      { position: 1, text: 'rejects', checked: false }
    ],
    labels: ['auth'],
    manualColumn: 'backlog',
    branch: null,
    worktreePath: null,
    pr: null,
    prError: null,
    report: null,
    reportFile: null,
    reportCommit: null,
    reportFileError: null,
    promotedFrom: null,
    runSettings: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides
  }
}

const plan = (input: unknown, t = ticket()) => planEdit(t, parseEditInput(input))

describe('parseEditInput', () => {
  test('checks each field like a ticket created by the orchestrator', () => {
    expect(() => parseEditInput({ ticket: 1, title: '  ' })).toThrow('title: must not be blank')
    expect(() => parseEditInput({ ticket: 1, title: 'a\nb' })).toThrow('title: must be a single line')
    expect(() => parseEditInput({ ticket: 1, title: 'x'.repeat(201) })).toThrow('title: must be at most 200 characters')
    expect(() => parseEditInput({ ticket: 1, spec: 'x'.repeat(100_001) })).toThrow('spec: must be at most 100000 characters')
    expect(() => parseEditInput({ ticket: 1, criteria: Array.from({ length: 51 }, () => 'c') })).toThrow('criteria: must have at most 50 items')
    expect(() => parseEditInput({ ticket: 1, criteria: [''] })).toThrow('criteria.0: must not be empty')
    expect(() => parseEditInput({ ticket: 1, labels: Array.from({ length: 21 }, () => 'l') })).toThrow('labels: must have at most 20 items')
    expect(() => parseEditInput({ title: 'X' })).toThrow(ProposalInvalid)
    expect(() => parseEditInput({ ticket: 0, title: 'X' })).toThrow('ticket:')
  })

  test('refuses unknown fields, so the intent cannot be set', () => {
    expect(() => parseEditInput({ ticket: 1, intent: 'x' })).toThrow('Unknown field: intent')
    expect(() => parseEditInput({ ticket: 1, intent: [{ text: 'x' }] })).toThrow('Unknown field: intent')
  })

  test('add_user_words can only be true: the words are never supplied', () => {
    expect(parseEditInput({ ticket: 1, add_user_words: true }).add_user_words).toBe(true)
    for (const bad of ['the user said so', false, 1, ['x']]) {
      expect(() => parseEditInput({ ticket: 1, title: 'X', add_user_words: bad })).toThrow('add_user_words')
    }
  })
})

describe('planEdit', () => {
  test('each field that differs is a change, with its old and new value', () => {
    const p = plan({ ticket: 7, title: 'Sign in', spec: 'Two fields', criteria: ['renders', 'new'], labels: ['auth', 'ui'] })
    expect(p.fields).toEqual(['title', 'spec', 'criteria', 'labels'])
    expect(p.before).toEqual({ title: 'Login', spec: 'A form', criteria: ticket().criteria, labels: ['auth'] })
    expect(p.after).toEqual({
      title: 'Sign in',
      spec: 'Two fields',
      criteria: [
        { position: 0, text: 'renders', checked: true },
        { position: 1, text: 'new', checked: false }
      ],
      labels: ['auth', 'ui']
    })
    expect(p.patch).toEqual(p.after)
    expect(p.addUserWords).toBe(false)
  })

  test('a field given the value it already has is not a change', () => {
    const p = plan({ ticket: 7, title: 'Login', spec: 'New spec', labels: ['auth'], criteria: ['renders', 'rejects'] })
    expect(p.fields).toEqual(['spec'])
    expect(p.patch).toEqual({ spec: 'New spec' })
  })

  test('a reordered criteria list is a change', () => {
    expect(plan({ ticket: 7, criteria: ['rejects', 'renders'] }).fields).toEqual(['criteria'])
  })

  test('refuses an edit that changes nothing, unless it adds the user\'s words', () => {
    expect(() => plan({ ticket: 7 })).toThrow(NOTHING_TO_CHANGE)
    expect(() => plan({ ticket: 7, title: 'Login' })).toThrow(NOTHING_TO_CHANGE)
    const p = plan({ ticket: 7, add_user_words: true })
    expect(p.fields).toEqual([])
    expect(p.addUserWords).toBe(true)
  })
})

describe('carryTicks', () => {
  const old = [
    { position: 0, text: 'a', checked: true },
    { position: 1, text: 'b', checked: true },
    { position: 2, text: 'c', checked: false }
  ]

  test('keeps a tick only where the text is unchanged, wherever it moved', () => {
    expect(carryTicks(old, ['b', 'a', 'c', 'd']).map((c) => [c.text, c.checked])).toEqual([
      ['b', true],
      ['a', true],
      ['c', false],
      ['d', false]
    ])
  })

  test('drops the tick of an edited criterion', () => {
    expect(carryTicks(old, ['a!', 'b']).map((c) => [c.text, c.checked])).toEqual([
      ['a!', false],
      ['b', true]
    ])
  })

  test('a repeated text is ticked only as many times as it was', () => {
    expect(carryTicks([{ position: 0, text: 'a', checked: true }], ['a', 'a']).map((c) => c.checked)).toEqual([true, false])
  })

  test('numbers the criteria from 0', () => {
    expect(carryTicks(old, ['x', 'y']).map((c) => c.position)).toEqual([0, 1])
  })
})

describe('whyNotEditable', () => {
  test.each(['backlog', 'ready', 'review'])('allows a %s ticket with no run open', (column) => {
    expect(whyNotEditable(ticket(), column, false)).toBeNull()
  })

  test('refuses a Done ticket', () => {
    expect(whyNotEditable(ticket(), 'done', false)).toBe("#7 is Done, and Done tickets can't be edited")
  })

  test('refuses a ticket with a run open, telling the orchestrator what to say to the user', () => {
    const why = whyNotEditable(ticket(), 'in_progress', true)!
    expect(why).toContain('#7 has a run open')
    expect(why).toContain('stop the run first, or to let it finish')
    expect(whyNotEditable(ticket(), 'ready', true)).toBe(why)
  })

  test('refuses a ticket in Needs you, whose run can still be continued', () => {
    expect(whyNotEditable(ticket(), 'needs_you', false)).toContain('#7 is in Needs you')
  })
})

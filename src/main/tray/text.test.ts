import { describe, expect, test } from 'vitest'
import type { Arrival } from './activity'
import { badgeText, needsYouLabel, toastText, tooltipText } from './text'

const arrival = (number: number, column: Arrival['column'] = 'needs_you', workspaceId = 'w1'): Arrival => ({
  workspaceId,
  ticketId: `t${number}`,
  number,
  title: `Title ${number}`,
  column,
  summary: null
})

test('the tooltip names the working and needs-you counts, leaving out a zero', () => {
  expect(tooltipText(2, 1)).toBe('Mainbus: 2 working, 1 needs you')
  expect(tooltipText(1, 0)).toBe('Mainbus: 1 working')
  expect(tooltipText(0, 3)).toBe('Mainbus: 3 needs you')
  expect(tooltipText(0, 0)).toBe('Mainbus: nothing running')
})

test('the taskbar badge shows the count up to 9, then 9+, and nothing at zero', () => {
  expect([0, 1, 9, 10, 40].map(badgeText)).toEqual([null, '1', '9', '9+', '9+'])
})

test('the menu label counts what needs you', () => {
  expect([0, 1, 3].map(needsYouLabel)).toEqual(['Nothing needs you', '1 needs you', '3 need you'])
})

describe('toastText', () => {
  test('one Needs you ticket says so, with its title and summary', () => {
    expect(toastText([{ ...arrival(12), summary: 'Where should it go?' }])).toEqual({
      title: '#12 needs you',
      body: 'Title 12 - Where should it go?'
    })
  })

  test('one Review ticket is ready for review', () => {
    expect(toastText([arrival(12, 'review')])).toEqual({ title: '#12 is ready for review', body: 'Title 12' })
  })

  test('several make one toast, listing up to three, and a mixed batch says need you too', () => {
    expect(toastText([arrival(1), arrival(2, 'review'), arrival(3)])).toEqual({
      title: '3 tickets need you',
      body: '#1 Title 1\n#2 Title 2\n#3 Title 3'
    })
    expect(toastText([1, 2, 3, 4, 5].map((n) => arrival(n))).body).toBe('#1 Title 1\n#2 Title 2\n#3 Title 3\nand 2 more')
  })

  test('with several workspaces open, the workspace name leads each line', () => {
    const names = new Map([
      ['w1', 'alpha'],
      ['w2', 'beta']
    ])
    expect(toastText([arrival(1, 'needs_you', 'w2')], names).body).toBe('beta: Title 1')
    expect(toastText([arrival(1), arrival(2, 'needs_you', 'w2')], names).body).toBe('alpha: #1 Title 1\nbeta: #2 Title 2')
  })
})

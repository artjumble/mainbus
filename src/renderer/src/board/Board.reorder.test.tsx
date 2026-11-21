import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { Board } from './Board'
import { displayRank, slotCenter, slotIn } from './reorder'

// No dnd-kit mock: the real DndContext, sensors and draggables run.
vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const initial = useMainbus.getState()
const COLUMN_IDS = ['backlog', 'ready', 'in_progress', 'needs_you', 'review', 'done']

/** jsdom has no layout: columns side by side, and the cards of each stacked 90 px apart in the order of the DOM. */
function layOut(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const labelled = this.getAttribute('aria-labelledby')
    if (labelled) return new DOMRect(COLUMN_IDS.indexOf(labelled.replace('column-', '')) * 240, 0, 220, 600)
    const section = this.closest('section')
    const column = COLUMN_IDS.indexOf(section?.getAttribute('aria-labelledby')?.replace('column-', '') ?? '')
    if (column < 0) return new DOMRect(0, 0, 0, 0)
    const cards = [...section!.querySelectorAll('[data-ticket-id]')]
    const i = cards.indexOf(this)
    return i < 0 ? new DOMRect(column * 240 + 10, 50, 200, 80) : new DOMRect(column * 240 + 10, 50 + i * 90, 200, 80)
  })
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => vi.restoreAllMocks())

/** Ready holds Alpha, Bravo, Charlie, top first, and Backlog holds Delta. */
function show(extra: Parameters<typeof makeTicket>[1][] = []) {
  const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map((title, i) => makeTicket({ title, rank: i + 1 }, { column: 'ready' }))
  const d = makeTicket({ title: 'Delta', rank: 1 }, { column: 'backlog' })
  const review = makeTicket({ title: 'Echo' }, { column: 'review', ...extra[0] })
  const reorderTicket = vi.fn().mockResolvedValue(undefined)
  const moveTicket = vi.fn().mockResolvedValue('moved')
  useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [c!, a!, b!, d, review], reorderTicket, moveTicket }, true)
  return { a: a!, b: b!, c: c!, d, review, reorderTicket, moveTicket }
}

const handle = (n: number): HTMLElement => screen.getByRole('button', { name: `Move ticket #${n}` })
const dndSays = (): string => document.body.querySelector('[id^="DndLiveRegion-"]')?.textContent ?? ''
const boardSays = (): string => screen.getByTestId('board-announcer').textContent ?? ''
const titlesIn = (column: string): string[] =>
  within(screen.getByRole('region', { name: column })).getAllByRole('button', { name: /^(Alpha|Bravo|Charlie)/ }).map((el) => /^(\w+)/.exec(el.textContent ?? '')![1]!)
const openMenu = (title: RegExp): void => void fireEvent.contextMenu(screen.getByRole('button', { name: title }))
const item = (name: string): HTMLElement => screen.getByRole('menuitem', { name })
const isDisabled = (el: HTMLElement): boolean => el.hasAttribute('disabled') || el.getAttribute('data-disabled') === 'true'

describe('the helpers', () => {
  const rects = [
    { top: 0, bottom: 80 },
    { top: 90, bottom: 170 },
    { top: 180, bottom: 260 }
  ]
  test('slotIn counts the cards whose centre is above', () => {
    expect(slotIn(-5, rects)).toBe(0)
    expect(slotIn(60, rects)).toBe(1)
    expect(slotIn(1000, rects)).toBe(3)
  })
  test('slotCenter is the top, the middle between two centres, or the bottom', () => {
    expect(slotCenter(0, rects)).toBe(0)
    expect(slotCenter(1, rects)).toBe(85)
    expect(slotCenter(3, rects)).toBe(260)
  })
  test('displayRank is between the neighbours, one above the top or one below the bottom', () => {
    const col = [
      { id: 'a', rank: 1 },
      { id: 'b', rank: 2 },
      { id: 'c', rank: 3 }
    ]
    expect(displayRank(col, 'c', 'a')).toBe(0)
    expect(displayRank(col, 'c', 'b')).toBe(1.5)
    expect(displayRank(col, 'a', null)).toBe(4)
  })
})

describe('the order on the board', () => {
  test('Backlog and Ready show cards by rank, not number', () => {
    show()
    renderWithMantine(<Board />)
    expect(titlesIn('Ready')).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  test('a pending rank shows the card in its new place at once', () => {
    const { c } = show()
    useMainbus.setState({ pendingRanks: { [c.id]: 0 } })
    renderWithMantine(<Board />)
    expect(titlesIn('Ready')).toEqual(['Charlie', 'Alpha', 'Bravo'])
  })
})

describe('reordering by keyboard', () => {
  test('Space, Up, Up, Space moves the card to the top and announces its place', async () => {
    const { a, c, reorderTicket } = show()
    layOut()
    renderWithMantine(<Board />)
    handle(c.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowUp}')
    await waitFor(() => expect(dndSays()).toMatch(/is over Ready, position 2 of 3/))
    expect(screen.getByTestId('drop-indicator')).toBeTruthy()
    await userEvent.keyboard('{ArrowUp}')
    await waitFor(() => expect(dndSays()).toMatch(/position 1 of 3/))
    await userEvent.keyboard(' ')
    await waitFor(() => expect(reorderTicket).toHaveBeenCalledWith(c.id, a.id))
    expect(dndSays()).toBe(`#${c.number} moved to position 1 of 3 in Ready.`)
    expect(screen.queryByTestId('drop-indicator')).toBeNull()
  })

  test('Down on the last card does nothing', async () => {
    const { c, reorderTicket } = show()
    layOut()
    renderWithMantine(<Board />)
    handle(c.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard(' ')
    expect(reorderTicket).not.toHaveBeenCalled()
  })

  test('Space, Right, Space moves a Backlog card into Ready with its place', async () => {
    const { a, d, moveTicket } = show()
    layOut()
    renderWithMantine(<Board />)
    handle(d.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(dndSays()).toMatch(/is over Ready, position 1 of 4/))
    await userEvent.keyboard(' ')
    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith(d.id, 'ready', a.id))
    expect(dndSays()).toBe(`#${d.number} moved to position 1 of 4 in Ready.`)
  })

  test('Up and Down do nothing in a column that is not ordered by hand', async () => {
    const { review, reorderTicket } = show()
    layOut()
    renderWithMantine(<Board />)
    handle(review.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowUp}')
    await userEvent.keyboard(' ')
    expect(reorderTicket).not.toHaveBeenCalled()
  })
})

describe("a card's menu", () => {
  test('Move to top, up, down and bottom send the right place and announce it', async () => {
    const { a, b, c, reorderTicket } = show()
    renderWithMantine(<Board />)

    openMenu(/Bravo/)
    await userEvent.click(item('Move to top'))
    expect(reorderTicket).toHaveBeenLastCalledWith(b.id, a.id)
    await waitFor(() => expect(boardSays()).toBe(`#${b.number} moved to position 1 of 3 in Ready.`))

    openMenu(/Alpha/)
    await userEvent.click(item('Move down'))
    expect(reorderTicket).toHaveBeenLastCalledWith(a.id, c.id)

    openMenu(/Bravo/)
    await userEvent.click(item('Move down'))
    expect(reorderTicket).toHaveBeenLastCalledWith(b.id, null)
    await waitFor(() => expect(boardSays()).toBe(`#${b.number} moved to position 3 of 3 in Ready.`))

    openMenu(/Bravo/)
    await userEvent.click(item('Move up'))
    expect(reorderTicket).toHaveBeenLastCalledWith(b.id, a.id)

    openMenu(/Alpha/)
    await userEvent.click(item('Move to bottom'))
    expect(reorderTicket).toHaveBeenLastCalledWith(a.id, null)
  })

  test('the first card cannot go up or to the top, the last cannot go down or to the bottom', async () => {
    show()
    renderWithMantine(<Board />)
    openMenu(/Alpha/)
    expect(isDisabled(item('Move to top'))).toBe(true)
    expect(isDisabled(item('Move up'))).toBe(true)
    expect(isDisabled(item('Move down'))).toBe(false)
    await userEvent.keyboard('{Escape}')
    openMenu(/Charlie/)
    expect(isDisabled(item('Move down'))).toBe(true)
    expect(isDisabled(item('Move to bottom'))).toBe(true)
    expect(isDisabled(item('Move up'))).toBe(false)
  })

  test('a card in Review has no reorder items', () => {
    show()
    renderWithMantine(<Board />)
    openMenu(/Echo/)
    expect(screen.queryByRole('menuitem', { name: 'Move to top' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Move to Ready' })).toBeTruthy()
  })
})

describe('while a search is on', () => {
  test('the menu items are disabled and say why, and Up does nothing', async () => {
    const { c, reorderTicket } = show()
    useMainbus.setState({ search: 'Charlie' })
    layOut()
    renderWithMantine(<Board />)
    openMenu(/Charlie/)
    for (const name of ['Move to top', 'Move up', 'Move down', 'Move to bottom']) expect(isDisabled(item(name))).toBe(true)
    expect(screen.getByText('Clear the search to reorder')).toBeTruthy()
    await userEvent.keyboard('{Escape}')

    handle(c.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowUp}')
    await userEvent.keyboard(' ')
    expect(reorderTicket).not.toHaveBeenCalled()
    await waitFor(() => expect(dndSays()).toBe(`Reordering is off while a search is on; #${c.number} stays where it was.`))
  })
})

describe('the store', () => {
  test('reorderTicket shows the new place at once, asks the engine, then lets the engine decide', async () => {
    const { a, c } = show()
    useMainbus.setState({ reorderTicket: initial.reorderTicket })
    let release: () => void = () => {}
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      if (cmd === 'ticket.reorder') return new Promise<void>((resolve) => (release = resolve))
      return Promise.resolve({ tickets: [] })
    }) as never)
    const done = useMainbus.getState().reorderTicket(c.id, a.id)
    expect(useMainbus.getState().pendingRanks[c.id]).toBe(0)
    expect(invoke).toHaveBeenCalledWith('ticket.reorder', c.id, a.id)
    release()
    await done
    expect(useMainbus.getState().pendingRanks).toEqual({})
  })

  test('moveTicket passes the place only when there is one', async () => {
    const { d, a } = show()
    useMainbus.setState({ moveTicket: initial.moveTicket })
    vi.mocked(invoke).mockResolvedValue('dirty' as never)
    await useMainbus.getState().moveTicket(d.id, 'ready')
    expect(invoke).toHaveBeenLastCalledWith('ticket.move', d.id, 'ready')
    await useMainbus.getState().moveTicket(d.id, 'ready', a.id)
    expect(invoke).toHaveBeenLastCalledWith('ticket.move', d.id, 'ready', a.id)
  })
})

describe('reordering by pointer', () => {
  test('dragging a card up inside Ready shows the drop line and reorders on release', async () => {
    const { a, c, reorderTicket } = show()
    layOut()
    renderWithMantine(<Board />)
    const card = screen.getByRole('button', { name: /Charlie/ })
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: card, coords: { clientX: 20, clientY: 270 } },
      { target: card, coords: { clientX: 20, clientY: 200 } },
      { target: card, coords: { clientX: 20, clientY: 40 } }
    ])
    await waitFor(() => expect(screen.getByTestId('drop-indicator')).toBeTruthy())
    fireEvent.pointerUp(document, { clientX: 20, clientY: 40 })
    await waitFor(() => expect(reorderTicket).toHaveBeenCalledWith(c.id, a.id))
  })
})

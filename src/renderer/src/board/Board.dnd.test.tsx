import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { Board } from './Board'

// No dnd-kit mock here: this runs the real DndContext, sensors and draggables.
vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const initial = useMainbus.getState()

/** Presses on the card, moves the pointer past the drag threshold, and reports the card wrapper's transform. */
async function dragBy(title: RegExp): Promise<string> {
  // Done's cards show only while it is open.
  act(() => screen.getByRole('region', { name: 'Done' }).focus())
  const card = screen.getByRole('button', { name: title })
  const wrapper = card.closest<HTMLElement>('[style*="touch-action"]')!
  await userEvent.pointer([
    { keys: '[MouseLeft>]', target: card, coords: { clientX: 10, clientY: 10 } },
    { target: card, coords: { clientX: 60, clientY: 60 } },
    { target: card, coords: { clientX: 120, clientY: 120 } }
  ])
  return wrapper.style.transform
}

test.each([
  ['backlog', 'not_started'],
  ['in_progress', 'implementing'],
  ['needs_you', 'waiting_on_you'],
  ['review', 'ready_for_review'],
  ['done', 'done']
] as const)('a card in %s can be picked up', async (column, phase) => {
  useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, tickets: [makeTicket({ title: 'Drag me' }, { column, phase })] }, true)
  renderWithMantine(<Board />)
  expect(await dragBy(/Drag me/)).toMatch(/translate3d\(/)
})

test('a card whose move the engine has not answered cannot be picked up', async () => {
  const ticket = makeTicket({ title: 'Drag me' }, { column: 'review', phase: 'ready_for_review' })
  useMainbus.setState(
    { ...initial, workspace, workspaceLoaded: true, tickets: [ticket], pendingMoves: { [ticket.id]: 'done' } },
    true
  )
  renderWithMantine(<Board />)
  expect(await dragBy(/Drag me/)).toBe('')
})

describe('moving a card by keyboard', () => {
  const COLUMN_IDS = ['backlog', 'ready', 'in_progress', 'needs_you', 'review', 'done']

  /**
   * jsdom has no layout: give each column a rectangle, side by side, and every other element none. Done is a
   * 44 px strip at the right, and open, a full column that grows to the left over Review.
   */
  function layOutColumns(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const labelled = this.getAttribute('aria-labelledby')
      const at = labelled ? COLUMN_IDS.indexOf(labelled.replace('column-', '')) : -1
      if (labelled === 'column-done') {
        return this.dataset.expanded === 'true' ? new DOMRect(at * 240 + 44 - 220, 0, 220, 600) : new DOMRect(at * 240, 0, 44, 600)
      }
      if (at >= 0) return new DOMRect(at * 240, 0, 220, 600)
      // A card sits in its column, 10 px from the left.
      const column = this.closest('section')?.getAttribute('aria-labelledby')
      const inColumn = column ? COLUMN_IDS.indexOf(column.replace('column-', '')) : -1
      return inColumn >= 0 ? new DOMRect(inColumn * 240 + 10, 50, 200, 80) : new DOMRect(0, 0, 0, 0)
    })
  }

  // jsdom has no scrollIntoView, which dnd-kit calls when a keyboard drag starts.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  const handle = (n: number): HTMLElement => screen.getByRole('button', { name: `Move ticket #${n}` })
  const announced = (): string => document.body.querySelector('[aria-live]')?.textContent ?? ''

  function show(): ReturnType<typeof makeTicket> {
    const ticket = makeTicket({ title: 'Drag me' }, { column: 'backlog' })
    useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [ticket] }, true)
    return ticket
  }

  test('Space on the handle picks the card up and announces it, and Escape cancels, announced', async () => {
    const ticket = show()
    renderWithMantine(<Board />)
    handle(ticket.number).focus()
    await userEvent.keyboard(' ')
    await vi.waitFor(() => expect(announced()).toBe(`Picked up ticket #${ticket.number} Drag me.`))
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(announced()).toMatch(/cancelled; it stays where it was/))
  })

  test('Enter on the title opens the ticket and does not pick the card up', async () => {
    const ticket = show()
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Drag me/ }).focus()
    await userEvent.keyboard('{Enter}')
    expect(useMainbus.getState().currentTicketId).toBe(ticket.id)
    expect(announced()).toBe('')
  })

  test('the handle has the name Move ticket #N, which does not carry the title', () => {
    const ticket = show()
    renderWithMantine(<Board />)
    expect(handle(ticket.number).getAttribute('aria-label')).not.toMatch(/Drag me/)
  })

  test('Space, Arrow Right, Space moves the card to the next column that takes drops', async () => {
    const ticket = show()
    const move = vi.fn().mockResolvedValue('moved')
    useMainbus.setState({ moveTicket: move })
    layOutColumns()
    renderWithMantine(<Board />)
    handle(ticket.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowRight}')
    await vi.waitFor(() => expect(announced()).toMatch(/is over Ready/))
    await userEvent.keyboard(' ')
    await vi.waitFor(() => expect(move).toHaveBeenCalledWith(ticket.id, 'ready'))
    expect(announced()).toMatch(/was dropped on Ready/)
  })

  test('Arrow Right skips the columns that take no drops', async () => {
    const ticket = show()
    layOutColumns()
    renderWithMantine(<Board />)
    handle(ticket.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    await vi.waitFor(() => expect(announced()).toMatch(/is over In progress, which proposes starting it/))
    await userEvent.keyboard('{ArrowRight}')
    await vi.waitFor(() => expect(announced()).toMatch(/is over Done/))
  })

  test('Arrow Right from Review onto the closed Done strip opens it, and Space drops the card in Done', async () => {
    const ticket = makeTicket({ title: 'Ship me' }, { column: 'review', phase: 'ready_for_review' })
    useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [ticket] }, true)
    const move = vi.fn().mockResolvedValue('moved')
    useMainbus.setState({ moveTicket: move })
    layOutColumns()
    renderWithMantine(<Board />)
    const done = screen.getByRole('region', { name: 'Done' })
    expect(done.dataset.expanded).toBe('false')
    handle(ticket.number).focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowRight}')
    await vi.waitFor(() => expect(announced()).toMatch(/is over Done/))
    expect(done.dataset.expanded).toBe('true')
    await userEvent.keyboard(' ')
    await vi.waitFor(() => expect(move).toHaveBeenCalledWith(ticket.id, 'done'))
    expect(announced()).toMatch(/was dropped on Done/)
  })

})

test('a card dragged out of Done keeps Done open while the drag lasts, even with focus elsewhere', async () => {
  const ticket = makeTicket({ title: 'Old work' }, { column: 'done', phase: 'done' })
  useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [ticket] }, true)
  renderWithMantine(<Board />)
  expect(await dragBy(/Old work/)).toMatch(/translate3d\(/)
  act(() => screen.getByRole('textbox', { name: 'Search tickets' }).focus())
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(screen.getByRole('region', { name: 'Done' }).dataset.expanded).toBe('true')
})

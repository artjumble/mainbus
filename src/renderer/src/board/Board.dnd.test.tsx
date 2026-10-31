import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { Board } from './Board'

// No dnd-kit mock here: this runs the real DndContext, sensors and draggables.
vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const initial = useMainbus.getState()

/** Presses on the card, moves the pointer past the drag threshold, and reports the card wrapper's transform. */
async function dragBy(title: RegExp): Promise<string> {
  const card = screen.getByRole('button', { name: title })
  const wrapper = card.parentElement as HTMLElement
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

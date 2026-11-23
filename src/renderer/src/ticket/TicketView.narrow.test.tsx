import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { TicketView, isNarrowTicketView } from './TicketView'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(() => () => {}),
  isSetupRequired: () => false
}))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

/** Lets the ticket view be measured at `width`. */
function layoutWidth(width: number): () => void {
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
  return () => spy.mockRestore()
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockImplementation(async (command: string) => (command === 'thread.get' ? { events: [], decisions: [], runs: [] } : undefined))
  vi.mocked(onEngineEvent).mockImplementation(() => () => {})
  const ticket = makeTicket({ title: 'Add dark mode', number: 12 }, { phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
})

test('narrow means a measured width under 800', () => {
  expect(isNarrowTicketView(0)).toBe(false)
  expect(isNarrowTicketView(799)).toBe(true)
  expect(isNarrowTicketView(800)).toBe(false)
})

test('wide: the side pane is inline and there is no Details button', async () => {
  const restore = layoutWidth(1000)
  try {
    renderWithMantine(<TicketView />)
    expect(await screen.findByRole('region', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
  } finally {
    restore()
  }
})

test('wide: the handle resizes the side pane and the width is remembered', async () => {
  localStorage.clear()
  const restore = layoutWidth(1000)
  try {
    const user = userEvent.setup()
    renderWithMantine(<TicketView />)
    const handle = await screen.findByRole('separator', { name: 'Resize ticket details' })
    expect(handle).toHaveAttribute('aria-valuenow', '380')
    expect(handle).toHaveAttribute('aria-valuemax', '640')
    handle.focus()
    await user.keyboard('{ArrowRight}')
    expect(handle).toHaveAttribute('aria-valuenow', '396')
    expect(localStorage.getItem('mainbus.ticketContextWidth')).toBe('396')
    await user.keyboard('{End}')
    expect(handle).toHaveAttribute('aria-valuenow', '640')
  } finally {
    restore()
    localStorage.clear()
  }
})

test('narrow: there is no handle', async () => {
  const restore = layoutWidth(700)
  try {
    renderWithMantine(<TicketView />)
    await screen.findByRole('button', { name: 'Details' })
    expect(screen.queryByRole('separator', { name: 'Resize ticket details' })).not.toBeInTheDocument()
  } finally {
    restore()
  }
})

test('narrow: the side pane is behind Details, and Escape closes it', async () => {
  const restore = layoutWidth(700)
  try {
    const user = userEvent.setup()
    renderWithMantine(<TicketView />)
    const details = await screen.findByRole('button', { name: 'Details' })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Activity' })).not.toBeInTheDocument()
    await user.click(details)
    expect(await screen.findByRole('region', { name: 'Activity' })).toBeInTheDocument()
    expect(details).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Activity' })).not.toBeInTheDocument())
    expect(details).toHaveFocus()
  } finally {
    restore()
  }
})

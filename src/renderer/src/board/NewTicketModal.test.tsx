import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { renderWithMantine } from '../test-utils'
import { NewTicketModal } from './NewTicketModal'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => (command === 'board.get' ? { tickets: [] } : {}))
})

const create = (): HTMLElement => screen.getByRole('button', { name: 'Create' })

test('NewTicketModal requires title and "In your words"', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  expect(create()).toBeDisabled()
  await userEvent.type(screen.getByLabelText(/Title/), 'Add dark mode')
  expect(create()).toBeDisabled()
  await userEvent.type(screen.getByLabelText(/In your words/), 'I want it')
  expect(create()).toBeEnabled()
  await userEvent.clear(screen.getByLabelText(/Title/))
  expect(create()).toBeDisabled()
})

test('whitespace alone does not satisfy a required field', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await userEvent.type(screen.getByLabelText(/Title/), '   ')
  await userEvent.type(screen.getByLabelText(/In your words/), '  ')
  expect(create()).toBeDisabled()
})

test('Create sends the intent unchanged and one criterion per non-blank line', async () => {
  const onClose = vi.fn()
  renderWithMantine(<NewTicketModal opened onClose={onClose} />)
  await userEvent.type(screen.getByLabelText(/Title/), 'Add dark mode')
  // user-event treats "{" and "[" specially; the text here has neither.
  await userEvent.type(screen.getByLabelText(/In your words/), '  Make it dark.\nReally dark.  ')
  await userEvent.type(screen.getByLabelText(/Acceptance criteria/), 'Toggle exists\n\n  Persists after restart  \n')
  await userEvent.click(create())

  await vi.waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith('ticket.create', {
      title: 'Add dark mode',
      intent: '  Make it dark.\nReally dark.  ',
      spec: '',
      criteria: ['Toggle exists', 'Persists after restart'],
      labels: [],
      column: 'backlog',
      kind: 'change'
    })
  )
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
})

test('the Ready option creates the ticket in Ready', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await userEvent.type(screen.getByLabelText(/Title/), 'T')
  await userEvent.type(screen.getByLabelText(/In your words/), 'W')
  await userEvent.click(screen.getByLabelText(/Put it in Ready/))
  await userEvent.click(create())
  await vi.waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.objectContaining({ column: 'ready' }))
  )
})

test('a failed create keeps the dialog open and shows the message', async () => {
  const onClose = vi.fn()
  mockInvoke.mockRejectedValue(new Error('Open a workspace first'))
  renderWithMantine(<NewTicketModal opened onClose={onClose} />)
  await userEvent.type(screen.getByLabelText(/Title/), 'T')
  await userEvent.type(screen.getByLabelText(/In your words/), 'W')
  await userEvent.click(create())
  expect(await screen.findByText('Open a workspace first')).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByLabelText(/Title/)).toHaveValue('T')
})

test('the Kind choice defaults to Change and sends Investigate when picked', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  expect(screen.getByRole('radio', { name: /^Change/ })).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: /^Investigate/ }))
  await userEvent.type(screen.getByLabelText(/Title/), 'Why is login slow')
  await userEvent.type(screen.getByLabelText(/In your words/), 'Find out')
  await userEvent.click(create())
  expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.objectContaining({ kind: 'investigate' }))
})

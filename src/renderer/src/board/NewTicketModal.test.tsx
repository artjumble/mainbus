import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, PNG_BYTES, pngFile, renderWithMantine, svgFile, transfer } from '../test-utils'
import { NewTicketModal } from './NewTicketModal'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'board.get') return { tickets: [] }
    if (command === 'preset.list' || command === 'lineup.get') return []
    return {}
  })
})

const create = (): HTMLElement => screen.getByRole('button', { name: 'Create ticket' })

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

test('the Column select defaults to Backlog; choosing Ready creates the ticket in Ready', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  expect(screen.getByLabelText('Column')).toHaveValue('backlog')
  await userEvent.type(screen.getByLabelText(/Title/), 'T')
  await userEvent.type(screen.getByLabelText(/In your words/), 'W')
  await userEvent.selectOptions(screen.getByLabelText('Column'), 'Ready')
  await userEvent.click(create())
  await vi.waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.objectContaining({ column: 'ready' }))
  )
})

test('Labels are comma separated, and the start-when-ready option is sent only when ticked', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await userEvent.type(screen.getByLabelText(/Title/), 'T')
  await userEvent.type(screen.getByLabelText(/In your words/), 'W')
  await userEvent.type(screen.getByLabelText('Labels'), 'csv, export, ')
  await userEvent.click(screen.getByLabelText("Ask the orchestrator to start an agent once it's in Ready"))
  await userEvent.click(create())
  await vi.waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith(
      'ticket.create',
      expect.objectContaining({ labels: ['csv', 'export'], column: 'backlog', startWhenReady: true })
    )
  )
})

test('the fields have placeholders saying what goes in them', () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  expect(screen.getByPlaceholderText('What needs doing')).toBeInTheDocument()
  expect(screen.getByPlaceholderText('Context the agent will need')).toBeInTheDocument()
  expect(screen.getByPlaceholderText("How you'll know it's done")).toBeInTheDocument()
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

test('the open modal has no axe violations, empty or filled in', async () => {
  renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
  await expectNoAxeViolations()
  await userEvent.type(screen.getByLabelText(/Title/), 'Add dark mode')
  await expectNoAxeViolations()
})

test('images picked, dropped or pasted are shown and saved with the ticket on Create; a refused one is not', async () => {
  const onClose = vi.fn()
  const { baseElement } = renderWithMantine(<NewTicketModal opened onClose={onClose} />)
  await userEvent.type(screen.getByLabelText(/Title/), 'Fix the header')
  await userEvent.type(screen.getByLabelText(/In your words/), 'Like the picture')

  const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(input, pngFile('picked.png'))
  await screen.findByRole('img', { name: 'picked.png' })
  fireEvent.drop(baseElement.querySelector('[data-drop-zone]')!, { dataTransfer: transfer([pngFile('dropped.png')]) })
  await screen.findByRole('img', { name: 'dropped.png' })
  // A screenshot pasted while typing in a field: it comes without a name.
  fireEvent.paste(screen.getByLabelText(/Spec/), { clipboardData: transfer([pngFile('')]) })
  await screen.findByRole('img', { name: 'pasted-image.png' })
  await userEvent.upload(input, svgFile(), { applyAccept: false })
  expect(await screen.findByText(/can carry script/)).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'logo.svg' })).toBeNull()
  expect(screen.getByRole('img', { name: 'picked.png' }).getAttribute('src')).toMatch(/^data:image\/png;base64,/)

  await userEvent.click(screen.getByRole('button', { name: 'Remove dropped.png' }))
  await userEvent.click(create())
  expect(mockInvoke).toHaveBeenCalledWith(
    'ticket.create',
    expect.objectContaining({
      title: 'Fix the header',
      attachments: [
        { name: 'picked.png', bytes: PNG_BYTES },
        { name: 'pasted-image.png', bytes: PNG_BYTES }
      ]
    })
  )
  expect(onClose).toHaveBeenCalled()
})

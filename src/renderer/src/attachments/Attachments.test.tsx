import { fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Attachment } from '../../../shared/attachments'
import { invoke } from '../api'
import { expectNoAxeViolations, makeTicket, PNG_BYTES as PNG, pngFile, renderWithMantine, svgFile, transfer } from '../test-utils'
import { AttachmentsSection } from './Attachments'
import { useImagePaste } from './files'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const attachment = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'a1',
  ticketId: 't',
  filename: 'login.png',
  mime: 'image/png',
  size: 12,
  sha256: 'x',
  createdAt: '2026-11-03T10:00:00.000Z',
  ...over
})

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string, id: string) => (command === 'attachment.data' ? `data:image/png;base64,${id}` : undefined))
})

test('shows a thumbnail for each image, from a data URL by id, and opens a larger preview', async () => {
  const ticket = makeTicket({ attachments: [attachment(), attachment({ id: 'a2', filename: 'error.png' })] })
  renderWithMantine(<AttachmentsSection ticket={ticket} />)
  await waitFor(() => expect(screen.getByRole('img', { name: 'login.png' })).toHaveAttribute('src', 'data:image/png;base64,a1'))
  expect(screen.getByRole('img', { name: 'error.png' })).toHaveAttribute('src', 'data:image/png;base64,a2')
  expect(mockInvoke).toHaveBeenCalledWith('attachment.data', 'a1')

  await userEvent.click(screen.getByRole('button', { name: 'Preview error.png' }))
  const dialog = await screen.findByRole('dialog', { name: 'error.png' })
  expect(within(dialog).getByRole('img', { name: 'error.png' })).toHaveAttribute('src', 'data:image/png;base64,a2')
  await expectNoAxeViolations()
})

test('removes an image', async () => {
  const ticket = makeTicket({ attachments: [attachment({ id: 'gone', filename: 'old.png' })] })
  renderWithMantine(<AttachmentsSection ticket={ticket} />)
  await userEvent.click(screen.getByRole('button', { name: 'Remove old.png' }))
  expect(mockInvoke).toHaveBeenCalledWith('attachment.remove', 'gone')
})

test('attaches picked images, and refuses one that is not an image with its reason', async () => {
  const ticket = makeTicket()
  const { container } = renderWithMantine(<AttachmentsSection ticket={ticket} />)
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/gif,image/webp')
  await userEvent.upload(input, pngFile('picked.png'), { applyAccept: false })
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('attachment.add', ticket.id, 'picked.png', PNG))

  mockInvoke.mockClear()
  await userEvent.upload(input, svgFile(), { applyAccept: false })
  expect(await screen.findByText(/logo\.svg is an SVG .* can carry script/)).toBeInTheDocument()
  expect(mockInvoke).not.toHaveBeenCalledWith('attachment.add', expect.anything(), expect.anything(), expect.anything())
})

test('attaches dropped images', async () => {
  const ticket = makeTicket()
  const { container } = renderWithMantine(<AttachmentsSection ticket={ticket} />)
  const zone = container.querySelector('[data-drop-zone]')!
  fireEvent.dragOver(zone, { dataTransfer: transfer([pngFile('dropped.png')]) })
  fireEvent.drop(zone, { dataTransfer: transfer([pngFile('dropped.png')]) })
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('attachment.add', ticket.id, 'dropped.png', PNG))
})

test('a ticket with 20 images offers no more', () => {
  const ticket = makeTicket({ attachments: Array.from({ length: 20 }, (_, i) => attachment({ id: `a${i}`, filename: `s${i}.png` })) })
  const { container } = renderWithMantine(<AttachmentsSection ticket={ticket} />)
  expect(container.querySelector('[data-drop-zone]')).toBeNull()
  expect(screen.getByText('A ticket can have at most 20 images.')).toBeInTheDocument()
})

describe('useImagePaste', () => {
  test('takes an image pasted anywhere but a text field, and leaves text alone', () => {
    const onFiles = vi.fn()
    renderHook(() => useImagePaste(onFiles))
    const field = document.createElement('textarea')
    document.body.append(field)
    try {
      fireEvent.paste(document.body, { clipboardData: transfer([pngFile()]) })
      expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'shot.png' })])

      onFiles.mockClear()
      fireEvent.paste(field, { clipboardData: transfer([pngFile()]) })
      fireEvent.paste(document.body, { clipboardData: transfer([], 'just text') })
      expect(onFiles).not.toHaveBeenCalled()
    } finally {
      field.remove()
    }
  })
})

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VOICE_MODELS } from '../../../shared/voice'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { ModelDownloadModal } from './ModelDownloadModal'

const model = VOICE_MODELS[0]!

function show(status: Parameters<typeof ModelDownloadModal>[0]['status']) {
  const fns = { onClose: vi.fn(), onDownload: vi.fn(), onCancel: vi.fn() }
  const view = renderWithMantine(<ModelDownloadModal opened model={model} status={status} {...fns} />)
  return { ...fns, ...view }
}

test('says what is downloaded, from where and how big, and downloads only when asked', async () => {
  const { onDownload } = show({ id: model.id, installed: false, download: null, error: null })
  expect(screen.getByText(/Whisper base model \(209 MB\)/)).toBeInTheDocument()
  expect(screen.getByText(/huggingface\.co\/onnx-community\/whisper-base\/resolve\/27a07b4b/)).toBeInTheDocument()
  expect(screen.getByText(/Audio never leaves your computer/)).toBeInTheDocument()
  expect(onDownload).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Download 209 MB' }))
  expect(onDownload).toHaveBeenCalled()
})

test('shows the progress and cancels', async () => {
  const { onCancel, container } = show({ id: model.id, installed: false, download: { loaded: 84_000_000, total: 209_000_000 }, error: null })
  expect(screen.getByRole('progressbar', { name: 'Download progress' })).toBeInTheDocument()
  expect(screen.getByText('84 MB of 209 MB')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel download' }))
  expect(onCancel).toHaveBeenCalled()
  await expectNoAxeViolations(container)
})

test('when it is installed it says to press the mic, and does not record by itself', () => {
  show({ id: model.id, installed: true, download: null, error: null })
  expect(screen.getByText('Ready. Press the mic to dictate.')).toBeInTheDocument()
})

test('shows a failed download', () => {
  show({ id: model.id, installed: false, download: null, error: 'config.json doesn’t match its checksum' })
  expect(screen.getByRole('alert')).toHaveTextContent('checksum')
})

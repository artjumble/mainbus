import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { VoiceModelStatus, VoiceSettings as Voice } from '../../../shared/voice'
import { invoke, onEngineEvent } from '../api'
import { expectNoAxeViolations, optionLabels, renderWithMantine } from '../test-utils'
import { VoiceSettings } from './VoiceSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
let stored: Voice
let models: VoiceModelStatus[]
let emit: (e: unknown) => void

beforeEach(() => {
  stored = { enabled: true, model: 'whisper-base', language: 'auto', microphone: '' }
  models = [
    { id: 'whisper-base', installed: false, download: null, error: null },
    { id: 'whisper-small', installed: true, download: null, error: null }
  ]
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return { voice: stored }
    if (command === 'voice.models') return models
    if (command === 'settings.setVoice') {
      stored = { ...stored, ...(args[0] as Partial<Voice>) }
      return { voice: stored }
    }
    if (command === 'voice.downloadModel' || command === 'voice.removeModel' || command === 'voice.cancelDownload') return models
    return undefined
  })
  ;(onEngineEvent as unknown as ReturnType<typeof vi.fn>).mockImplementation((l: (e: unknown) => void) => {
    emit = l
    return () => {}
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'USB Mic' },
        { kind: 'audioinput', deviceId: 'mic-2', label: '' },
        { kind: 'videoinput', deviceId: 'cam', label: 'Camera' }
      ],
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  })
})

test('does nothing while the settings are closed', () => {
  renderWithMantine(<VoiceSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('turns voice input on and off, and the model, language and microphone follow', async () => {
  const user = userEvent.setup()
  renderWithMantine(<VoiceSettings opened />)
  const toggle = await screen.findByRole('switch', { name: /^Voice input/ })
  await vi.waitFor(() => expect(toggle).toBeChecked())
  await user.click(toggle)
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setVoice', { enabled: false }))
  expect(toggle).not.toBeChecked()
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'Microphone' })).toBeDisabled()
})

test('offers each model with its size, Automatic and the languages, and the microphones the system has', async () => {
  renderWithMantine(<VoiceSettings opened />)
  const model = await screen.findByRole('combobox', { name: 'Model' })
  expect(optionLabels(model)).toEqual(['Whisper base (209 MB)', 'Whisper small (589 MB)'])
  const language = screen.getByRole('combobox', { name: 'Language' })
  expect(optionLabels(language)[0]).toBe('Automatic (English)')
  expect(optionLabels(language)).toContain('English')
  await vi.waitFor(() => expect(optionLabels(screen.getByRole('combobox', { name: 'Microphone' }))).toEqual(['System default', 'USB Mic', 'Microphone 2']))
})

test('saves the model, the language and the microphone', async () => {
  const user = userEvent.setup()
  renderWithMantine(<VoiceSettings opened />)
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Model' }), 'whisper-small')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setVoice', { model: 'whisper-small' }))
  await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'de')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setVoice', { language: 'de' }))
  await vi.waitFor(() => expect(optionLabels(screen.getByRole('combobox', { name: 'Microphone' }))).toContain('USB Mic'))
  await user.selectOptions(screen.getByRole('combobox', { name: 'Microphone' }), 'mic-1')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setVoice', { microphone: 'mic-1' }))
  expect(stored).toEqual({ enabled: true, model: 'whisper-small', language: 'de', microphone: 'mic-1' })
})

test('a saved microphone that is gone is noted, and dictation falls back to the default', async () => {
  stored.microphone = 'unplugged'
  renderWithMantine(<VoiceSettings opened />)
  expect(await screen.findByText(/saved microphone isn.t connected/)).toBeInTheDocument()
})

test('Download starts the download, shows its progress, and Remove deletes a downloaded model', async () => {
  const user = userEvent.setup()
  renderWithMantine(<VoiceSettings opened />)
  await user.click(await screen.findByRole('button', { name: 'Download Whisper base' }))
  expect(mockInvoke).toHaveBeenCalledWith('voice.downloadModel', 'whisper-base')
  emit({ type: 'voice.models', models: [{ id: 'whisper-base', installed: false, download: { loaded: 84_000_000, total: 210_000_000 }, error: null }] })
  expect(await screen.findByText('Downloading Whisper base: 84 MB of 210 MB')).toBeInTheDocument()
  expect(screen.getByRole('progressbar', { name: 'Download progress' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Cancel download' }))
  expect(mockInvoke).toHaveBeenCalledWith('voice.cancelDownload', 'whisper-base')

  await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'whisper-small')
  await user.click(await screen.findByRole('button', { name: 'Remove Whisper small' }))
  expect(mockInvoke).toHaveBeenCalledWith('voice.removeModel', 'whisper-small')
})

test('has no accessibility violations', async () => {
  const { container } = renderWithMantine(<VoiceSettings opened />)
  await screen.findByRole('switch', { name: /^Voice input/ })
  await expectNoAxeViolations(container)
})

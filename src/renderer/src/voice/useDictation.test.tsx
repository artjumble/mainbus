import { Modal } from '@mantine/core'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { invoke, onEngineEvent } from '../api'
import { expectNoAxeViolations } from '../test-utils'
import { FakeAudioSource, FakeTranscriber } from './fakeVoice'
import { DictationTextarea } from './DictationTextarea'
import { VoiceError } from './types'
import { renderWithVoice } from './testVoice'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockInvoke.mockReset()
  ;(onEngineEvent as unknown as ReturnType<typeof vi.fn>).mockReset()
})

function Field({ initial = '', label = 'Notes', onOuterKey }: { initial?: string; label?: string; onOuterKey?: (key: string) => void }): ReactElement {
  const [value, setValue] = useState(initial)
  return (
    <div onKeyDown={(e) => onOuterKey?.(e.key)}>
      <DictationTextarea label={label} value={value} onValueChange={setValue} />
    </div>
  )
}

const mic = (): Promise<HTMLElement> => screen.findByRole('button', { name: /^Dictate/ })
const box = (): HTMLTextAreaElement => screen.getByRole('textbox') as HTMLTextAreaElement

describe('dictating into a field', () => {
  test('the mic names the field, tells how to start, and is not pressed at rest', async () => {
    renderWithVoice(<Field />)
    const button = await mic()
    expect(button).toHaveAccessibleName('Dictate')
    expect(button).toHaveAccessibleDescription('Into: Notes')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+Space')
  })

  test('recording shows pressed, the time and the meter; Enter stops and inserts at the caret, replacing the selection', async () => {
    const user = userEvent.setup()
    const { audio, transcriber } = renderWithVoice(<Field initial="Fix the old bug" />)
    const button = await mic()
    box().setSelectionRange(8, 11)
    await user.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByText('0:00')).toBeInTheDocument()
    expect(screen.getByTestId('level-meter')).toHaveAttribute('aria-hidden', 'true')
    expect(audio.started).toEqual([''])
    await vi.waitFor(() => expect(transcriber.prepared).toEqual(['whisper-base']))

    await user.click(button)
    await vi.waitFor(() => expect(box().value).toBe('Fix the This was dictated. bug'))
    expect(box().selectionStart).toBe('Fix the This was dictated.'.length)
    expect(box()).toHaveFocus()
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(audio.stopped).toBe(1)
    expect(transcriber.calls).toEqual([{ samples: 16000, model: 'whisper-base', language: 'auto' }])
    expect(within(screen.getByRole('status')).getByText('Dictated text inserted.')).toBeInTheDocument()
  })

  test('Enter in the field stops the recording without adding a line break', async () => {
    const user = userEvent.setup()
    const keys: string[] = []
    renderWithVoice(<Field initial="Hello" onOuterKey={(k) => keys.push(k)} />)
    await user.click(await mic())
    await screen.findByText('0:00')
    box().focus()
    box().setSelectionRange(5, 5)
    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(box().value).toBe('Hello This was dictated.'))
    // The keystroke did not reach anything around the field.
    expect(keys).not.toContain('Enter')
  })

  test('Ctrl+Shift+Space starts and stops it', async () => {
    const user = userEvent.setup()
    const { audio } = renderWithVoice(<Field />)
    await mic()
    box().focus()
    await user.keyboard('{Control>}{Shift>} {/Shift}{/Control}')
    await vi.waitFor(() => expect(audio.started).toHaveLength(1))
    expect(await mic()).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Control>}{Shift>} {/Shift}{/Control}')
    await vi.waitFor(() => expect(box().value).toBe('This was dictated.'))
  })

  test('Esc cancels: nothing is inserted, the audio is thrown away, and a dialog around the field stays open', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { audio, transcriber } = renderWithVoice(
      <Modal opened onClose={onClose} title="Around">
        <Field initial="keep" />
      </Modal>
    )
    await user.click(await mic())
    await screen.findByText('0:00')
    box().focus()
    await user.keyboard('{Escape}')
    await vi.waitFor(() => expect(audio.cancelled).toBe(1))
    expect(box().value).toBe('keep')
    expect(transcriber.calls).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
    expect((await mic()).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('status')).toHaveTextContent('Dictation cancelled.')
    // With nothing recording, Esc is the dialog's again.
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  test('cancelling while it is transcribing drops the transcript', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    const transcriber = new FakeTranscriber('late', 0)
    transcriber.transcribe = () => new Promise((resolve) => (release = () => resolve('late')))
    renderWithVoice(<Field initial="a" />, { transcriber })
    await user.click(await mic())
    await screen.findByText('0:00')
    await user.click(await mic())
    expect((await screen.findAllByText('Transcribing…')).length).toBeGreaterThan(0)
    box().focus()
    await user.keyboard('{Escape}')
    await act(async () => release())
    expect(box().value).toBe('a')
  })

  test('a recording of silence says so and is never transcribed', async () => {
    const user = userEvent.setup()
    const { transcriber } = renderWithVoice(<Field />, { audio: new FakeAudioSource({ samples: new Float32Array(16000) }) })
    await user.click(await mic())
    await user.click(await mic())
    expect((await screen.findAllByText("Didn't hear anything.")).length).toBeGreaterThan(0)
    expect(transcriber.calls).toEqual([])
    expect(box().value).toBe('')
  })

  test.each([
    ['denied', "Mainbus can't use the microphone. In Windows Settings → Privacy & security → Microphone, let desktop apps use it."],
    ['no-device', 'No microphone found. Connect one, or choose another in Mainbus settings → Voice input.']
  ] as const)('shows a clear message when the microphone is %s', async (kind, message) => {
    const user = userEvent.setup()
    renderWithVoice(<Field />, { audio: new FakeAudioSource({ error: new VoiceError(kind, message) }) })
    await user.click(await mic())
    expect(await screen.findAllByText(message)).not.toHaveLength(0)
    expect((await mic()).getAttribute('aria-pressed')).toBe('false')
  })

  test('a failed transcription shows its error and can be tried again', async () => {
    const user = userEvent.setup()
    const transcriber = new FakeTranscriber('ok', 0)
    transcriber.transcribe = () => Promise.reject(new Error('The model could not be loaded'))
    renderWithVoice(<Field />, { transcriber })
    await user.click(await mic())
    await user.click(await mic())
    expect((await screen.findAllByText('The model could not be loaded')).length).toBeGreaterThan(0)
    await user.click(await mic())
    expect((await mic()).getAttribute('aria-pressed')).toBe('true')
  })

  test('has no mic when voice input is off', async () => {
    renderWithVoice(<Field />, { voice: { enabled: false } })
    await screen.findByRole('textbox')
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.get'))
    expect(screen.queryByRole('button', { name: /^Dictate/ })).toBeNull()
  })

  test('turning voice input off in the middle of a recording ends it and takes the mic away', async () => {
    const user = userEvent.setup()
    const { audio, emit } = renderWithVoice(<Field />)
    await user.click(await mic())
    await screen.findByText('0:00')
    emit({ type: 'voice.changed', voice: { enabled: false, model: 'whisper-base', language: 'auto', microphone: '' } })
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: /^Dictate/ })).toBeNull())
    expect(audio.cancelled).toBe(1)
  })

  test('only one field dictates at a time: starting another cancels the first', async () => {
    const user = userEvent.setup()
    const { audio } = renderWithVoice(
      <>
        <Field label="First" />
        <Field label="Second" />
      </>
    )
    const [first, second] = await screen.findAllByRole('button', { name: 'Dictate' })
    await user.click(first)
    await screen.findByText('0:00')
    await user.click(second)
    await vi.waitFor(() => expect(first).toHaveAttribute('aria-pressed', 'false'))
    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(audio.cancelled).toBe(1)
  })

  test('asks before downloading when the model is not on disk, and does not record', async () => {
    const user = userEvent.setup()
    const { audio } = renderWithVoice(<Field />, { models: [{ id: 'whisper-base', installed: false, download: null, error: null }] })
    await user.click(await mic())
    expect(await screen.findByText('Download the speech model')).toBeInTheDocument()
    expect(audio.started).toEqual([])
    await user.click(screen.getByRole('button', { name: /^Download \d+ MB/ }))
    expect(mockInvoke).toHaveBeenCalledWith('voice.downloadModel', 'whisper-base')
  })

  test('with reduced motion the meter still renders, updating a few times a second', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never
    try {
      const user = userEvent.setup()
      renderWithVoice(<Field />)
      await user.click(await mic())
      expect(await screen.findByTestId('level-meter')).toBeInTheDocument()
    } finally {
      window.matchMedia = original
    }
  })

  test('has no accessibility violations at rest or while recording', async () => {
    const user = userEvent.setup()
    const { container } = renderWithVoice(<Field />)
    await expectNoAxeViolations(container)
    await user.click(await mic())
    await screen.findByText('0:00')
    await expectNoAxeViolations(container)
  })
})

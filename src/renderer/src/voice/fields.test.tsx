import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { NewTicketModal } from '../board/NewTicketModal'
import { redirectView } from '../orchestrator/RedirectProposal'
import { useMainbus } from '../store'
import { makeDecision, makeTicket } from '../test-utils'
import { ContextPane } from '../ticket/ContextPane'
import { StartOverrideForm } from '../ticket/StartOverrideForm'
import { DecisionCard } from '../thread/DecisionCard'
import { Composer } from '../thread/Composer'
import { renderWithVoice } from './testVoice'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn(), isSetupRequired: () => false }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const initial = useMainbus.getState()
beforeEach(() => useMainbus.setState(initial, true))

const respond = (command: string): unknown => (command === 'board.get' ? { tickets: [] } : command === 'preset.list' || command === 'lineup.get' ? [] : {})
/** What each mic button says it dictates into. */
const mics = (): string[] => screen.queryAllByRole('button', { name: 'Dictate' }).map((b) => b.getAttribute('aria-description') ?? '')
const settled = async (): Promise<void> => {
  await vi.waitFor(() => expect(screen.queryAllByRole('button', { name: 'Dictate' }).length).toBeGreaterThan(0))
}

function RedirectEditor(): ReactElement {
  const [value, setValue] = useState({ message: 'check the fixtures' })
  const Editor = redirectView.Editor!
  const payload = { ticketId: 't3', number: 3, title: 'Add login', agentRunId: 'r1', episodeId: 'e1', role: 'Implementer', episodeEvidence: [], message: value.message }
  return <Editor value={value} onChange={setValue} payload={payload} />
}

function Override({ disabled = false }: { disabled?: boolean }): ReactElement {
  return <StartOverrideForm roles={[]} extraInstructions="" onRolesChange={() => {}} onExtraInstructionsChange={() => {}} disabled={disabled} />
}

describe('where the mic button is', () => {
  test('the Composer has one', async () => {
    renderWithVoice(<Composer onSend={async () => {}} label="Message the orchestrator" />, { respond })
    await settled()
    expect(mics()).toEqual(['Into: Message the orchestrator'])
  })

  test('New ticket: "In your words" and "Spec", but not Title, Acceptance criteria or Labels', async () => {
    renderWithVoice(<NewTicketModal opened onClose={() => {}} />, { respond })
    await settled()
    expect(mics()).toEqual(['Into: In your words', 'Into: Spec'])
  })

  test('a ticket\'s context: "Add to your words" and the Spec; a Done ticket has neither (it is read-only)', async () => {
    const open = makeTicket({ spec: 'Add a toggle' })
    const { unmount } = renderWithVoice(<ContextPane ticket={open} events={[]} decisions={[]} />, { respond })
    await settled()
    expect(mics()).toEqual(['Into: Add to your words', 'Into: Spec'])
    unmount()
    const done = makeTicket({ spec: 'Add a toggle' }, { column: 'done', phase: 'done' })
    renderWithVoice(<ContextPane ticket={done} events={[]} decisions={[]} />, { respond })
    await screen.findByRole('textbox', { name: 'Spec' })
    expect(mics()).toEqual([])
  })

  test('Run settings\' extra instructions, but not while they are shown disabled', async () => {
    const { unmount } = renderWithVoice(<Override />, { respond })
    await settled()
    expect(mics()).toEqual(['Into: Extra instructions for this agent'])
    unmount()
    renderWithVoice(<Override disabled />, { respond })
    await screen.findByRole('textbox', { name: /Extra instructions/ })
    expect(mics()).toEqual([])
  })

  test('the note on a decision', async () => {
    renderWithVoice(<DecisionCard decision={makeDecision()} />, { respond })
    await settled()
    expect(mics()).toEqual(['Into: Note to agent (optional)'])
  })

  test('the redirect message', async () => {
    renderWithVoice(<RedirectEditor />, { respond })
    await settled()
    expect(mics()).toEqual(['Into: Message to the agent'])
  })

  test('a field dictated into takes the text without sending anything', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => {})
    renderWithVoice(<Composer onSend={onSend} label="Message" enterSends />, { respond })
    await settled()
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await user.type(box, 'Hello')
    await user.click(screen.getByRole('button', { name: 'Dictate' }))
    await screen.findByText('0:00')
    // Enter stops the recording; with Enter-sends on, it must not send.
    box.focus()
    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(box.value).toBe('Hello This was dictated.'))
    expect(onSend).not.toHaveBeenCalled()
    // Typing still sends the ordinary way.
    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('Hello This was dictated.'))
  })
});

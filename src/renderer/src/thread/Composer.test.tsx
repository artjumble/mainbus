import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { Composer } from './Composer'

const send = (): HTMLElement => screen.getByRole('button', { name: 'Send' })

test('Composer keeps Send inside the input and disables it when empty', async () => {
  renderWithMantine(<Composer onSend={async () => {}} />)
  const input = screen.getByRole('textbox')
  expect(within(input.parentElement as HTMLElement).getByRole('button', { name: 'Send' })).toBe(send())
  expect(send()).toBeDisabled()
  await userEvent.type(input, '   ')
  expect(send()).toBeDisabled()
  await userEvent.type(input, 'hello')
  expect(send()).toBeEnabled()
})

test('clicking Send sends the text and clears the box', async () => {
  const onSend = vi.fn(async () => {})
  renderWithMantine(<Composer onSend={onSend} />)
  await userEvent.type(screen.getByRole('textbox'), 'do it')
  await userEvent.click(send())
  expect(onSend).toHaveBeenCalledWith('do it')
  expect(screen.getByRole('textbox')).toHaveValue('')
})

test('Ctrl+Enter sends; plain Enter does not', async () => {
  const onSend = vi.fn(async () => {})
  renderWithMantine(<Composer onSend={onSend} />)
  await userEvent.type(screen.getByRole('textbox'), 'one{Enter}two')
  expect(onSend).not.toHaveBeenCalled()
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  expect(onSend).toHaveBeenCalledWith('one\ntwo')
})

test('a failed send keeps the text', async () => {
  const onSend = vi.fn(async () => {
    throw new Error('nope')
  })
  renderWithMantine(<Composer onSend={onSend} />)
  await userEvent.type(screen.getByRole('textbox'), 'keep me')
  await userEvent.click(send())
  expect(screen.getByRole('textbox')).toHaveValue('keep me')
})

test('a placeholder labels the box', () => {
  renderWithMantine(<Composer onSend={async () => {}} placeholder="First message (starts the lineup)" />)
  expect(screen.getByPlaceholderText('First message (starts the lineup)')).toBeInTheDocument()
})

test('with enterSends, Enter sends and clears the box', async () => {
  const onSend = vi.fn(async () => {})
  renderWithMantine(<Composer onSend={onSend} enterSends />)
  await userEvent.type(screen.getByRole('textbox'), 'hello{Enter}')
  expect(onSend).toHaveBeenCalledWith('hello')
  expect(screen.getByRole('textbox')).toHaveValue('')
})

test('with enterSends, Shift+Enter starts a new line and does not send', async () => {
  const onSend = vi.fn(async () => {})
  renderWithMantine(<Composer onSend={onSend} enterSends />)
  await userEvent.type(screen.getByRole('textbox'), 'one{Shift>}{Enter}{/Shift}two')
  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('one\ntwo')
  await userEvent.keyboard('{Enter}')
  expect(onSend).toHaveBeenCalledWith('one\ntwo')
})

test('with enterSends, Enter on blank text sends nothing', async () => {
  const onSend = vi.fn(async () => {})
  renderWithMantine(<Composer onSend={onSend} enterSends />)
  await userEvent.type(screen.getByRole('textbox'), '   {Enter}')
  expect(onSend).not.toHaveBeenCalled()
})

test('while working, the button is Stop, typing goes on, and Enter does not send', async () => {
  const onSend = vi.fn(async () => {})
  const onStop = vi.fn(async () => {})
  renderWithMantine(<Composer onSend={onSend} enterSends working onStop={onStop} />)
  expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
  const stop = screen.getByRole('button', { name: 'Stop' })
  expect(stop).toBeEnabled()

  await userEvent.type(screen.getByRole('textbox'), 'next{Enter}')
  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('next')

  await userEvent.click(stop)
  expect(onStop).toHaveBeenCalledTimes(1)
})

test('a prefill fills the box, focuses it with the caret at the end, and reports once', () => {
  const onPrefilled = vi.fn()
  const { rerender } = renderWithMantine(
    <Composer onSend={async () => {}} prefill={{ text: 'Draft tickets for ', n: 1 }} onPrefilled={onPrefilled} />
  )
  const box = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(box).toHaveValue('Draft tickets for ')
  expect(box).toHaveFocus()
  expect(box.selectionStart).toBe('Draft tickets for '.length)
  expect(onPrefilled).toHaveBeenCalledTimes(1)

  // A re-render with the same ask does not apply it again; a new ask does.
  rerender(<Composer onSend={async () => {}} prefill={{ text: 'Draft tickets for ', n: 1 }} onPrefilled={onPrefilled} />)
  expect(onPrefilled).toHaveBeenCalledTimes(1)
  rerender(<Composer onSend={async () => {}} prefill={{ text: 'Again ', n: 2 }} onPrefilled={onPrefilled} />)
  expect(box).toHaveValue('Again ')
  expect(onPrefilled).toHaveBeenCalledTimes(2)
})

test('the composer, empty, with text and while working, has no axe violations', async () => {
  const { rerender } = renderWithMantine(<Composer onSend={async () => {}} placeholder="Message" />)
  await expectNoAxeViolations()
  await userEvent.type(screen.getByRole('textbox'), 'hello')
  await expectNoAxeViolations()
  rerender(<Composer onSend={async () => {}} placeholder="Message" working onStop={async () => {}} />)
  await expectNoAxeViolations()
})

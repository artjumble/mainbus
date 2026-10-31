import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithMantine } from '../test-utils'
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

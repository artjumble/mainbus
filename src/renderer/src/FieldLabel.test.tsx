import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Switch, TextInput } from '@mantine/core'
import { renderWithMantine } from './test-utils'
import { fieldInfo } from './FieldLabel'

const INFO = 'Lowering it stops no running agent.'

function renderField(): void {
  renderWithMantine(
    <>
      <TextInput {...fieldInfo('Agents running at once', INFO)} />
      <button>elsewhere</button>
    </>
  )
}

const button = (): HTMLElement => screen.getByRole('button', { name: 'About Agents running at once' })

test('the description is not shown by default, but stays the input description', () => {
  renderField()
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Agents running at once' })).toHaveAccessibleDescription(INFO)
})

test('hover shows the description and leaving hides it', async () => {
  const user = userEvent.setup()
  renderField()
  await user.hover(button())
  expect(await screen.findByRole('tooltip')).toHaveTextContent(INFO)
  await user.unhover(button())
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})

test('keyboard focus shows it, and Escape closes it', async () => {
  const user = userEvent.setup()
  renderField()
  await user.tab()
  expect(button()).toHaveFocus()
  expect(await screen.findByRole('tooltip')).toHaveTextContent(INFO)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})

test('a click keeps it open after the pointer leaves; clicking away closes it', async () => {
  const user = userEvent.setup()
  renderField()
  await user.click(button())
  await user.unhover(button())
  expect(await screen.findByRole('tooltip')).toHaveTextContent(INFO)
  await user.click(screen.getByRole('button', { name: 'elsewhere' }))
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})

test('a switch is named by its label text alone too', () => {
  renderWithMantine(<Switch {...fieldInfo('Voice input', INFO)} />)
  const sw = screen.getByRole('switch', { name: 'Voice input' })
  expect(sw).toHaveAccessibleDescription(INFO)
})

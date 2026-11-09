import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { Composer, filterMentionOptions, type MentionOption } from './Composer'

const options: MentionOption[] = [
  { id: 'w1', name: 'mainbus', detail: 'C:\repos\mainbus', current: true },
  { id: 'w2', name: 'hunter', detail: 'C:\repos\hunter' },
  { id: 'w3', name: 'my app', detail: 'C:\repos\app' }
]

function setup(onSend = vi.fn(async () => {})) {
  renderWithMantine(<Composer enterSends onSend={onSend} mentions={{ options, label: 'Workspaces' }} />)
  return { onSend, box: screen.getByRole('textbox') as HTMLTextAreaElement }
}

test('filterMentionOptions puts prefix matches before word and substring matches', () => {
  const list: MentionOption[] = ['xhunter', 'the hunter', 'hunter', 'other'].map((name) => ({ id: name, name, detail: '' }))
  expect(filterMentionOptions(list, 'HUN').map((o) => o.name)).toEqual(['hunter', 'the hunter', 'xhunter'])
  expect(filterMentionOptions(list, '')).toBe(list)
})

test('@ at a word start opens the list; typing filters it', async () => {
  const { box } = setup()
  await userEvent.type(box, '@')
  expect(await screen.findAllByRole('option')).toHaveLength(3)
  expect(screen.getByRole('listbox', { name: 'Workspaces' })).toBeInTheDocument()
  expect(screen.getByText('focused')).toBeInTheDocument()
  await userEvent.type(box, 'hu')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  expect(screen.getByRole('option')).toHaveTextContent('hunter')
})

test('the list is a real dropdown with its own width, and holds every option', async () => {
  const { box } = setup()
  await userEvent.type(box, '@')
  const list = await screen.findByRole('listbox', { name: 'Workspaces' })
  const dropdown = list.closest<HTMLElement>('.mantine-Combobox-dropdown')!
  expect(dropdown).not.toBeNull()
  // jsdom has no layout; Mantine writes the width as calc(<n>rem * scale), 16px to the rem.
  expect(parseFloat(dropdown.style.width.replace('calc(', '')) * 16).toBeGreaterThanOrEqual(200)
  for (const option of screen.getAllByRole('option')) expect(dropdown).toContainElement(option)
})

test('@ opens after a space or newline, not inside an address', async () => {
  const { box } = setup()
  await userEvent.type(box, 'a@')
  expect(screen.queryByRole('option')).toBeNull()
  await userEvent.type(box, ' @')
  expect(await screen.findAllByRole('option')).toHaveLength(3)
  await userEvent.type(box, '{Shift>}{Enter}{/Shift}')
  expect(screen.queryByRole('option')).toBeNull()
  await userEvent.type(box, '@')
  expect(await screen.findAllByRole('option')).toHaveLength(3)
})

test('arrows and Enter insert the workspace; Enter does not send', async () => {
  const { box, onSend } = setup()
  await userEvent.type(box, 'in @')
  await screen.findAllByRole('option')
  await userEvent.keyboard('{ArrowDown}{Enter}')
  expect(box).toHaveValue('in @hunter ')
  expect(onSend).not.toHaveBeenCalled()
  expect(screen.queryByRole('option')).toBeNull()
  await userEvent.type(box, 'now{Enter}')
  expect(onSend).toHaveBeenCalledWith('in @hunter now', ['w2'])
})

test('Tab and a click insert too', async () => {
  const { box } = setup()
  await userEvent.type(box, '@ma')
  await screen.findAllByRole('option')
  await userEvent.keyboard('{Tab}')
  expect(box).toHaveValue('@mainbus ')
  await userEvent.type(box, '@hu')
  await userEvent.click(await screen.findByRole('option', { name: /hunter/ }))
  expect(box).toHaveValue('@mainbus @hunter ')
})

test('Esc closes the list and leaves the text', async () => {
  const { box } = setup()
  await userEvent.type(box, '@hu')
  await screen.findAllByRole('option')
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('option')).toBeNull()
  expect(box).toHaveValue('@hu')
})

test('a space with no match closes the list', async () => {
  const { box } = setup()
  await userEvent.type(box, '@hu')
  await screen.findAllByRole('option')
  await userEvent.type(box, ' ')
  expect(screen.queryByRole('option')).toBeNull()
})

test('names with spaces are inserted quoted', async () => {
  const { box } = setup()
  await userEvent.type(box, '@my a')
  expect(await screen.findAllByRole('option')).toHaveLength(1)
  await userEvent.keyboard('{Enter}')
  expect(box).toHaveValue('@"my app" ')
})

test('a picked mention whose text was deleted is not sent', async () => {
  const { box, onSend } = setup()
  await userEvent.type(box, '@hu')
  await screen.findAllByRole('option')
  await userEvent.keyboard('{Enter}')
  await userEvent.type(box, '{Backspace}{Backspace}x{Control>}{Enter}{/Control}')
  expect(onSend).toHaveBeenCalledWith('@huntex', [])
})

test('the box and list carry the combobox ARIA, and pass axe', async () => {
  const { box } = setup()
  expect(box).toHaveAttribute('aria-autocomplete', 'list')
  await userEvent.type(box, '@')
  const items = await screen.findAllByRole('option')
  const list = screen.getByRole('listbox')
  expect(box).toHaveAttribute('aria-controls', list.id)
  expect(box.getAttribute('aria-activedescendant')).toBe(items[0]!.id)
  await userEvent.keyboard('{ArrowDown}')
  expect(box.getAttribute('aria-activedescendant')).toBe(items[1]!.id)
  await expectNoAxeViolations(document.body)
})

test('without the mentions prop the box has no combobox attributes', async () => {
  renderWithMantine(<Composer onSend={async () => {}} />)
  const box = screen.getByRole('textbox')
  await userEvent.type(box, '@')
  expect(box).not.toHaveAttribute('aria-autocomplete')
  expect(box).not.toHaveAttribute('aria-controls')
  expect(screen.queryByRole('option')).toBeNull()
})

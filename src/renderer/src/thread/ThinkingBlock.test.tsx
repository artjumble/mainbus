import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithMantine } from '../test-utils'
import { ThinkingBlock } from './ThinkingBlock'

test('thinking with null text and a duration is a non-expandable "Thought for Ns" stub', () => {
  renderWithMantine(<ThinkingBlock text={null} durationMs={4200} />)
  expect(screen.getByText('Thought for 4s')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test.each([
  [400, 'Thought for 1s'],
  [0, 'Thought for 1s'],
  [4600, 'Thought for 5s']
])('a %i ms stub rounds to whole seconds, at least one: %s', (durationMs, label) => {
  renderWithMantine(<ThinkingBlock text={null} durationMs={durationMs} />)
  expect(screen.getByText(label)).toBeInTheDocument()
})

test('a partial thinking block is a live "Thinking…" indicator', () => {
  renderWithMantine(<ThinkingBlock text={null} partial />)
  expect(screen.getByText('Thinking…')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('thinking with text is a collapsible "Thinking" block', async () => {
  renderWithMantine(<ThinkingBlock text="Weighing the options" />)
  const toggle = screen.getByRole('button', { name: /Thinking/ })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(await screen.findByText('Weighing the options')).toBeVisible()
})

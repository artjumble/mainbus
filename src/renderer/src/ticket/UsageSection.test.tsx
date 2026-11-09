import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UsageEvent } from '../../../shared/events'
import { COST_LABEL } from '../../../shared/usageTotals'
import { expectNoAxeViolations, makeEvent, renderWithMantine } from '../test-utils'
import { UsageSection } from './UsageSection'

const usage: UsageEvent = {
  kind: 'usage',
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 5000,
  cacheWriteTokens: 700,
  models: { 'claude-haiku-5-5': { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 700, costUsd: 0.42 } },
  costUsd: 0.42,
  durationMs: 65_000
}
const runs = {
  a: { id: 'a', ticketRunId: 't1', role: 'Planner' },
  b: { id: 'b', ticketRunId: 't1', role: 'Implementer' }
}

test('collapsed by default: the toggle says so and no totals are visible', () => {
  renderWithMantine(<UsageSection events={[makeEvent(usage, { runId: 'a' })]} runs={runs} />)
  const section = screen.getByRole('region', { name: 'Usage' })
  expect(within(section).getByRole('button', { name: 'Show' })).toHaveAttribute('aria-expanded', 'false')
  within(section).getAllByText(/1\.2k input/).forEach((el) => expect(el).not.toBeVisible())
})

test('expanded: the totals, the breakdown by run and role, and the cost label', async () => {
  const { container } = renderWithMantine(<UsageSection events={[makeEvent(usage, { runId: 'a' }), makeEvent(usage, { runId: 'b' })]} runs={runs} />)
  const section = screen.getByRole('region', { name: 'Usage' })
  await userEvent.click(within(section).getByRole('button', { name: 'Show' }))
  expect(within(section).getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true')
  expect(within(section).getAllByText(/2\.4k input · 600 output · 10k cache read · 1\.4k cache write · 2 turns · 2m/)).toHaveLength(1)
  await vi.waitFor(() => expect(within(section).getByText('Run 1')).toBeVisible())
  expect(within(section).getByText('Planner')).toBeVisible()
  expect(within(section).getByText('Implementer')).toBeVisible()
  expect(within(section).getAllByText(/claude-haiku-5-5/).length).toBeGreaterThan(0)
  expect(section.textContent).toContain(COST_LABEL)
  expect(section.textContent).toContain('$0.84')
  await expectNoAxeViolations(container)
})

test('a run from before usage was kept shows Not recorded, never zero', async () => {
  renderWithMantine(<UsageSection events={[makeEvent({ kind: 'message', text: 'hi' }, { runId: 'a' })]} runs={runs} />)
  const section = screen.getByRole('region', { name: 'Usage' })
  await userEvent.click(within(section).getByRole('button', { name: 'Show' }))
  expect(within(section).getAllByText('Not recorded').length).toBeGreaterThanOrEqual(3)
  expect(section.textContent).not.toMatch(/\b0 input|\$0\.00/)
})

test('nothing shows before the first run', () => {
  renderWithMantine(<UsageSection events={[]} runs={{}} />)
  expect(screen.queryByRole('region', { name: 'Usage' })).not.toBeInTheDocument()
})

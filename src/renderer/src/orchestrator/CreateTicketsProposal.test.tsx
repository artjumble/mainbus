import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CreateTicketsOverride, CreateTicketsPayload } from '../../../shared/proposals'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { createTicketsView } from './CreateTicketsProposal'

const payload: CreateTicketsPayload = {
  intent: 'Look into the slow login and fix the typo',
  column: 'backlog',
  tickets: [
    { title: 'Why is login slow', spec: '', criteria: [], labels: [], kind: 'investigate' },
    { title: 'Fix the typo', spec: '', criteria: [], labels: [] }
  ]
}

test('shows an Investigate badge on investigate drafts only', () => {
  const Editor = createTicketsView.Editor!
  renderWithMantine(<Editor value={createTicketsView.initialEdit!(payload)} onChange={() => {}} payload={payload} />)
  expect(screen.getAllByText('Investigate')).toHaveLength(1)
})

test('Edit keeps the kind of each draft', () => {
  const edit = createTicketsView.initialEdit!(payload)
  const override = createTicketsView.toOverride!(edit)! as CreateTicketsOverride
  expect(override.tickets.map((t) => t.kind)).toEqual(['investigate', undefined])
  expect(override.tickets[1]).not.toHaveProperty('kind')
})

test('the drafts have no axe violations', async () => {
  const Editor = createTicketsView.Editor!
  renderWithMantine(<Editor value={createTicketsView.initialEdit!(payload)} onChange={() => {}} payload={payload} />)
  await expectNoAxeViolations()
})

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CreateTicketsOverride, CreateTicketsPayload } from '../../../shared/proposals'
import { useState } from 'react'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { createTicketsView, type CreateTicketsEdit } from './CreateTicketsProposal'

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

const withContext: CreateTicketsPayload = { ...payload, context: 'The user asked about slow logins. The orchestrator found a loop.' }

/** The editor with its state held, as the card holds it; `last` is what a plain Create would send. */
function Harness({ p, last }: { p: CreateTicketsPayload; last: { override: CreateTicketsOverride | null } }) {
  const Editor = createTicketsView.Editor!
  const [edit, setEdit] = useState<CreateTicketsEdit>(createTicketsView.initialEdit!(p))
  last.override = createTicketsView.toOverride!(edit) as CreateTicketsOverride | null
  return <Editor value={edit} onChange={setEdit} payload={p} />
}

test('shows the summary under its own heading, saying it is not the words of the user', () => {
  renderWithMantine(<Harness p={withContext} last={{ override: null }} />)
  const region = screen.getByRole('region', { name: 'Summary from the orchestrator' })
  expect(within(region).getByText(/The orchestrator found a loop/)).toBeInTheDocument()
  expect(within(region).getByText('Added to each ticket under From an agent, not Your words')).toBeInTheDocument()
})

test('shows no summary section when there is none', () => {
  renderWithMantine(<Harness p={payload} last={{ override: null }} />)
  expect(screen.queryByRole('region', { name: 'Summary from the orchestrator' })).not.toBeInTheDocument()
  const last = { override: null as CreateTicketsOverride | null }
  renderWithMantine(<Harness p={payload} last={last} />)
  expect(last.override).not.toHaveProperty('context')
})

test('a plain Create keeps the summary in the override', () => {
  const last = { override: null as CreateTicketsOverride | null }
  renderWithMantine(<Harness p={withContext} last={last} />)
  expect(last.override!.context).toBe(withContext.context)
})

test('Edit changes the summary that is sent', async () => {
  const last = { override: null as CreateTicketsOverride | null }
  renderWithMantine(<Harness p={withContext} last={last} />)
  const region = screen.getByRole('region', { name: 'Summary from the orchestrator' })
  await userEvent.click(within(region).getByRole('button', { name: 'Edit' }))
  const box = within(region).getByRole('textbox', { name: 'Summary' })
  await userEvent.clear(box)
  await userEvent.type(box, 'Shorter')
  expect(last.override!.context).toBe('Shorter')
})

test('Remove leaves the summary out, and Restore brings it back', async () => {
  const last = { override: null as CreateTicketsOverride | null }
  renderWithMantine(<Harness p={withContext} last={last} />)
  const region = screen.getByRole('region', { name: 'Summary from the orchestrator' })
  await userEvent.click(within(region).getByRole('button', { name: 'Remove' }))
  expect(within(region).getByText('The summary will be left out.')).toBeInTheDocument()
  expect(last.override).not.toHaveProperty('context')
  await userEvent.click(within(region).getByRole('button', { name: 'Restore' }))
  expect(last.override!.context).toBe(withContext.context)
})

test('"Put in Ready instead" keeps the summary', () => {
  const edit = createTicketsView.initialEdit!(withContext)
  const [ready] = createTicketsView.alternatives!(edit)
  expect((createTicketsView.toOverride!(ready!.edit) as CreateTicketsOverride).context).toBe(withContext.context)
})

test('the summary has no axe violations', async () => {
  renderWithMantine(<Harness p={withContext} last={{ override: null }} />)
  await expectNoAxeViolations()
})

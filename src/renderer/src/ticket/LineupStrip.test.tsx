import { screen, within } from '@testing-library/react'
import type { RoleStatus, StripRole } from '../../../shared/domain'
import { renderWithMantine } from '../test-utils'
import { LineupStrip } from './LineupStrip'

const role = (id: string, name: string, status: RoleStatus, active = false): StripRole => ({ id, name, status, active, replacements: 0 })

test('shows each role in order with its status, and marks the active one as the current step', () => {
  renderWithMantine(
    <LineupStrip
      roles={[role('p', 'Planner', 'handed_off'), role('i', 'Implementer', 'waiting_on_you', true), role('r', 'Reviewer', 'not_started')]}
    />
  )
  const list = screen.getByRole('list', { name: 'Lineup' })
  const items = within(list).getAllByRole('listitem')
  expect(items).toHaveLength(3)
  expect(items.map((li) => li.textContent)).toEqual(['PlannerHanded off', 'ImplementerWaiting on you', 'ReviewerNot started'])
  expect(within(list).getByRole('listitem', { current: 'step' })).toHaveTextContent('Implementer')
})

test.each<[RoleStatus, string]>([
  ['not_started', 'Not started'],
  ['queued', 'Queued'],
  ['working', 'Working'],
  ['waiting_on_you', 'Waiting on you'],
  ['handed_off', 'Handed off'],
  ['paused', 'Paused'],
  ['failed', 'Failed'],
  ['stopped', 'Stopped']
])('the %s status reads "%s"', (status, label) => {
  renderWithMantine(<LineupStrip roles={[role('i', 'Implementer', status)]} />)
  expect(within(screen.getByRole('listitem')).getByText(label)).toBeInTheDocument()
})

test('a queued role shows its place in the queue', () => {
  renderWithMantine(<LineupStrip roles={[role('p', 'Planner', 'handed_off'), { ...role('i', 'Implementer', 'queued', true), queuePosition: 2 }]} />)
  const items = within(screen.getByRole('list', { name: 'Lineup' })).getAllByRole('listitem')
  expect(items.map((li) => li.textContent)).toEqual(['PlannerHanded off', 'ImplementerQueued · 2nd'])
})

test('with no active role, no step is current', () => {
  renderWithMantine(<LineupStrip roles={[role('p', 'Planner', 'not_started'), role('i', 'Implementer', 'not_started')]} />)
  expect(screen.queryByRole('listitem', { current: 'step' })).not.toBeInTheDocument()
})

test('a role replaced once or more carries a small "replaced ×n" marker, and one never replaced has none', () => {
  renderWithMantine(<LineupStrip roles={[role('p', 'Planner', 'handed_off'), { ...role('i', 'Implementer', 'working', true), replacements: 2 }]} />)
  const items = within(screen.getByRole('list', { name: 'Lineup' })).getAllByRole('listitem')
  expect(items[0]).not.toHaveTextContent('replaced')
  expect(items[1]).toHaveTextContent('Workingreplaced ×2')
})

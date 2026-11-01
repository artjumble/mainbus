import { makeLineup } from '../test-utils'
import { moveRole, newRole, removeRole, sameLineup, toDraft } from './lineupDraft'

const drafts = () => makeLineup().map(toDraft)

test('moveRole moves a role and keeps hand-backs that still point earlier', () => {
  const moved = moveRole(drafts(), 2, 1)
  expect(moved.map((r) => [r.name, r.handBackTo])).toEqual([
    ['Planner', null],
    ['Reviewer', null], // the Implementer it handed back to now comes after it
    ['Implementer', 'p']
  ])
})

test('moveRole ignores moves out of range or in place', () => {
  const roles = drafts()
  expect(moveRole(roles, 0, -1)).toBe(roles)
  expect(moveRole(roles, 2, 3)).toBe(roles)
  expect(moveRole(roles, 1, 1)).toBe(roles)
})

test('removeRole sends hand-backs to the removed role to the previous role', () => {
  expect(removeRole(drafts(), 'i').map((r) => [r.id, r.handBackTo])).toEqual([
    ['p', null],
    ['r', null]
  ])
})

test('newRole picks a name no role has, ignoring case and spaces', () => {
  const roles = [...drafts(), { ...newRole([]), name: ' new ROLE ' }]
  expect(newRole(roles).name).toBe('New role 2')
  expect(newRole(drafts())).toMatchObject({ name: 'New role', onProblem: 'ask_me', handBackTo: null, toolProfile: 'read_only' })
  expect(newRole([]).id).not.toBe(newRole([]).id)
})

test('sameLineup compares order and every field', () => {
  expect(sameLineup(drafts(), drafts())).toBe(true)
  expect(sameLineup(drafts(), moveRole(drafts(), 0, 1))).toBe(false)
  expect(sameLineup(drafts(), drafts().map((r, i) => (i === 1 ? { ...r, effort: 'low' } : r)))).toBe(false)
})

import type { LineupRole, LineupRoleInput } from '../../../shared/domain'

/** The lineup settings edit a list of these and save it whole; a new role's id is a placeholder until saved. */
export type DraftRole = LineupRoleInput

export function toDraft({ workspaceId: _w, lineup: _l, position: _p, ...rest }: LineupRole): DraftRole {
  return rest
}

/**
 * A hand-back may only point at an earlier role. After a role moves or goes, any that no longer does falls back
 * to the previous role, the same as `lineup.save` does for a removed role.
 */
function fixHandBacks(roles: DraftRole[]): DraftRole[] {
  return roles.map((role, i) =>
    role.handBackTo !== null && !roles.slice(0, i).some((r) => r.id === role.handBackTo)
      ? { ...role, handBackTo: null }
      : role
  )
}

/** Moves the role at `from` to index `to`. */
export function moveRole(roles: DraftRole[], from: number, to: number): DraftRole[] {
  if (from === to || to < 0 || to >= roles.length || from < 0 || from >= roles.length) return roles
  const next = [...roles]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return fixHandBacks(next)
}

export function removeRole(roles: DraftRole[], id: string): DraftRole[] {
  return fixHandBacks(roles.filter((r) => r.id !== id))
}

let counter = 0

/** A new role at the end of the lineup, with a name no other role has. */
export function newRole(roles: DraftRole[]): DraftRole {
  const taken = new Set(roles.map((r) => r.name.trim().toLowerCase()))
  let name = 'New role'
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New role ${n}`
  counter += 1
  return {
    id: `new-${Date.now()}-${counter}`,
    name,
    instructions: '',
    activePhase: 'implementing',
    onProblem: 'ask_me',
    handBackTo: null,
    model: null,
    effort: null,
    toolProfile: 'read_only'
  }
}

export function sameLineup(a: DraftRole[], b: DraftRole[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

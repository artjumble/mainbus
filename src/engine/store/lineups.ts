import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import {
  ROLE_PHASES,
  type Effort,
  type Lineup,
  type LineupRole,
  type LineupRoleInput,
  type OnProblem,
  type RolePhase,
  type ToolProfile
} from '../../shared/domain'
import { EFFORTS } from '../../shared/models'
import type { Db } from '../db/open'
import { lineupRoles } from '../db/schema'

export interface LineupRepo {
  /** The workspace's lineup of that kind (Change unless given), first role first. */
  get(workspaceId: string, lineup?: Lineup): Promise<LineupRole[]>
  /** Replaces the whole lineup of that kind in one transaction. Throws, with a message for the user, when it's invalid. */
  save(workspaceId: string, roles: LineupRoleInput[], lineup?: Lineup): Promise<LineupRole[]>
}

// The ids here only link the defaults to each other; saving gives every role a fresh one.
// Migrations 0002, 0012, 0020 and 0033 have their own copies of these texts, as they were when each was written.
/** The lineup every new workspace starts with: Planner → Implementer → Reviewer. */
export function defaultLineup(): LineupRoleInput[] {
  return [
    {
      id: 'planner',
      name: 'Planner',
      instructions:
        'Read the ticket and the code it touches. Work out the approach: the files to change, the design, and the ' +
        "tests that will prove it. Don't change any files. Hand off with the plan as your summary and anything the " +
        'Implementer must watch for in notes_for_next.',
      activePhase: 'planning',
      onProblem: 'ask_me',
      handBackTo: null,
      model: null,
      effort: null,
      toolProfile: 'read_only'
    },
    {
      id: 'implementer',
      name: 'Implementer',
      instructions:
        'Make the change and its tests, following the plan from the previous role unless the code shows it is ' +
        'wrong (then say why in your handoff). While you work, run only the tests that cover the code you changed. ' +
        "Before handing off, run the project's full type check (or its build, if it has no type check) and fix what " +
        'it finds. Commit your work on the branch before handing off. In notes_for_next, say which tests you ran. ' +
        "Don't tick a criterion about the full test suite: the Reviewer runs it.",
      activePhase: 'implementing',
      onProblem: 'hand_back',
      handBackTo: 'planner',
      model: null,
      effort: null,
      toolProfile: 'edit'
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      instructions:
        "Review the branch's changes against the user's words and the acceptance criteria. Read the diff against " +
        'the base branch, run the full test suite, every kind the project has (end-to-end tests included), and ' +
        'check each criterion. You may skip the tests only when the branch changes no code: every changed file is ' +
        'documentation or other text that nothing in the build, the tests or the app reads (check that no code or ' +
        'test refers to it). Then say in your handoff that you skipped them and why, and check the documentation ' +
        'itself instead: that its links and the commands and paths it names exist. If an acceptance criterion ' +
        "requires the tests to pass, run them anyway; never tick a criterion about tests you didn't run. If " +
        'something is wrong or missing, report it as ' +
        "a problem with specific findings (file, line, what's wrong) so the Implementer can fix it. Don't change " +
        "any files. When it's right, hand off with a short review summary.",
      activePhase: 'reviewing',
      onProblem: 'hand_back',
      handBackTo: 'implementer',
      model: null,
      effort: null,
      toolProfile: 'read_only'
    }
  ]
}

/** The lineup every new workspace's Investigate tickets run: one read-only Investigator who ends with a report. */
export function defaultInvestigateLineup(): LineupRoleInput[] {
  return [
    {
      id: 'investigator',
      name: 'Investigator',
      instructions:
        "Find out what's going on and write it up; don't change code. Your report may recommend changes but does " +
        'not authorize them.',
      activePhase: 'planning',
      onProblem: 'ask_me',
      handBackTo: null,
      model: null,
      effort: null,
      toolProfile: 'read_only'
    }
  ]
}

const TOOL_PROFILES: ToolProfile[] = ['read_only', 'edit']
const ON_PROBLEM: OnProblem[] = ['hand_back', 'ask_me']

/**
 * Why `roles` can't be saved as a lineup, or null when it can. A hand-back to a role that isn't in the lineup
 * (one being removed) is not an error: it falls back to the previous role.
 */
export function lineupProblem(roles: LineupRoleInput[]): string | null {
  if (roles.length === 0) return 'A lineup needs at least one role.'
  const seen = new Map<string, string>()
  const ids = new Set<string>()
  for (const [i, role] of roles.entries()) {
    const name = role.name.trim()
    if (!name) return `Role ${i + 1} needs a name.`
    const earlier = seen.get(name.toLowerCase())
    if (earlier !== undefined) return `Two roles are called "${earlier}". Give each role its own name.`
    seen.set(name.toLowerCase(), name)
    if (ids.has(role.id)) return `Two roles have the same id (${role.id}).`
    ids.add(role.id)
    if (!(ROLE_PHASES as readonly string[]).includes(role.activePhase)) return `${name} has an unknown phase.`
    if (!TOOL_PROFILES.includes(role.toolProfile)) return `${name} has an unknown tool profile.`
    if (!ON_PROBLEM.includes(role.onProblem)) return `${name} has an unknown "on a problem" setting.`
    if (role.effort !== null && !EFFORTS.includes(role.effort)) return `${name} has an unknown effort.`
  }
  for (const [i, role] of roles.entries()) {
    if (role.onProblem !== 'hand_back' || role.handBackTo === null) continue
    const target = roles.findIndex((r) => r.id === role.handBackTo)
    if (target >= i) {
      return `${role.name.trim()} hands back to ${roles[target]!.name.trim()}, which doesn't come before it. A role can only hand back to an earlier role.`
    }
  }
  return null
}

/**
 * The rows for `roles` in order: ids in `keep` stay, any other id gets a fresh one, and hand-backs follow.
 * A hand-back to a role not in the lineup, or from a role that asks the user, is stored as null.
 */
function toRows(workspaceId: string, lineup: Lineup, roles: LineupRoleInput[], keep: Set<string>): (typeof lineupRoles.$inferInsert)[] {
  const ids = new Map(roles.map((r) => [r.id, keep.has(r.id) ? r.id : randomUUID()]))
  return roles.map((role, i) => ({
    id: ids.get(role.id)!,
    workspaceId,
    lineup,
    position: i + 1,
    name: role.name.trim(),
    instructions: role.instructions,
    activePhase: role.activePhase,
    onProblem: role.onProblem,
    handBackTo: role.onProblem === 'hand_back' && role.handBackTo !== null ? (ids.get(role.handBackTo) ?? null) : null,
    model: role.model,
    effort: role.effort,
    toolProfile: role.toolProfile
  }))
}

function toRole(row: typeof lineupRoles.$inferSelect): LineupRole {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    lineup: row.lineup as Lineup,
    position: row.position,
    name: row.name,
    instructions: row.instructions,
    activePhase: row.activePhase as RolePhase,
    onProblem: row.onProblem as OnProblem,
    handBackTo: row.handBackTo,
    model: row.model,
    effort: row.effort as Effort | null,
    toolProfile: row.toolProfile as ToolProfile
  }
}

/** Adds the default lineups (Change and Investigate) to a new workspace. */
export async function insertDefaultLineup(db: Db, workspaceId: string): Promise<void> {
  await db
    .insert(lineupRoles)
    .values([
      ...toRows(workspaceId, 'change', defaultLineup(), new Set()),
      ...toRows(workspaceId, 'investigate', defaultInvestigateLineup(), new Set())
    ])
}

export function createLineupRepo(db: Db): LineupRepo {
  async function get(workspaceId: string, lineup: Lineup = 'change'): Promise<LineupRole[]> {
    const rows = await db
      .select()
      .from(lineupRoles)
      .where(and(eq(lineupRoles.workspaceId, workspaceId), eq(lineupRoles.lineup, lineup)))
      .orderBy(asc(lineupRoles.position))
    return rows.map(toRole)
  }

  return {
    get,
    async save(workspaceId, roles, lineup = 'change') {
      const problem = lineupProblem(roles)
      if (problem) throw new Error(problem)
      const existing = new Set((await get(workspaceId, lineup)).map((r) => r.id))
      if (existing.size === 0) throw new Error(`No lineup for workspace ${workspaceId}`)
      const rows = toRows(workspaceId, lineup, roles, existing)
      await db.transaction(async (tx) => {
        await tx
          .delete(lineupRoles)
          .where(and(eq(lineupRoles.workspaceId, workspaceId), eq(lineupRoles.lineup, lineup)))
        await tx.insert(lineupRoles).values(rows)
      })
      return get(workspaceId, lineup)
    }
  }
}

import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { PRESET_NAME_MAX, type LineupPreset, type LineupRole, type RunSettings } from '../../shared/domain'
import type { Db } from '../db/open'
import { lineupPresets, lineupRoles } from '../db/schema'

export interface PresetRepo {
  /** The workspace's presets, first first. */
  list(workspaceId: string): Promise<LineupPreset[]>
  get(id: string): Promise<LineupPreset | null>
  /**
   * Adds a preset (appended last), or replaces the one with `id` (keeping its place); renaming is the same call. Throws,
   * with a message for the user, when the name is blank, too long, over several lines or another preset's (any case).
   */
  save(workspaceId: string, input: { id?: string; name: string; settings: RunSettings }): Promise<LineupPreset>
  remove(id: string): Promise<void>
}

type Role = Pick<LineupRole, 'id' | 'name'>

const NO_SETTINGS: RunSettings = { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} }

/**
 * The presets every workspace starts with, against its Change lineup: Full (all roles), Quick fix (no Planner) and
 * Docs (the Implementer only, on Sonnet at medium effort). A Planner or Implementer the lineup lacks is named by the
 * placeholder id "planner" or "implementer", so applying the preset drops that part with the usual notice.
 * Migration 0031 has its own copy of this, as it was when written.
 */
export function defaultPresets(lineup: Role[]): Array<{ name: string; settings: RunSettings }> {
  const find = (name: string): Role | undefined => lineup.find((r) => r.name.trim().toLowerCase() === name)
  const planner = find('planner')
  const implementer = find('implementer')
  const implementerRole = implementer ?? { id: 'implementer', name: 'Implementer' }
  return [
    { name: 'Full', settings: NO_SETTINGS },
    {
      name: 'Quick fix',
      settings: planner
        ? { ...NO_SETTINGS, excludedRoleIds: [planner.id], roleNames: { [planner.id]: planner.name } }
        : { ...NO_SETTINGS, excludedRoleIds: ['planner'], roleNames: { planner: 'Planner' } }
    },
    {
      name: 'Docs',
      settings: {
        excludedRoleIds: lineup.filter((r) => r.id !== implementer?.id).map((r) => r.id),
        roles: { [implementerRole.id]: { model: 'sonnet', effort: 'medium' } },
        extraInstructions: null,
        roleNames: { ...Object.fromEntries(lineup.map((r) => [r.id, r.name])), [implementerRole.id]: implementerRole.name }
      }
    }
  ]
}

/** Adds the built-in presets to a new workspace, which already has its lineup. */
export async function insertDefaultPresets(db: Db, workspaceId: string, now: () => Date): Promise<void> {
  const lineup = await db
    .select({ id: lineupRoles.id, name: lineupRoles.name })
    .from(lineupRoles)
    .where(and(eq(lineupRoles.workspaceId, workspaceId), eq(lineupRoles.lineup, 'change')))
    .orderBy(asc(lineupRoles.position))
  await db.insert(lineupPresets).values(
    defaultPresets(lineup).map((p, i) => ({
      id: randomUUID(),
      workspaceId,
      position: i + 1,
      name: p.name,
      settings: JSON.stringify(p.settings),
      createdAt: now().toISOString()
    }))
  )
}

function toPreset(row: typeof lineupPresets.$inferSelect): LineupPreset {
  return { id: row.id, workspaceId: row.workspaceId, name: row.name, settings: JSON.parse(row.settings) as RunSettings }
}

export function createPresetRepo(db: Db, now: () => Date): PresetRepo {
  async function list(workspaceId: string): Promise<LineupPreset[]> {
    const rows = await db
      .select()
      .from(lineupPresets)
      .where(eq(lineupPresets.workspaceId, workspaceId))
      .orderBy(asc(lineupPresets.position))
    return rows.map(toPreset)
  }

  async function get(id: string): Promise<LineupPreset | null> {
    const [row] = await db.select().from(lineupPresets).where(eq(lineupPresets.id, id))
    return row ? toPreset(row) : null
  }

  return {
    list,
    get,
    async save(workspaceId, input) {
      const name = input.name.trim()
      if (name === '') throw new Error('A preset needs a name.')
      if (/[\r\n]/.test(name)) throw new Error('A preset name must be on one line.')
      if (name.length > PRESET_NAME_MAX) throw new Error(`A preset name must be at most ${PRESET_NAME_MAX} characters.`)
      const existing = await list(workspaceId)
      if (existing.some((p) => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`There is already a preset called "${name}".`)
      }
      const settings = JSON.stringify(input.settings)
      if (input.id !== undefined) {
        const current = existing.find((p) => p.id === input.id)
        if (!current) throw new Error('That preset no longer exists.')
        await db.update(lineupPresets).set({ name, settings }).where(eq(lineupPresets.id, input.id))
        return { ...current, name, settings: input.settings }
      }
      const id = randomUUID()
      const position = existing.length === 0 ? 1 : Math.max(...(await positions(workspaceId))) + 1
      await db
        .insert(lineupPresets)
        .values({ id, workspaceId, position, name, settings, createdAt: now().toISOString() })
      return { id, workspaceId, name, settings: input.settings }
    },
    async remove(id) {
      await db.delete(lineupPresets).where(eq(lineupPresets.id, id))
    }
  }

  async function positions(workspaceId: string): Promise<number[]> {
    const rows = await db.select({ p: lineupPresets.position }).from(lineupPresets).where(eq(lineupPresets.workspaceId, workspaceId))
    return rows.map((r) => r.p)
  }
}

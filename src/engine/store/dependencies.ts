import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Blocker, DependencyNote } from '../../shared/domain'
import type { Db } from '../db/open'
import { ticketDependencies, ticketDependencyNotes, tickets, workspaces } from '../db/schema'

export interface DependencyRepo {
  /** What blocks the ticket, in number order. A blocker in a removed workspace is left out. */
  blockersOf(ticketId: string): Promise<Blocker[]>
  /** The blockers of every ticket in the workspace that has any, by ticket id. */
  forWorkspace(workspaceId: string): Promise<Map<string, Blocker[]>>
  /** The tickets of the workspace that have at least one blocker not Done. */
  blockedIds(workspaceId: string): Promise<Set<string>>
  /** Every link in the workspace (ticket id to blocker ids), for the cycle check. */
  edges(workspaceId: string): Promise<Map<string, string[]>>
  /** The ids of the tickets blocked by this one. */
  dependentsOf(ticketId: string): Promise<string[]>
  addNote(ticketId: string, note: Omit<DependencyNote, 'id' | 'at'>): Promise<void>
  /** The ticket's notes, oldest first. */
  notesFor(ticketId: string): Promise<DependencyNote[]>
  notesForWorkspace(workspaceId: string): Promise<Map<string, DependencyNote[]>>
  /** The 'unblocked' notes at or after `since` (all when null), oldest first, with the ticket they are about. */
  unblockedSince(since: string | null): Promise<(DependencyNote & { ticketId: string })[]>
}

/** The statements that make `ids` the ticket's blockers, and bump its updatedAt (so an orchestrator edit's Undo is then refused). */
export function replaceDependencyStatements(db: Db, ticketId: string, ids: string[], at: string): BatchItem<'sqlite'>[] {
  return [
    db.delete(ticketDependencies).where(eq(ticketDependencies.ticketId, ticketId)),
    ...insertDependencyStatements(db, ticketId, ids, at),
    db.update(tickets).set({ updatedAt: at }).where(eq(tickets.id, ticketId))
  ]
}

/** The statements that add links for a ticket created in the same batch. */
export function insertDependencyStatements(db: Db, ticketId: string, ids: string[], at: string): BatchItem<'sqlite'>[] {
  return ids.length === 0 ? [] : [db.insert(ticketDependencies).values(ids.map((blockedById) => ({ ticketId, blockedById, createdAt: at })))]
}

function toNote(row: typeof ticketDependencyNotes.$inferSelect): DependencyNote {
  return { id: row.id, at: row.at, kind: row.kind, blockers: JSON.parse(row.blockers) as DependencyNote['blockers'], via: row.via }
}

export function createDependencyRepo(db: Db, now: () => Date): DependencyRepo {
  async function blockerRows(where: SQL | undefined) {
    return db
      .select({ ticketId: ticketDependencies.ticketId, id: tickets.id, number: tickets.number, title: tickets.title, column: tickets.manualColumn })
      .from(ticketDependencies)
      .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedById))
      .innerJoin(workspaces, and(eq(workspaces.id, tickets.workspaceId), isNull(workspaces.removedAt)))
      .where(where)
      .orderBy(asc(tickets.number))
  }
  const toBlocker = (r: { id: string; number: number; title: string; column: string }): Blocker => ({
    id: r.id,
    number: r.number,
    title: r.title,
    done: r.column === 'done'
  })

  async function forWorkspace(workspaceId: string): Promise<Map<string, Blocker[]>> {
    const own = db.select({ id: tickets.id }).from(tickets).where(eq(tickets.workspaceId, workspaceId))
    const rows = await blockerRows(inArray(ticketDependencies.ticketId, own))
    const out = new Map<string, Blocker[]>()
    for (const r of rows) out.set(r.ticketId, [...(out.get(r.ticketId) ?? []), toBlocker(r)])
    return out
  }

  return {
    async blockersOf(ticketId) {
      return (await blockerRows(eq(ticketDependencies.ticketId, ticketId))).map(toBlocker)
    },

    forWorkspace,

    async blockedIds(workspaceId) {
      const ids = new Set<string>()
      for (const [id, blockers] of await forWorkspace(workspaceId)) if (blockers.some((b) => !b.done)) ids.add(id)
      return ids
    },

    async edges(workspaceId) {
      const own = db.select({ id: tickets.id }).from(tickets).where(eq(tickets.workspaceId, workspaceId))
      const rows = await db
        .select({ ticketId: ticketDependencies.ticketId, blockedById: ticketDependencies.blockedById })
        .from(ticketDependencies)
        .where(inArray(ticketDependencies.ticketId, own))
      const out = new Map<string, string[]>()
      for (const r of rows) out.set(r.ticketId, [...(out.get(r.ticketId) ?? []), r.blockedById])
      return out
    },

    async dependentsOf(ticketId) {
      const rows = await db
        .select({ id: ticketDependencies.ticketId })
        .from(ticketDependencies)
        .where(eq(ticketDependencies.blockedById, ticketId))
      return rows.map((r) => r.id)
    },

    async addNote(ticketId, note) {
      await db
        .insert(ticketDependencyNotes)
        .values({ id: randomUUID(), ticketId, kind: note.kind, at: now().toISOString(), blockers: JSON.stringify(note.blockers), via: note.via })
    },

    async notesFor(ticketId) {
      const rows = await db
        .select()
        .from(ticketDependencyNotes)
        .where(eq(ticketDependencyNotes.ticketId, ticketId))
        .orderBy(asc(ticketDependencyNotes.at), asc(sql`rowid`))
      return rows.map(toNote)
    },

    async notesForWorkspace(workspaceId) {
      const rows = await db
        .select({ note: ticketDependencyNotes })
        .from(ticketDependencyNotes)
        .innerJoin(tickets, eq(tickets.id, ticketDependencyNotes.ticketId))
        .where(eq(tickets.workspaceId, workspaceId))
        .orderBy(asc(ticketDependencyNotes.at))
      const out = new Map<string, DependencyNote[]>()
      for (const r of rows) out.set(r.note.ticketId, [...(out.get(r.note.ticketId) ?? []), toNote(r.note)])
      return out
    },

    async unblockedSince(since) {
      const rows = await db
        .select()
        .from(ticketDependencyNotes)
        .where(and(eq(ticketDependencyNotes.kind, 'unblocked'), since === null ? undefined : gte(ticketDependencyNotes.at, since)))
        .orderBy(asc(ticketDependencyNotes.at), asc(sql`rowid`))
      return rows.map((r) => ({ ...toNote(r), ticketId: r.ticketId }))
    }
  }
}

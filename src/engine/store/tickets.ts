import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Criterion, IntentEntry, NewTicketInput, PullRequest, RunSettings, Ticket, TicketKind, TicketPatch } from '../../shared/domain'
import type { Db } from '../db/open'
import { criteria, tickets } from '../db/schema'

export interface TicketRepo {
  create(input: NewTicketInput): Promise<Ticket>
  /**
   * Creates the tickets in order, in one batch: all of them, or none if one insert fails. `alsoInBatch` gets
   * their ids and returns more statements for the same batch, which then succeed or fail with the tickets.
   */
  createMany(inputs: NewTicketInput[], alsoInBatch?: (ids: string[]) => BatchItem<'sqlite'>[]): Promise<Ticket[]>
  get(id: string): Promise<Ticket>
  /** The ticket with this number in the workspace, or null. */
  byNumber(workspaceId: string, number: number): Promise<Ticket | null>
  list(workspaceId: string): Promise<Ticket[]>
  update(id: string, patch: TicketPatch): Promise<Ticket>
  /**
   * Intent is append-only: this is the only way to add to it, and nothing edits or removes an entry. The one exception is
   * the Undo of an orchestrator edit (TicketEditRepo.undo), which removes the entries that edit appended moments before.
   */
  appendIntent(id: string, text: string): Promise<Ticket>
  setManualColumn(id: string, column: 'backlog' | 'ready' | 'done'): Promise<Ticket>
  /** Whether the ticket was to be proposed for starting once in Ready; clears the flag, so it answers true once. */
  takeStartWhenReady(id: string): Promise<boolean>
  setWorktree(id: string, branch: string, path: string | null): Promise<Ticket>
  /** Records the ticket's pull request and clears any earlier failure. */
  setPr(id: string, pr: PullRequest): Promise<Ticket>
  setPrError(id: string, error: string | null): Promise<Ticket>
  /** Saves the ticket's run settings, already checked; null clears them, back to the lineup's defaults. */
  setRunSettings(id: string, settings: RunSettings | null): Promise<Ticket>
  /**
   * Promotes an Investigate ticket: inserts a Change ticket in Ready carrying the original's intent exactly (every
   * entry, with its timestamp and source), its labels and its report, with `promotedFrom` set. Moving the original
   * is not done here.
   */
  createPromoted(original: Ticket, fields: { title: string; spec: string }): Promise<Ticket>
  /** The ticket promoted from this one, or null. */
  promotedTo(id: string): Promise<Ticket | null>
  /** Saves the report an Investigate ticket's last role submitted. */
  setReport(id: string, markdown: string): Promise<Ticket>
  /** Records the latest save of the report to the repo: the file's path, and the commit or why it failed. */
  setReportFile(id: string, saved: { path: string | null; commit: string | null; error: string | null }): Promise<Ticket>
  /**
   * Ticks the criterion at `position` (never unticks). Returns it with `wasChecked` (whether it was already
   * ticked), or null when the ticket has no criterion there.
   */
  checkCriterion(id: string, position: number): Promise<(Criterion & { wasChecked: boolean }) | null>
}

type TicketRow = typeof tickets.$inferSelect

function toTicket(row: TicketRow, ticketCriteria: Criterion[]): Ticket {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    number: row.number,
    kind: row.kind as TicketKind,
    title: row.title,
    intent: JSON.parse(row.intent) as IntentEntry[],
    spec: row.spec,
    criteria: ticketCriteria,
    labels: JSON.parse(row.labels) as string[],
    manualColumn: row.manualColumn as Ticket['manualColumn'],
    branch: row.branch,
    worktreePath: row.worktreePath,
    pr: row.prUrl !== null && row.prNumber !== null ? { url: row.prUrl, number: row.prNumber } : null,
    prError: row.prError,
    report: row.report,
    reportFile: row.reportFile,
    reportCommit: row.reportCommit,
    reportFileError: row.reportFileError,
    promotedFrom: row.promotedFrom,
    runSettings: row.runSettings === null ? null : (JSON.parse(row.runSettings) as RunSettings),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/**
 * The statements of `ticket.update`, to run in a batch: the changed columns, then the criteria replaced as given (ticks
 * included), stamped `at`. Also what the orchestrator's edit and its Undo run, so there is one path.
 */
export function patchStatements(db: Db, id: string, patch: TicketPatch, at: string): [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] {
  const set: Partial<typeof tickets.$inferInsert> = {}
  if (patch.title !== undefined) set.title = patch.title
  if (patch.spec !== undefined) set.spec = patch.spec
  if (patch.labels !== undefined) set.labels = JSON.stringify(patch.labels)
  const items: BatchItem<'sqlite'>[] = []
  if (patch.criteria !== undefined) {
    items.push(db.delete(criteria).where(eq(criteria.ticketId, id)))
    if (patch.criteria.length > 0) {
      items.push(db.insert(criteria).values(patch.criteria.map((c, position) => ({ ticketId: id, position, text: c.text, checked: c.checked }))))
    }
  }
  return [db.update(tickets).set({ ...set, updatedAt: at }).where(eq(tickets.id, id)), ...items]
}

/**
 * The statement that appends `entry` to the ticket's intent, stamped `entry.at`. Appended inside SQLite so two
 * concurrent appends cannot overwrite each other.
 */
export function appendIntentStatement(db: Db, id: string, entry: IntentEntry): BatchItem<'sqlite'> {
  return db
    .update(tickets)
    .set({ intent: sql`json_insert(${tickets.intent}, '$[#]', json(${JSON.stringify(entry)}))`, updatedAt: entry.at })
    .where(eq(tickets.id, id))
}

export function createTicketRepo(db: Db, now: () => Date): TicketRepo {
  async function criteriaFor(ticketId: string): Promise<Criterion[]> {
    return db
      .select({ position: criteria.position, text: criteria.text, checked: criteria.checked })
      .from(criteria)
      .where(eq(criteria.ticketId, ticketId))
      .orderBy(asc(criteria.position))
  }

  async function get(id: string): Promise<Ticket> {
    const [row] = await db.select().from(tickets).where(eq(tickets.id, id))
    if (!row) throw new Error(`Ticket not found: ${id}`)
    return toTicket(row, await criteriaFor(id))
  }

  /** Applies columns to a ticket (and stamps updatedAt) after checking that it exists. */
  async function patchRow(id: string, set: { [K in keyof typeof tickets.$inferInsert]?: (typeof tickets.$inferInsert)[K] | SQL }): Promise<void> {
    const [row] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id))
    if (!row) throw new Error(`Ticket not found: ${id}`)
    await db
      .update(tickets)
      .set({ ...set, updatedAt: now().toISOString() })
      .where(eq(tickets.id, id))
  }

  /** The inserts of one ticket and its criteria, to run in a batch. */
  function inserts(id: string, input: NewTicketInput): BatchItem<'sqlite'>[] {
    const at = now().toISOString()
    const first: IntentEntry = input.source
      ? { text: input.intent, at, source: input.source }
      : input.via
        ? { text: input.intent, at, via: input.via }
        : { text: input.intent, at }
    const intent: IntentEntry[] = [
      first,
      ...(input.intentAdded ?? []).map((a) => ({ text: a.text, at: a.at })),
      ...(input.agentContext ? [{ text: input.agentContext.text, at, source: input.agentContext.source }] : [])
    ]
    const ticket = db.insert(tickets).values({
      id,
      workspaceId: input.workspaceId,
      // One statement, so the number is allocated atomically with the insert.
      number: sql`(select coalesce(max(${tickets.number}), 0) + 1 from ${tickets} where ${tickets.workspaceId} = ${input.workspaceId})`,
      kind: input.kind ?? 'change',
      title: input.title,
      intent: JSON.stringify(intent),
      spec: input.spec,
      labels: JSON.stringify(input.labels),
      manualColumn: input.column,
      startWhenReady: input.startWhenReady === true,
      createdAt: at,
      updatedAt: at
    })
    if (input.criteria.length === 0) return [ticket]
    return [ticket, db.insert(criteria).values(input.criteria.map((text, position) => ({ ticketId: id, position, text, checked: false })))]
  }

  async function createPromoted(original: Ticket, fields: { title: string; spec: string }): Promise<Ticket> {
    const id = randomUUID()
    const at = now().toISOString()
    await db.insert(tickets).values({
      id,
      workspaceId: original.workspaceId,
      // One statement, so the number is allocated atomically with the insert.
      number: sql`(select coalesce(max(${tickets.number}), 0) + 1 from ${tickets} where ${tickets.workspaceId} = ${original.workspaceId})`,
      kind: 'change',
      title: fields.title,
      intent: JSON.stringify(original.intent),
      spec: fields.spec,
      labels: JSON.stringify(original.labels),
      manualColumn: 'ready',
      report: original.report,
      promotedFrom: original.id,
      createdAt: at,
      updatedAt: at
    })
    return get(id)
  }

  async function createMany(inputs: NewTicketInput[], alsoInBatch?: (ids: string[]) => BatchItem<'sqlite'>[]): Promise<Ticket[]> {
    if (inputs.length === 0) return []
    const ids = inputs.map(() => randomUUID())
    const [first, ...rest] = [...inputs.flatMap((input, i) => inserts(ids[i]!, input)), ...(alsoInBatch?.(ids) ?? [])]
    // One batch: every insert or none, with nothing else run in between.
    await db.batch([first!, ...rest])
    return Promise.all(ids.map(get))
  }

  return {
    async create(input) {
      return (await createMany([input]))[0]!
    },

    createMany,

    createPromoted,

    async promotedTo(id) {
      const [row] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.promotedFrom, id))
      return row ? get(row.id) : null
    },

    get,

    async byNumber(workspaceId, number) {
      const [row] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.workspaceId, workspaceId), eq(tickets.number, number)))
      return row ? toTicket(row, await criteriaFor(row.id)) : null
    },

    async list(workspaceId) {
      const rows = await db
        .select()
        .from(tickets)
        .where(eq(tickets.workspaceId, workspaceId))
        .orderBy(asc(tickets.number))
      if (rows.length === 0) return []
      const criteriaRows = await db
        .select()
        .from(criteria)
        .where(
          inArray(
            criteria.ticketId,
            rows.map((r) => r.id)
          )
        )
        .orderBy(asc(criteria.position))
      return rows.map((row) =>
        toTicket(
          row,
          criteriaRows
            .filter((c) => c.ticketId === row.id)
            .map(({ position, text, checked }) => ({ position, text, checked }))
        )
      )
    },

    async update(id, patch) {
      await get(id)
      await db.batch(patchStatements(db, id, patch, now().toISOString()))
      return get(id)
    },

    async appendIntent(id, text) {
      await get(id)
      const entry: IntentEntry = { text, at: now().toISOString() }
      await db.batch([appendIntentStatement(db, id, entry)])
      return get(id)
    },

    async setManualColumn(id, column) {
      await patchRow(id, { manualColumn: column })
      return get(id)
    },

    async takeStartWhenReady(id) {
      const [row] = await db.select({ flag: tickets.startWhenReady }).from(tickets).where(eq(tickets.id, id))
      if (!row?.flag) return false
      // Only the update that flips it wins, so two moves to Ready don't both propose.
      const flipped = await db
        .update(tickets)
        .set({ startWhenReady: false })
        .where(and(eq(tickets.id, id), eq(tickets.startWhenReady, true)))
        .returning({ id: tickets.id })
      return flipped.length > 0
    },

    async setWorktree(id, branch, path) {
      await patchRow(id, { branch, worktreePath: path })
      return get(id)
    },

    async setPr(id, pr) {
      await patchRow(id, { prUrl: pr.url, prNumber: pr.number, prError: null })
      return get(id)
    },

    async setPrError(id, error) {
      await patchRow(id, { prError: error })
      return get(id)
    },

    async setRunSettings(id, settings) {
      await patchRow(id, { runSettings: settings === null ? null : JSON.stringify(settings) })
      return get(id)
    },

    async setReport(id, markdown) {
      await patchRow(id, { report: markdown })
      return get(id)
    },

    async setReportFile(id, saved) {
      await patchRow(id, { reportFile: saved.path, reportCommit: saved.commit, reportFileError: saved.error })
      return get(id)
    },

    async checkCriterion(id, position) {
      const where = and(eq(criteria.ticketId, id), eq(criteria.position, position))
      const [before] = await db.select({ checked: criteria.checked }).from(criteria).where(where)
      if (!before) return null
      // Only an unticked criterion changes, so two concurrent ticks record one tick between them.
      const [ticked] = await db
        .update(criteria)
        .set({ checked: true })
        .where(and(where, eq(criteria.checked, false)))
        .returning({ position: criteria.position, text: criteria.text, checked: criteria.checked })
      if (ticked) {
        await patchRow(id, {})
        return { ...ticked, wasChecked: false }
      }
      const [row] = await db
        .select({ position: criteria.position, text: criteria.text, checked: criteria.checked })
        .from(criteria)
        .where(where)
      return row ? { ...row, wasChecked: true } : null
    }
  }
}

import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Criterion, IntentEntry, NewTicketInput, PullRequest, RunSettings, Ticket, TicketKind, TicketRef, TicketPatch, TicketSetup } from '../../shared/domain'
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
  /** Every ticket of the workspace by number; archived ones too unless `includeArchived` is false. */
  list(workspaceId: string, opts?: { includeArchived?: boolean }): Promise<Ticket[]>
  /**
   * Archives Done tickets: a view state only (manual_column and updated_at stay). If any isn't Done it throws and
   * archives none. Archiving again keeps the first stamp.
   */
  archive(ids: string[]): Promise<Ticket[]>
  /** Clears the archive mark; the tickets are Done on the board again. */
  unarchive(ids: string[]): Promise<Ticket[]>
  /**
   * The workspace's archived tickets, newest archived first. `before` is the last ticket of the previous page
   * (bulk archives share one timestamp, so the number breaks the tie). `query` matches like the board's search.
   */
  listArchived(
    workspaceId: string,
    opts?: { query?: string; before?: { archivedAt: string; number: number }; limit?: number }
  ): Promise<Ticket[]>
  /** How many archived tickets match the query (all of them without one), paging ignored. */
  countArchived(workspaceId: string, opts?: { query?: string }): Promise<number>
  /** Every promotion in the workspace, archived tickets included: the Investigate ticket and the Change ticket made from it. */
  promotions(workspaceId: string): Promise<{ from: TicketRef; to: TicketRef }[]>
  update(id: string, patch: TicketPatch): Promise<Ticket>
  /**
   * Intent is append-only: this is the only way to add to it, and nothing edits or removes an entry. The one exception is
   * the Undo of an orchestrator edit (TicketEditRepo.undo), which removes the entries that edit appended moments before.
   */
  appendIntent(id: string, text: string): Promise<Ticket>
  /**
   * Moves the ticket to a column. Into Backlog or Ready it takes `rank` (a position among that column) or, with none
   * given, the bottom; Done leaves the rank as it is.
   */
  setManualColumn(id: string, column: 'backlog' | 'ready' | 'done', rank?: number): Promise<Ticket>
  /** Sets the ticket's rank (a number, or 'bottom' for after every other ticket in the workspace). */
  setRank(id: string, rank: number | 'bottom'): Promise<Ticket>
  /** Sets several ranks in one batch (a rebalance). */
  setRanks(entries: { id: string; rank: number }[]): Promise<void>
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
  /** Saves the state of the workspace's setup command in the ticket's folder; null when none applies. */
  setSetup(id: string, setup: TicketSetup | null): Promise<Ticket>
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

/** One statement, so the rank is taken atomically with the insert or update, like the ticket number. */
function bottomRank(workspaceId: SQL | string): SQL {
  return sql`(select coalesce(max(${tickets.rank}), 0) + 1 from ${tickets} where ${tickets.workspaceId} = ${workspaceId})`
}

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
    rank: row.rank,
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
    setup: row.setup === null ? null : (JSON.parse(row.setup) as TicketSetup),
    doneAt: row.doneAt,
    archivedAt: row.archivedAt,
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

/** The conditions for a workspace's archived tickets that match the board's search; `query` is optional. */
function archivedMatch(workspaceId: string, rawQuery: string | undefined): (SQL | undefined)[] {
  const conds: (SQL | undefined)[] = [eq(tickets.workspaceId, workspaceId), isNotNull(tickets.archivedAt)]
  const q = rawQuery?.trim().toLowerCase() ?? ''
  if (q !== '') {
    if (/^#\d+$/.test(q)) {
      conds.push(eq(tickets.number, Number(q.slice(1))))
    } else {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      const text = or(
        sql`lower(${tickets.title}) like ${like} escape '\\'`,
        sql`exists (select 1 from json_each(${tickets.labels}) where lower(value) like ${like} escape '\\')`,
        sql`exists (select 1 from json_each(${tickets.intent}) where lower(json_extract(value, '$.text')) like ${like} escape '\\')`
      )
      conds.push(/^\d+$/.test(q) ? or(eq(tickets.number, Number(q)), text) : text)
    }
  }
  return conds
}

export function createTicketRepo(db: Db, now: () => Date): TicketRepo {
  async function criteriaFor(ticketId: string): Promise<Criterion[]> {
    return db
      .select({ position: criteria.position, text: criteria.text, checked: criteria.checked })
      .from(criteria)
      .where(eq(criteria.ticketId, ticketId))
      .orderBy(asc(criteria.position))
  }

  /** The tickets with their criteria loaded, in the order of `rows`. */
  async function withCriteria(rows: TicketRow[]): Promise<Ticket[]> {
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
        criteriaRows.filter((c) => c.ticketId === row.id).map(({ position, text, checked }) => ({ position, text, checked }))
      )
    )
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
      rank: bottomRank(input.workspaceId),
      startWhenReady: input.startWhenReady === true,
      runSettings: input.runSettings ? JSON.stringify(input.runSettings) : null,
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
      rank: bottomRank(original.workspaceId),
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

    async list(workspaceId, opts) {
      const where =
        opts?.includeArchived === false
          ? and(eq(tickets.workspaceId, workspaceId), isNull(tickets.archivedAt))
          : eq(tickets.workspaceId, workspaceId)
      return withCriteria(await db.select().from(tickets).where(where).orderBy(asc(tickets.number)))
    },

    async archive(ids) {
      if (ids.length === 0) return []
      const rows = await db.select().from(tickets).where(inArray(tickets.id, ids))
      const missing = ids.find((id) => !rows.some((r) => r.id === id))
      if (missing !== undefined) throw new Error(`Ticket not found: ${missing}`)
      const notDone = rows.filter((r) => r.manualColumn !== 'done')
      if (notDone.length > 0) {
        const names = notDone.map((r) => `#${r.number}`).join(', ')
        throw new Error(`Only Done tickets can be archived: ${names} ${notDone.length === 1 ? "isn't" : "aren't"} Done. Nothing was archived.`)
      }
      // A view state, not an edit: updated_at stays. Re-archiving keeps the first stamp.
      await db
        .update(tickets)
        .set({ archivedAt: now().toISOString() })
        .where(and(inArray(tickets.id, ids), eq(tickets.manualColumn, 'done'), isNull(tickets.archivedAt)))
      return withCriteria(await db.select().from(tickets).where(inArray(tickets.id, ids)).orderBy(asc(tickets.number)))
    },

    async unarchive(ids) {
      if (ids.length === 0) return []
      const rows = await db.select({ id: tickets.id }).from(tickets).where(inArray(tickets.id, ids))
      const missing = ids.find((id) => !rows.some((r) => r.id === id))
      if (missing !== undefined) throw new Error(`Ticket not found: ${missing}`)
      // A restore gives the ticket a fresh window: the automatic sweep counts its days from now.
      await db
        .update(tickets)
        .set({ archivedAt: null, archiveBatchId: null, restoredAt: now().toISOString() })
        .where(and(inArray(tickets.id, ids), isNotNull(tickets.archivedAt)))
      return withCriteria(await db.select().from(tickets).where(inArray(tickets.id, ids)).orderBy(asc(tickets.number)))
    },

    async listArchived(workspaceId, opts) {
      const limit = Math.min(200, Math.max(1, Math.floor(opts?.limit ?? 50)))
      const conds = archivedMatch(workspaceId, opts?.query)
      const before = opts?.before
      if (before) {
        conds.push(
          or(
            lt(tickets.archivedAt, before.archivedAt),
            and(eq(tickets.archivedAt, before.archivedAt), lt(tickets.number, before.number))
          )
        )
      }
      return withCriteria(
        await db
          .select()
          .from(tickets)
          .where(and(...conds))
          .orderBy(desc(tickets.archivedAt), desc(tickets.number))
          .limit(limit)
      )
    },

    async countArchived(workspaceId, opts) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(tickets)
        .where(and(...archivedMatch(workspaceId, opts?.query)))
      return Number(row?.n ?? 0)
    },

    async promotions(workspaceId) {
      const rows = await db
        .select({ id: tickets.id, promotedFrom: tickets.promotedFrom })
        .from(tickets)
        .where(and(eq(tickets.workspaceId, workspaceId), isNotNull(tickets.promotedFrom)))
      if (rows.length === 0) return []
      const ids = [...new Set(rows.flatMap((r) => [r.id, r.promotedFrom!]))]
      const refs = new Map(
        (
          await db
            .select({ id: tickets.id, number: tickets.number, title: tickets.title, archivedAt: tickets.archivedAt })
            .from(tickets)
            .where(inArray(tickets.id, ids))
        ).map((r) => [r.id, { id: r.id, number: r.number, title: r.title, archived: r.archivedAt !== null }] as const)
      )
      return rows.flatMap((r) => {
        const from = refs.get(r.promotedFrom!)
        const to = refs.get(r.id)
        return from && to ? [{ from, to }] : []
      })
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

    async setManualColumn(id, column, rank) {
      // Done again keeps the first entry time; leaving Done clears both, so only Done tickets are ever archived.
      if (column === 'done') {
        await patchRow(id, { manualColumn: column, doneAt: sql`coalesce(${tickets.doneAt}, ${now().toISOString()})` })
      } else if (rank !== undefined) {
        await patchRow(id, { manualColumn: column, doneAt: null, archivedAt: null, archiveBatchId: null, restoredAt: null, rank })
      } else {
        const [row] = await db.select({ workspaceId: tickets.workspaceId }).from(tickets).where(eq(tickets.id, id))
        if (!row) throw new Error(`Ticket not found: ${id}`)
        await patchRow(id, { manualColumn: column, doneAt: null, archivedAt: null, archiveBatchId: null, restoredAt: null, rank: bottomRank(row.workspaceId) })
      }
      return get(id)
    },

    async setRank(id, rank) {
      if (rank !== 'bottom') await patchRow(id, { rank })
      else {
        const [row] = await db.select({ workspaceId: tickets.workspaceId }).from(tickets).where(eq(tickets.id, id))
        if (!row) throw new Error(`Ticket not found: ${id}`)
        await patchRow(id, { rank: bottomRank(row.workspaceId) })
      }
      return get(id)
    },

    async setRanks(entries) {
      if (entries.length === 0) return
      const [first, ...rest] = entries.map((e) => db.update(tickets).set({ rank: e.rank }).where(eq(tickets.id, e.id)))
      await db.batch([first!, ...rest])
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

    async setSetup(id, setup) {
      await patchRow(id, { setup: setup === null ? null : JSON.stringify(setup) })
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

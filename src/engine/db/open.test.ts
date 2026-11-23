import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { count, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveHome, type HomePaths } from '../home'
import { openDb } from './open'
import { createDecisionRepo } from '../store/decisions'
import { createLineupRepo, defaultInvestigateLineup, defaultLineup, insertDefaultLineup } from '../store/lineups'
import { createPresetRepo, defaultPresets } from '../store/presets'
import { createRunRepo } from '../store/runs'
import { createHoldRepo } from '../store/holds'
import { criteria, lineupPresets, lineupRoles, tickets, workspaces } from './schema'

const realMigrations = path.join(import.meta.dirname, 'migrations')

let tmp: string
let paths: HomePaths
let closers: Array<() => void>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-db-'))
  paths = resolveHome({ MAINBUS_HOME: tmp }, 'dev', os.homedir())
  closers = []
})

afterEach(() => {
  for (const close of closers) close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function open(migrationsDir = realMigrations, now?: () => Date) {
  const handle = await openDb(paths, migrationsDir, now)
  closers.push(handle.close)
  return handle
}

function backupFiles(): string[] {
  return fs.existsSync(paths.backups)
    ? fs.readdirSync(paths.backups).filter((f) => /^mainbus-.*\.db$/.test(f))
    : []
}

/** Copies the real migrations, keeping only the first `count`: the database as an older Mainbus left it. */
function firstMigrations(count: number): string {
  const dir = path.join(tmp, `migrations-first-${count}`)
  fs.cpSync(realMigrations, dir, { recursive: true })
  const journalPath = path.join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  journal.entries = journal.entries.slice(0, count)
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return dir
}

/** Copies the real migrations and appends one migration (a no-op by default) that is newer than all of them. */
function withExtraMigration(migrationSql = 'SELECT 1;'): string {
  const dir = path.join(tmp, 'migrations-extra')
  fs.cpSync(realMigrations, dir, { recursive: true })
  const journalPath = path.join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  const last = journal.entries[journal.entries.length - 1]
  journal.entries.push({
    idx: journal.entries.length,
    version: last.version,
    when: last.when + 1000,
    tag: '9999_noop',
    breakpoints: true
  })
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  fs.writeFileSync(path.join(dir, '9999_noop.sql'), migrationSql)
  return dir
}

describe('openDb', () => {
  it('creates the database and applies all migrations', async () => {
    const { db } = await open()
    expect(fs.existsSync(paths.db)).toBe(true)
    const rows = await db.select({ n: count() }).from(tickets)
    expect(rows[0].n).toBe(0)
  })

  it('migrates an existing workspace with opening PRs off, and its tickets with no PR', async () => {
    // The migrations as they were before pull requests: the first one only.
    const first = await open(firstMigrations(1))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'change', 'T', '[]', '', '[]', 'ready', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open()
    const [ws] = await db.select().from(workspaces)
    expect(ws.openPrOnReview).toBe(false)
    const [ticket] = await db.select().from(tickets)
    expect(ticket).toMatchObject({ prUrl: null, prNumber: null, prError: null })
  })

  it("backfills each ticket's rank with its number, so the board's order is unchanged", async () => {
    // The migrations as they were before 0042 (ticket ranks).
    const first = await open(firstMigrations(42))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    for (const n of [1, 2, 3]) {
      await first.db.run(
        sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
            values (${`t${n}`}, 'w1', ${n}, 'change', 'T', '[]', '', '[]', 'ready', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
      )
    }
    first.close()
    closers = []

    const { db } = await open()
    const rows = await db.select().from(tickets)
    expect(rows.map((r) => [r.number, r.rank])).toEqual([[1, 1], [2, 2], [3, 3]])
  })

  it("gives every existing ticket the agent as its owner", async () => {
    // The migrations as they were before 0046 (ticket owners).
    const first = await open(firstMigrations(46))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'change', 'T', '[]', '', '[]', 'ready', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open()
    expect((await db.select().from(tickets)).map((r) => r.owner)).toEqual(['agent'])
  })

  it("turns each workspace's role into its lineup's Implementer, between the default Planner and Reviewer", async () => {
    // The migrations as they were before lineups: one role per workspace.
    const first = await open(firstMigrations(2))
    for (const id of ['w1', 'w2']) {
      await first.db.run(
        sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
            values (${id}, 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
      )
    }
    await first.db.run(
      sql`insert into roles (workspace_id, name, instructions, active_phase, tool_profile, model, effort)
          values ('w1', 'Implementer', 'My own words.', 'implementing', 'edit', 'opus', 'high'),
                 ('w2', 'Implementer', 'Defaults.', 'implementing', 'edit', null, null)`
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 9, 31, 9, 0, 0))
    expect(backupFiles()).toEqual(['mainbus-20261031-090000.db'])
    const roles = await db
      .select()
      .from(lineupRoles)
      .where(eq(lineupRoles.lineup, 'change'))
      .orderBy(lineupRoles.workspaceId, lineupRoles.position)
    const lineups = createLineupRepo(db)
    const defaults = defaultLineup()
    for (const [workspaceId, instructions, model, effort] of [
      ['w1', 'My own words.', 'opus', 'high'],
      ['w2', 'Defaults.', null, null]
    ] as const) {
      const lineup = await lineups.get(workspaceId)
      const [planner, implementer, reviewer] = lineup
      expect(lineup.map((r) => r.position)).toEqual([1, 2, 3])
      expect(planner).toMatchObject({ ...defaults[0], id: planner!.id })
      expect(implementer).toMatchObject({
        name: 'Implementer',
        instructions,
        model,
        effort,
        activePhase: 'implementing',
        toolProfile: 'edit',
        onProblem: 'hand_back',
        handBackTo: planner!.id
      })
      expect(reviewer).toMatchObject({ ...defaults[2], id: reviewer!.id, handBackTo: implementer!.id })
      for (const role of lineup) expect(role.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(new Set(roles.map((r) => r.id)).size).toBe(6)
    const tables = await db.values<[string]>(sql`select name from sqlite_master where type = 'table' and name = 'roles'`)
    expect(tables).toEqual([])
  })

  it('seeds the Investigate lineup for every existing workspace and adds the report column', async () => {
    // The migrations as they were before Investigate tickets.
    const first = await open(firstMigrations(20))
    for (const id of ['w1', 'w2']) {
      await first.db.run(
        sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
            values (${id}, 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
      )
    }
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'change', 'T', '[]', '', '[]', 'backlog', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 9, 31, 9, 0, 0))
    expect(backupFiles()).toHaveLength(1)
    const lineups = createLineupRepo(db)
    const [investigator] = defaultInvestigateLineup()
    const ids = new Set<string>()
    for (const workspaceId of ['w1', 'w2']) {
      const lineup = await lineups.get(workspaceId, 'investigate')
      expect(lineup).toHaveLength(1)
      expect(lineup[0]).toMatchObject({ ...investigator, id: lineup[0]!.id, lineup: 'investigate', position: 1, workspaceId })
      expect(lineup[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      ids.add(lineup[0]!.id)
      expect(await lineups.get(workspaceId)).toHaveLength(0)
    }
    expect(ids.size).toBe(2)
    const [ticket] = await db.select().from(tickets)
    expect(ticket).toMatchObject({ id: 't1', kind: 'change', report: null })
  })

  it('migration 0039 repairs string-typed preset settings, leaves correct ones alone, and is harmless twice', async () => {
    const first = await open(firstMigrations(39))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w1', '2026-10-30T00:00:00.000Z')`
    )
    const good = '{"excludedRoleIds":["a"],"roles":{},"extraInstructions":null,"roleNames":{"a":"A"}}'
    const bad = JSON.stringify({
      excludedRoleIds: '["a","b"]',
      roles: {},
      extraInstructions: null,
      roleNames: '{"a":"A","b":"B"}'
    })
    const notJson = JSON.stringify({ excludedRoleIds: 'oops', roles: {}, extraInstructions: null, roleNames: {} })
    const rows = [['good', good], ['bad', bad], ['notjson', notJson]]
    for (const [i, [id, settings]] of rows.entries()) {
      await first.db.run(
        sql`insert into lineup_presets (id, workspace_id, position, name, settings, created_at)
            values (${id}, 'w1', ${i + 100}, ${id}, ${settings}, '2026-10-30T00:00:00.000Z')`
      )
    }
    first.close()
    closers = []

    const read = async (h: Awaited<ReturnType<typeof open>>) =>
      Object.fromEntries(
        (await h.db.select({ id: lineupPresets.id, settings: lineupPresets.settings }).from(lineupPresets).where(inArray(lineupPresets.id, ['good', 'bad', 'notjson']))).map(
          (r) => [r.id, r.settings]
        )
      )
    const second = await open()
    const repaired = await read(second)
    expect(JSON.parse(repaired.bad!)).toEqual({
      excludedRoleIds: ['a', 'b'],
      roles: {},
      extraInstructions: null,
      roleNames: { a: 'A', b: 'B' }
    })
    expect(repaired.good).toBe(good)
    expect(repaired.notjson).toBe(notJson)
    second.close()
    closers = []

    // Running the same SQL again changes nothing.
    const sqlText = fs.readFileSync(path.join(realMigrations, '0039_repair_preset_json.sql'), 'utf8')
    const third = await open()
    for (const stmt of sqlText.split('--> statement-breakpoint')) await third.db.run(sql.raw(stmt))
    expect(await read(third)).toEqual(repaired)
  })

  it('seeds the built-in presets for every existing workspace, as the code seeds them for a new one, after a backup', async () => {
    // The migrations as they were before presets.
    const first = await open(firstMigrations(31))
    for (const id of ['w1', 'w2']) {
      await first.db.run(
        sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
            values (${id}, 'W', 'repo-path', 'main', ${id}, '2026-10-30T00:00:00.000Z')`
      )
    }
    await insertDefaultLineup(first.db, 'w1')
    // w2 has a lineup with no Planner or Implementer.
    await first.db.insert(lineupRoles).values(
      ['Architect', 'Checker'].map((name, i) => ({
        id: `w2-${i}`,
        workspaceId: 'w2',
        lineup: 'change',
        position: i + 1,
        name,
        instructions: '',
        activePhase: 'implementing',
        onProblem: 'ask_me',
        handBackTo: null,
        model: null,
        effort: null,
        toolProfile: 'edit'
      }))
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 10, 7, 9, 0, 0))
    expect(backupFiles()).toHaveLength(1)
    const presets = createPresetRepo(db, () => new Date())
    const lineups = createLineupRepo(db)
    for (const workspaceId of ['w1', 'w2']) {
      const lineup = await lineups.get(workspaceId)
      const seeded = await presets.list(workspaceId)
      // The migration's SQL and insertDefaultPresets agree.
      expect(seeded.map((p) => ({ name: p.name, settings: p.settings }))).toEqual(defaultPresets(lineup))
      expect(seeded.map((p) => p.id).every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true)
    }
    const w2 = await presets.list('w2')
    expect(w2[1]!.settings.excludedRoleIds).toEqual(['planner'])
    expect(w2[2]!.settings.roles).toEqual({ implementer: { model: 'sonnet', effort: 'medium' } })
  })

  it('gives every existing agent run its own one-role ticket run, keeping its thread and decisions', async () => {
    // The migrations as they were before ticket runs.
    const first = await open(firstMigrations(3))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into lineup_roles (id, workspace_id, lineup, position, name, instructions, active_phase, on_problem, tool_profile)
          values ('role-i', 'w1', 'change', 2, 'Implementer', 'My own words.', 'testing', 'hand_back', 'edit')`
    )
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'change', 'T', '[]', '', '[]', 'ready', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into agent_runs (id, ticket_id, role, session_id, model, effort, started_at, ended_at, end_reason)
          values ('r1', 't1', 'Builder', null, null, null, '2026-10-30T01:00:00.000Z', '2026-10-30T02:00:00.000Z', 'handoff'),
                 ('r2', 't1', 'Implementer', 'sess-2', 'opus', 'high', '2026-10-30T03:00:00.000Z', null, null)`
    )
    await first.db.run(
      sql`insert into agent_events (run_id, seq, at, json) values ('r2', 1, '2026-10-30T03:00:01.000Z', '{"kind":"message","text":"hi"}')`
    )
    await first.db.run(
      sql`insert into decisions (id, ticket_id, agent_run_id, kind, question, options, status, created_at)
          values ('d1', 't1', 'r2', 'question', 'Q?', '["a"]', 'pending', '2026-10-30T03:00:02.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations)
    const runs = createRunRepo(db, () => new Date())
    const [old, paused] = await runs.listForTicket('t1')
    expect(old).toMatchObject({ id: 'r1', ticketRunId: 'r1', roleId: 'r1', role: 'Builder', endReason: 'handoff' })
    expect(paused).toMatchObject({ id: 'r2', ticketRunId: 'r2', roleId: 'role-i', role: 'Implementer', sessionId: 'sess-2' })
    expect((await runs.latest('t1'))?.id).toBe('r2')

    // A role still in the lineup is copied from it; one that isn't gets the Implementer's phase and tools.
    expect(await runs.ticketRun('r2')).toMatchObject({
      ticketId: 't1',
      status: 'running',
      startedAt: '2026-10-30T03:00:00.000Z',
      endedAt: null,
      roles: [
        {
          id: 'role-i',
          workspaceId: 'w1',
          lineup: 'change',
          position: 1,
          name: 'Implementer',
          instructions: 'My own words.',
          activePhase: 'testing',
          onProblem: 'ask_me',
          handBackTo: null,
          model: 'opus',
          effort: 'high',
          toolProfile: 'edit'
        }
      ]
    })
    expect(await runs.ticketRun('r1')).toMatchObject({
      status: 'done',
      endedAt: '2026-10-30T02:00:00.000Z',
      roles: [{ id: 'r1', name: 'Builder', activePhase: 'implementing', toolProfile: 'edit', model: null }]
    })
    expect((await runs.events('r2')).map((e) => e.event)).toEqual([{ kind: 'message', text: 'hi' }])
    expect((await createDecisionRepo(db, () => new Date()).get('d1')).agentRunId).toBe('r2')
  })

  // A new column is empty for what already existed: each case is the database before the migration that added it.
  const WS = sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
  const ticketSql = (kind: string, column: string) =>
    sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, ${kind}, 'T', '[]', '', '[]', ${column}, '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
  const RUN = (status: string) =>
    sql`insert into ticket_runs (id, ticket_id, roles, status, started_at) values ('tr1', 't1', '[]', ${status}, '2026-10-30T01:00:00.000Z')`
  const AGENT_RUN = sql`insert into agent_runs (id, ticket_id, ticket_run_id, role_id, role, started_at, ended_at, end_reason)
          values ('r1', 't1', 'tr1', 'role-i', 'Implementer', '2026-10-30T01:00:00.000Z', '2026-10-30T02:00:00.000Z', 'handoff')`
  const DECISION = sql`insert into decisions (id, ticket_id, agent_run_id, kind, question, options, status, created_at)
          values ('d1', 't1', 'r1', 'question', 'Q?', '["a"]', 'pending', '2026-10-30T01:00:02.000Z')`
  const emptyColumnCases: Array<{
    column: string
    before: number
    at: Date
    seed: SQL[]
    check: (db: Awaited<ReturnType<typeof open>>['db']) => Promise<void>
  }> = [
    {
      column: 'promoted_from',
      before: 21,
      at: new Date(2026, 10, 2, 9, 0, 0),
      seed: [WS, ticketSql('investigate', 'backlog')],
      check: async (db) => {
        const [ticket] = await db.select().from(tickets)
        expect(ticket).toMatchObject({ id: 't1', kind: 'investigate', promotedFrom: null })
      }
    },
    {
      column: 'run_settings',
      before: 26,
      at: new Date(2026, 10, 6, 9, 0, 0),
      seed: [WS, ticketSql('change', 'ready')],
      check: async (db) => {
        const [ticket] = await db.select().from(tickets)
        expect(ticket).toMatchObject({ id: 't1', runSettings: null })
      }
    },
    {
      column: 'return_to_role_id and the decision action',
      before: 4,
      at: new Date(2026, 10, 1, 8, 0, 0),
      seed: [WS, ticketSql('change', 'ready'), RUN('running'), AGENT_RUN, DECISION],
      check: async (db) => {
        expect(await createRunRepo(db, () => new Date()).latest('t1')).toMatchObject({ id: 'r1', returnToRoleId: null })
        const decisions = createDecisionRepo(db, () => new Date())
        expect(await decisions.get('d1')).toMatchObject({ question: 'Q?', status: 'pending' })
        expect(await decisions.actionOf('d1')).toBeNull()
      }
    },
    {
      column: 'skipped',
      before: 5,
      at: new Date(2026, 10, 1, 9, 30, 0),
      seed: [WS, ticketSql('change', 'ready'), RUN('done'), AGENT_RUN],
      check: async (db) => {
        expect(await createRunRepo(db, () => new Date()).latest('t1')).toMatchObject({ id: 'r1', endReason: 'handoff', skipped: false })
      }
    }
  ]

  it.each(emptyColumnCases)('backs up and leaves $column empty for what already existed', async (c) => {
    const first = await open(firstMigrations(c.before))
    for (const statement of c.seed) await first.db.run(statement)
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => c.at)
    expect(backupFiles()).toHaveLength(1)
    await c.check(db)
  })

  it('backs up and makes existing answered decisions answered by the user from the thread', async () => {
    // The migrations as they were before answered_via.
    const first = await open(firstMigrations(10))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'change', 'T', '[]', '', '[]', 'ready', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into ticket_runs (id, ticket_id, roles, status, started_at) values ('tr1', 't1', '[]', 'running', '2026-10-30T01:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into agent_runs (id, ticket_id, ticket_run_id, role_id, role, started_at)
          values ('r1', 't1', 'tr1', 'role-i', 'Implementer', '2026-10-30T01:00:00.000Z')`
    )
    for (const [id, status] of [['d1', 'answered'], ['d2', 'pending'], ['d3', 'expired']]) {
      await first.db.run(
        sql`insert into decisions (id, ticket_id, agent_run_id, kind, question, options, status, created_at)
            values (${id}, 't1', 'r1', 'question', 'Q?', '["a"]', ${status}, '2026-10-30T01:00:02.000Z')`
      )
    }
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 10, 1, 8, 30, 0))
    expect(backupFiles()).toEqual(['mainbus-20261101-083000.db'])
    const decisions = createDecisionRepo(db, () => new Date())
    expect(await decisions.get('d1')).toMatchObject({ status: 'answered', answeredBy: 'user', answeredVia: 'thread' })
    expect(await decisions.get('d2')).toMatchObject({ status: 'pending', answeredBy: null, answeredVia: null })
    expect(await decisions.get('d3')).toMatchObject({ status: 'expired', answeredBy: null, answeredVia: null })
  })

  it('backs up an existing database before applying pending migrations', async () => {
    const first = await open()
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []
    expect(backupFiles()).toEqual([])

    await open(withExtraMigration(), () => new Date(2026, 9, 30, 13, 45, 7))

    expect(backupFiles()).toEqual(['mainbus-20261030-134507.db'])
  })

  it('keeps the data in the backup it takes', async () => {
    const first = await open()
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []

    await open(withExtraMigration())

    const backup = path.join(paths.backups, backupFiles()[0])
    const { DatabaseSync } = await import('node:sqlite')
    const copy = new DatabaseSync(backup, { readOnly: true })
    try {
      const row = copy.prepare('select count(*) as n from workspaces').get() as { n: number }
      expect(row.n).toBe(1)
    } finally {
      copy.close()
    }
  })

  describe('pruning old backups', () => {
    const stamp = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0')
      return `mainbus-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`
    }
    const NOW = new Date(2027, 0, 31, 12, 0, 0)
    const daysAgo = (n: number) => new Date(2027, 0, 31 - n, 12, 0, 0)

    async function existingDb() {
      const first = await open()
      first.close()
      closers = []
    }
    function seed(...ages: number[]): string[] {
      fs.mkdirSync(paths.backups, { recursive: true })
      return ages.map((n) => {
        const name = stamp(daysAgo(n))
        fs.writeFileSync(path.join(paths.backups, name), 'x')
        return name
      })
    }

    it('removes backups beyond the newest 5 that are older than 14 days, and logs each', async () => {
      await existingDb()
      // With the new one: 5 newest are the new one + 15, 16, 17, 18 days. 20 and 40 days go.
      const [a15, a16, a17, a18, a20, a40] = seed(15, 16, 17, 18, 20, 40)
      const log: string[] = []
      await openDb(paths, withExtraMigration(), () => NOW, (m) => log.push(m)).then((h) => closers.push(h.close))
      expect(backupFiles().sort()).toEqual([stamp(NOW), a15, a16, a17, a18].sort())
      expect(log).toHaveLength(2)
      expect(log.join('\n')).toContain(a20)
      expect(log.join('\n')).toContain(a40)
      expect(a40).toBeDefined()
    })

    it('keeps every backup under 14 days old, even beyond the newest 5', async () => {
      await existingDb()
      const young = seed(1, 2, 3, 4, 5, 6, 7, 13)
      const old = seed(30)
      await open(withExtraMigration(), () => NOW)
      const left = backupFiles()
      for (const n of young) expect(left).toContain(n)
      expect(left).not.toContain(old[0])
    })

    it('keeps the backup just taken even if the clock is far ahead of the others', async () => {
      await existingDb()
      seed(100, 101, 102, 103, 104, 105)
      await open(withExtraMigration(), () => NOW)
      expect(backupFiles()).toContain(stamp(NOW))
      expect(backupFiles()).toHaveLength(5)
    })

    it('leaves other files in the backups folder alone', async () => {
      await existingDb()
      seed(100, 101, 102, 103, 104, 105)
      fs.writeFileSync(path.join(paths.backups, 'notes.txt'), 'x')
      await open(withExtraMigration(), () => NOW)
      expect(fs.existsSync(path.join(paths.backups, 'notes.txt'))).toBe(true)
    })

    it('deletes nothing when the migration fails', async () => {
      await existingDb()
      const names = seed(100, 101, 102, 103, 104, 105)
      await expect(open(withExtraMigration('THIS IS NOT SQL;'), () => NOW)).rejects.toThrow()
      expect(backupFiles().sort()).toEqual([...names, stamp(NOW)].sort())
    })

    it('does not grow without limit over repeated upgrades', async () => {
      await existingDb()
      let clock = new Date(2027, 0, 1, 12, 0, 0)
      for (let i = 0; i < 12; i++) {
        // One upgrade a month: each needs a new pending migration.
        clock = new Date(clock.getFullYear(), clock.getMonth() + 1, 1, 12, 0, 0)
        const dir = withExtraMigrationAt(i)
        const h = await openDb(paths, dir, () => clock, () => {})
        h.close()
      }
      expect(backupFiles()).toHaveLength(5)
    })

    function withExtraMigrationAt(i: number): string {
      const dir = path.join(tmp, `migrations-grow-${i}`)
      fs.cpSync(realMigrations, dir, { recursive: true })
      const journalPath = path.join(dir, 'meta', '_journal.json')
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      const last = journal.entries[journal.entries.length - 1]
      for (let k = 0; k <= i; k++) {
        journal.entries.push({ idx: journal.entries.length, version: last.version, when: last.when + 1000 * (k + 1), tag: `9${k}_noop`, breakpoints: true })
        fs.writeFileSync(path.join(dir, `9${k}_noop.sql`), 'SELECT 1;')
      }
      fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
      return dir
    }
  })

  it('does not back up on a first run', async () => {
    await open()
    expect(backupFiles()).toEqual([])
  })

  it('does not back up when nothing is pending', async () => {
    const first = await open()
    first.close()
    closers = []
    await open()
    expect(backupFiles()).toEqual([])
  })

  it('enables WAL', async () => {
    const { db } = await open()
    const rows = await db.values<[string]>(sql`pragma journal_mode`)
    expect(rows[0][0]).toBe('wal')
  })

  it('round-trips rows, including booleans, through drizzle', async () => {
    const { db } = await open()
    await db.insert(workspaces).values({
      id: 'w1',
      name: 'W',
      repoPath: 'repo-path',
      baseBranch: 'main',
      slug: 'w',
      createdAt: '2026-10-30T00:00:00.000Z'
    })
    await db.insert(tickets).values({
      id: 't1',
      workspaceId: 'w1',
      number: 1,
      kind: 'change',
      title: 'First',
      intent: '[]',
      spec: '',
      labels: '[]',
      manualColumn: 'backlog',
      createdAt: '2026-10-30T00:00:00.000Z',
      updatedAt: '2026-10-30T00:00:00.000Z'
    })
    await db.insert(criteria).values({ ticketId: 't1', position: 0, text: 'works', checked: true })

    const [row] = await db.select().from(criteria)
    expect(row).toEqual({ ticketId: 't1', position: 0, text: 'works', checked: true })
    const [ticket] = await db.select().from(tickets)
    expect(ticket.branch).toBeNull()
  })

  it('rejects a second ticket with the same number in a workspace', async () => {
    const { db } = await open()
    await db.insert(workspaces).values({
      id: 'w1',
      name: 'W',
      repoPath: 'repo-path',
      baseBranch: 'main',
      slug: 'w',
      createdAt: '2026-10-30T00:00:00.000Z'
    })
    const base = {
      workspaceId: 'w1',
      number: 1,
      kind: 'change',
      title: 'T',
      intent: '[]',
      spec: '',
      labels: '[]',
      manualColumn: 'backlog',
      createdAt: '2026-10-30T00:00:00.000Z',
      updatedAt: '2026-10-30T00:00:00.000Z'
    }
    await db.insert(tickets).values({ ...base, id: 't1' })
    await expect(db.insert(tickets).values({ ...base, id: 't2' })).rejects.toThrow()
  })

  it('keeps child rows when a migration rebuilds a parent table', async () => {
    const first = await open()
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'change', 'T', '[]', '', '[]', 'backlog', 'x', 'x')`
    )
    first.close()
    closers = []

    // The pattern drizzle-kit emits when it has to rebuild a SQLite table.
    const rebuild = [
      'PRAGMA foreign_keys=OFF;',
      'CREATE TABLE `__new_workspaces` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `repo_path` text NOT NULL, `base_branch` text NOT NULL, `slug` text NOT NULL, `created_at` text NOT NULL);',
      'INSERT INTO `__new_workspaces`(`id`, `name`, `repo_path`, `base_branch`, `slug`, `created_at`) SELECT `id`, `name`, `repo_path`, `base_branch`, `slug`, `created_at` FROM `workspaces`;',
      'DROP TABLE `workspaces`;',
      'ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;',
      'PRAGMA foreign_keys=ON;'
    ].join(`${String.fromCharCode(10)}--> statement-breakpoint${String.fromCharCode(10)}`)

    const { db } = await open(withExtraMigration(rebuild))

    expect(await db.select({ n: count() }).from(tickets)).toEqual([{ n: 1 }])
    expect(await db.select({ n: count() }).from(workspaces)).toEqual([{ n: 1 }])
    const fk = await db.values<[number]>(sql`pragma foreign_keys`)
    expect(fk[0][0]).toBe(1)
  })

  it('rolls back a migration that leaves foreign key violations', async () => {
    const first = await open()
    first.close()
    closers = []

    const orphan = "INSERT INTO `criteria` (`ticket_id`, `position`, `text`, `checked`) VALUES ('missing', 0, 'x', 0);"
    await expect(open(withExtraMigration(orphan))).rejects.toThrow(/foreign key/i)

    // Nothing landed: reopening with the real migrations has nothing pending and no orphan row.
    const { db } = await open()
    expect(await db.select({ n: count() }).from(criteria)).toEqual([{ n: 0 }])
  })

  it('backs up an existing database before adding the holds table, which allows one unreleased hold per target', async () => {
    // The migrations as they were before holds.
    const first = await open(firstMigrations(11))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 10, 1, 9, 30, 0))
    expect(backupFiles()).toEqual(['mainbus-20261101-093000.db'])
    const holds = createHoldRepo(db, () => new Date(2026, 10, 1))
    await holds.place('ticket', 't1', {})
    await holds.place('decision', 'd1', {})
    await expect(
      db.run(sql`insert into holds (id, target_kind, target_id, created_by, created_at) values ('x', 'ticket', 't1', 'user', 'now')`)
    ).rejects.toThrow()
  })

  // Each case is the database as an older Mainbus left it (`before` migrations applied), holding default and edited
  // role instructions. Migrating to the current text must move the defaults and leave edited ones and other roles alone.
  // 'NEW_PLANNER' / 'NEW_IMPLEMENTER' / 'NEW_REVIEWER' stand for the current default lineup's instructions.
  const OLD_IMPLEMENTER_1 =
    'Make the change and its tests, following the plan from the previous role unless the code shows it is wrong (then say why in your handoff). Run the tests. Commit your work on the branch before handing off.'
  const OLD_REVIEWER_1 =
    "Review the branch's changes against the user's words and the acceptance criteria. Read the diff against the base branch, run the tests, and check each criterion. If something is wrong or missing, report it as a problem with specific findings (file, line, what's wrong) so the Implementer can fix it. Don't change any files. When it's right, hand off with a short review summary."
  const OLD_REVIEWER_2 =
    "Review the branch's changes against the user's words and the acceptance criteria. Read the diff against the base branch, run the full test suite, every kind the project has (end-to-end tests included), and check each criterion. If something is wrong or missing, report it as a problem with specific findings (file, line, what's wrong) so the Implementer can fix it. Don't change any files. When it's right, hand off with a short review summary."
  const OLD_IMPLEMENTER_3 =
    "Make the change and its tests, following the plan from the previous role unless the code shows it is wrong (then say why in your handoff). While you work, run only the tests that cover the code you changed. Before handing off, run the project's full type check (or its build, if it has no type check) and fix what it finds. Commit your work on the branch before handing off. In notes_for_next, say which tests you ran. Don't tick a criterion about the full test suite: the Reviewer runs it."
  const OLD_REVIEWER_3 =
    "Review the branch's changes against the user's words and the acceptance criteria. Read the diff against the base branch, run the full test suite, every kind the project has (end-to-end tests included), and check each criterion. You may skip the tests only when the branch changes no code: every changed file is documentation or other text that nothing in the build, the tests or the app reads (check that no code or test refers to it). Then say in your handoff that you skipped them and why, and check the documentation itself instead: that its links and the commands and paths it names exist. If an acceptance criterion requires the tests to pass, run them anyway; never tick a criterion about tests you didn't run. If something is wrong or missing, report it as a problem with specific findings (file, line, what's wrong) so the Implementer can fix it. Don't change any files. When it's right, hand off with a short review summary."
  const OLD_IMPLEMENTER_4 =
    "Make the change and its tests, following the plan from the previous role unless the code shows it is wrong (then say why in your handoff). While you work, run only the tests that cover the code you changed. Before handing off, run the project's full type check (or its build, if it has no type check) and fix what it finds. If a test fails and Mainbus lists known failures on the base branch, compare it with them before blaming your change. Commit your work on the branch before handing off. In notes_for_next, say which tests you ran and which known failures you saw. Don't tick a criterion about the full test suite: the Reviewer runs it."
  type InstructionRow = readonly [workspace: string, role: string, position: number, name: string, instructions: string]
  const instructionCases: Array<{
    name: string
    before: number
    phase: string
    toolProfile: string
    rows: InstructionRow[]
    expected: Record<string, string>
  }> = [
    {
      name: 'default Implementer and Reviewer instructions',
      before: 12,
      phase: 'testing',
      toolProfile: 'edit',
      rows: [
        ['w1', 'planner', 1, 'Planner', 'Plan it.'],
        ['w1', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER_1],
        ['w1', 'reviewer', 3, 'Reviewer', OLD_REVIEWER_1],
        ['w2', 'planner', 1, 'Planner', 'Plan it.'],
        ['w2', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER_1 + ' My own addition.'],
        ['w2', 'reviewer', 3, 'Reviewer', OLD_REVIEWER_1]
      ],
      expected: {
        w1planner: 'Plan it.',
        w1implementer: 'NEW_IMPLEMENTER',
        w1reviewer: 'NEW_REVIEWER',
        w2planner: 'Plan it.',
        w2implementer: OLD_IMPLEMENTER_1 + ' My own addition.',
        w2reviewer: 'NEW_REVIEWER'
      }
    },
    {
      name: 'default Reviewer instructions (the skip-tests text)',
      before: 33,
      phase: 'reviewing',
      toolProfile: 'read_only',
      rows: [
        ['w1', 'planner', 1, 'Planner', 'Plan it.'],
        ['w1', 'implementer', 2, 'Implementer', 'NEW_IMPLEMENTER'],
        ['w1', 'reviewer', 3, 'Reviewer', OLD_REVIEWER_2],
        ['w2', 'reviewer', 3, 'Reviewer', OLD_REVIEWER_2 + ' Mine.']
      ],
      expected: {
        w1reviewer: 'NEW_REVIEWER',
        w2reviewer: OLD_REVIEWER_2 + ' Mine.',
        w1planner: 'Plan it.',
        w1implementer: 'NEW_IMPLEMENTER'
      }
    },
    {
      name: 'default Implementer and Reviewer instructions (the known-failures text)',
      before: 34,
      phase: 'reviewing',
      toolProfile: 'read_only',
      rows: [
        ['w1', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER_3],
        ['w1', 'reviewer', 3, 'Reviewer', OLD_REVIEWER_3],
        ['w2', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER_3 + ' Mine.'],
        ['w2', 'reviewer', 3, 'Reviewer', OLD_REVIEWER_3 + ' Mine.']
      ],
      expected: {
        w1implementer: 'NEW_IMPLEMENTER',
        w1reviewer: 'NEW_REVIEWER',
        w2implementer: OLD_IMPLEMENTER_3 + ' Mine.',
        w2reviewer: OLD_REVIEWER_3 + ' Mine.'
      }
    },
    {
      name: 'default Implementer instructions (the related-tests text)',
      before: 35,
      phase: 'implementing',
      toolProfile: 'edit',
      rows: [
        ['w1', 'planner', 1, 'Planner', 'NEW_PLANNER'],
        ['w1', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER_4],
        ['w1', 'reviewer', 3, 'Reviewer', 'NEW_REVIEWER'],
        ['w2', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER_4 + ' Mine.'],
        ['w2', 'reviewer', 3, 'Reviewer', "Review the branch's changes. Don't change any files."]
      ],
      expected: {
        w1implementer: 'NEW_IMPLEMENTER',
        w2implementer: OLD_IMPLEMENTER_4 + ' Mine.',
        w1planner: 'NEW_PLANNER',
        w1reviewer: 'NEW_REVIEWER',
        w2reviewer: "Review the branch's changes. Don't change any files."
      }
    }
  ]

  it.each(instructionCases)('moves the $name to the current text, and leaves edited ones and other roles alone', async (c) => {
    const [planner, implementer, reviewer] = defaultLineup()
    const current: Record<string, string> = {
      NEW_PLANNER: planner!.instructions,
      NEW_IMPLEMENTER: implementer!.instructions,
      NEW_REVIEWER: reviewer!.instructions
    }
    const resolve = (text: string): string => current[text] ?? text
    // Guard: a row that is moved must start from text that differs from what it moves to, or the case tests nothing.
    for (const [w, role, , , instructions] of c.rows) {
      const target = c.expected[w + role]
      if (target?.startsWith('NEW_') && !instructions.startsWith('NEW_')) expect(resolve(instructions), w + role).not.toBe(resolve(target))
    }
    const first = await open(firstMigrations(c.before))
    for (const id of ['w1', 'w2']) {
      await first.db.run(
        sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
            values (${id}, 'W', 'repo-path', 'main', ${id}, '2026-10-30T00:00:00.000Z')`
      )
    }
    for (const [w, id, position, name, instructions] of c.rows) {
      await first.db.run(
        sql`insert into lineup_roles (id, workspace_id, lineup, position, name, instructions, active_phase, on_problem, tool_profile)
            values (${w + id}, ${w}, 'change', ${position}, ${name}, ${resolve(instructions)}, ${c.phase}, 'ask_me', ${c.toolProfile})`
      )
    }
    first.close()
    closers = []

    const { db } = await open()
    expect(backupFiles()).toHaveLength(1)
    for (const [id, instructions] of Object.entries(c.expected)) {
      const [row] = await db.select().from(lineupRoles).where(sql`${lineupRoles.id} = ${id}`)
      expect(row!.instructions, id).toBe(resolve(instructions))
    }
  })

  it('adds the test commands (empty) and the base test runs table when moving to the known-failures text', async () => {
    const first = await open(firstMigrations(34))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w1', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open()
    const [ws] = await db.select().from(workspaces).where(sql`${workspaces.id} = 'w1'`)
    expect(ws!.testCommands).toBe('[]')
    await expect(db.run(sql`select count(*) from base_test_runs`)).resolves.toBeDefined()
  })

  it('moves the app-wide unattended setting onto the workspace, backs up first, and keeps slugs unique', async () => {
    const first = await open(firstMigrations(22))
    await first.db.run(sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at) values ('w1', 'app', '/a', 'main', 'app', 'x')`)
    await first.db.run(sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at) values ('w2', 'app', '/b', 'main', 'app', 'y')`)
    await first.db.run(sql`insert into app_settings (key, value) values ('unattended', 'on')`)
    first.close()
    closers = []

    const { db } = await open()
    expect(backupFiles()).toHaveLength(1)
    const rows = await db.select().from(workspaces)
    expect(rows.map((r) => [r.id, r.unattendedOn, r.removedAt])).toEqual([
      ['w1', true, null],
      ['w2', true, null]
    ])
    expect(new Set(rows.map((r) => r.slug)).size).toBe(2)
    expect(await db.run(sql`select 1 from app_settings where key = 'unattended'`).then((r) => r.rows ?? [])).toHaveLength(0)
  })

  it('enforces foreign keys', async () => {
    const { db } = await open()
    await expect(
      db.run(
        sql`insert into criteria (ticket_id, position, text, checked) values ('missing', 0, 'x', 0)`
      )
    ).rejects.toThrow()
  })

  it('migration 0041 backfills done_at from updated_at for Done tickets only, and adds archived_at and its index', async () => {
    const first = await open(firstMigrations(41))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w1', '2026-10-30T00:00:00.000Z')`
    )
    for (const [id, n, column, updated] of [
      ['done1', 1, 'done', '2026-11-02T00:00:00.000Z'],
      ['ready1', 2, 'ready', '2026-11-03T00:00:00.000Z']
    ] as const) {
      await first.db.run(
        sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
            values (${id}, 'w1', ${n}, 'change', 'T', '[]', '', '[]', ${column}, '2026-10-30T00:00:00.000Z', ${updated})`
      )
    }
    first.close()
    closers = []

    const { db } = await open()
    const rows = await db.select().from(tickets)
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.done1).toMatchObject({ doneAt: '2026-11-02T00:00:00.000Z', archivedAt: null })
    expect(byId.ready1).toMatchObject({ doneAt: null, archivedAt: null })
    const idx = await db.all(sql`select name from sqlite_master where type = 'index' and name = 'tickets_workspace_archived_idx'`)
    expect(idx).toHaveLength(1)
  })

  it('migrations 0044 and 0045 index agent_runs.ticket_run_id and tickets.promoted_from, and the lookups use them', async () => {
    const { db } = await open()
    const idx = await db.all(sql`select name from sqlite_master where type = 'index' and name = 'agent_runs_ticket_run_idx'`)
    expect(idx).toHaveLength(1)
    const plan = await db.all<unknown[]>(
      sql`explain query plan select * from agent_runs where ticket_run_id = 'x' order by started_at, rowid`
    )
    expect(JSON.stringify(plan)).toContain('USING INDEX agent_runs_ticket_run_idx')
    const promoted = await db.all<unknown[]>(sql`explain query plan select id from tickets where promoted_from is not null`)
    expect(JSON.stringify(promoted)).toContain('USING INDEX tickets_promoted_from_idx')
    const live = await db.all<unknown[]>(
      sql`explain query plan select * from tickets where workspace_id = 'w' and archived_at is null order by number + 0`
    )
    expect(JSON.stringify(live)).toContain('USING INDEX tickets_workspace_archived_idx')
  })
})

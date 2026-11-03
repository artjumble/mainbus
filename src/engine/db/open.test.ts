import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { count, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveHome, type HomePaths } from '../home'
import { openDb } from './open'
import { createDecisionRepo } from '../store/decisions'
import { createLineupRepo, defaultInvestigateLineup, defaultLineup } from '../store/lineups'
import { createRunRepo } from '../store/runs'
import { createHoldRepo } from '../store/holds'
import { criteria, lineupRoles, tickets, workspaces } from './schema'

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

  it('adds the promoted_from column, empty for every existing ticket, after a backup', async () => {
    // The migrations as they were before Promote.
    const first = await open(firstMigrations(21))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'investigate', 'T', '[]', '', '[]', 'backlog', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 10, 2, 9, 0, 0))
    expect(backupFiles()).toHaveLength(1)
    const [ticket] = await db.select().from(tickets)
    expect(ticket).toMatchObject({ id: 't1', kind: 'investigate', promotedFrom: null })
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

  it('backs up and gives existing runs no return role and existing decisions no action', async () => {
    // The migrations as they were before hand-backs.
    const first = await open(firstMigrations(4))
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
    await first.db.run(
      sql`insert into decisions (id, ticket_id, agent_run_id, kind, question, options, status, created_at)
          values ('d1', 't1', 'r1', 'question', 'Q?', '["a"]', 'pending', '2026-10-30T01:00:02.000Z')`
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 10, 1, 8, 0, 0))
    expect(backupFiles()).toEqual(['mainbus-20261101-080000.db'])
    expect(await createRunRepo(db, () => new Date()).latest('t1')).toMatchObject({ id: 'r1', returnToRoleId: null })
    const decisions = createDecisionRepo(db, () => new Date())
    expect(await decisions.get('d1')).toMatchObject({ question: 'Q?', status: 'pending' })
    expect(await decisions.actionOf('d1')).toBeNull()
  })

  it('backs up and marks existing runs as not skipped', async () => {
    // The migrations as they were before Skip to next role.
    const first = await open(firstMigrations(5))
    await first.db.run(
      sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
          values ('w1', 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into tickets (id, workspace_id, number, kind, title, intent, spec, labels, manual_column, created_at, updated_at)
          values ('t1', 'w1', 1, 'change', 'T', '[]', '', '[]', 'ready', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into ticket_runs (id, ticket_id, roles, status, started_at) values ('tr1', 't1', '[]', 'done', '2026-10-30T01:00:00.000Z')`
    )
    await first.db.run(
      sql`insert into agent_runs (id, ticket_id, ticket_run_id, role_id, role, started_at, ended_at, end_reason)
          values ('r1', 't1', 'tr1', 'role-i', 'Implementer', '2026-10-30T01:00:00.000Z', '2026-10-30T02:00:00.000Z', 'handoff')`
    )
    first.close()
    closers = []

    const { db } = await open(realMigrations, () => new Date(2026, 10, 1, 9, 30, 0))
    expect(backupFiles()).toEqual(['mainbus-20261101-093000.db'])
    expect(await createRunRepo(db, () => new Date()).latest('t1')).toMatchObject({ id: 'r1', endReason: 'handoff', skipped: false })
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

  it('updates default Implementer and Reviewer instructions, and leaves edited ones alone', async () => {
    const OLD_IMPLEMENTER =
      'Make the change and its tests, following the plan from the previous role unless the code shows it is wrong (then say why in your handoff). Run the tests. Commit your work on the branch before handing off.'
    const OLD_REVIEWER =
      "Review the branch's changes against the user's words and the acceptance criteria. Read the diff against the base branch, run the tests, and check each criterion. If something is wrong or missing, report it as a problem with specific findings (file, line, what's wrong) so the Implementer can fix it. Don't change any files. When it's right, hand off with a short review summary."
    // The migrations as they were before the new instructions.
    const first = await open(firstMigrations(12))
    for (const id of ['w1', 'w2']) {
      await first.db.run(
        sql`insert into workspaces (id, name, repo_path, base_branch, slug, created_at)
            values (${id}, 'W', 'repo-path', 'main', 'w', '2026-10-30T00:00:00.000Z')`
      )
    }
    const rows = [
      ['w1', 'planner', 1, 'Planner', 'Plan it.'],
      ['w1', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER],
      ['w1', 'reviewer', 3, 'Reviewer', OLD_REVIEWER],
      ['w2', 'planner', 1, 'Planner', 'Plan it.'],
      ['w2', 'implementer', 2, 'Implementer', OLD_IMPLEMENTER + ' My own addition.'],
      ['w2', 'reviewer', 3, 'Reviewer', OLD_REVIEWER]
    ] as const
    for (const [w, id, position, name, instructions] of rows) {
      await first.db.run(
        sql`insert into lineup_roles (id, workspace_id, lineup, position, name, instructions, active_phase, on_problem, tool_profile)
            values (${w + id}, ${w}, 'change', ${position}, ${name}, ${instructions}, 'testing', 'ask_me', 'edit')`
      )
    }
    first.close()
    closers = []

    const { db } = await open()
    const [, newImplementer, newReviewer] = defaultLineup()
    const byId = async (id: string) =>
      (await db.select().from(lineupRoles).where(sql`${lineupRoles.id} = ${id}`))[0]!.instructions
    expect(await byId('w1planner')).toBe('Plan it.')
    expect(await byId('w1implementer')).toBe(newImplementer!.instructions)
    expect(await byId('w1reviewer')).toBe(newReviewer!.instructions)
    expect(await byId('w2planner')).toBe('Plan it.')
    expect(await byId('w2implementer')).toBe(OLD_IMPLEMENTER + ' My own addition.')
    expect(await byId('w2reviewer')).toBe(newReviewer!.instructions)
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
})

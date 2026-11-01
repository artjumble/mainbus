import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { count, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveHome, type HomePaths } from '../home'
import { openDb } from './open'
import { criteria, tickets, workspaces } from './schema'

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
    const dir = path.join(tmp, 'migrations-first')
    fs.cpSync(realMigrations, dir, { recursive: true })
    const journalPath = path.join(dir, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.slice(0, 1)
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))

    const first = await open(dir)
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

  it('enforces foreign keys', async () => {
    const { db } = await open()
    await expect(
      db.run(
        sql`insert into criteria (ticket_id, position, text, checked) values ('missing', 0, 'x', 0)`
      )
    ).rejects.toThrow()
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator'
import type { HomePaths } from '../home'

export type Db = SqliteRemoteDatabase

export interface DbHandle {
  db: Db
  /** Closes the underlying file. Windows can't delete the folder while it is open. */
  close(): void
}

const MIGRATIONS_TABLE = '__drizzle_migrations'

/** After a successful migration, backups are kept if they are among the newest this many... */
export const BACKUPS_TO_KEEP = 5
/** ...or younger than this many days. All others are deleted. */
export const BACKUP_MIN_AGE_DAYS = 14

/**
 * Opens (creating if needed) the Mainbus database, backs it up if migrations are pending, and migrates.
 * The sqlite-proxy adapter is async, so every query through `db` returns a promise.
 */
export async function openDb(
  paths: HomePaths,
  migrationsDir: string,
  now: () => Date = () => new Date(),
  log: (message: string) => void = (m) => console.info(m)
): Promise<DbHandle> {
  fs.mkdirSync(paths.root, { recursive: true })
  const existed = fs.existsSync(paths.db)

  const sqlite = new DatabaseSync(paths.db)
  try {
    sqlite.exec('PRAGMA journal_mode = WAL')
    sqlite.exec('PRAGMA foreign_keys = ON')

    let takenBackup: string | null = null
    if (existed && countPending(sqlite, migrationsDir) > 0) {
      takenBackup = backUp(sqlite, paths.backups, now())
    }

    const db = drizzle(
      (query, params, method) => Promise.resolve(run(sqlite, query, params, method)),
      (queries) => Promise.resolve(runBatch(sqlite, queries))
    )
    await migrate(
      db,
      async (queries) => {
        // drizzle-kit rebuilds a table with DROP TABLE + RENAME and relies on foreign keys being off,
        // but PRAGMA foreign_keys is a no-op inside a transaction. Without this, the DROP would fire
        // the ON DELETE CASCADEs and silently delete child rows.
        sqlite.exec('PRAGMA foreign_keys = OFF')
        try {
          sqlite.exec('BEGIN')
          try {
            for (const query of queries) sqlite.exec(query)
            // Checked before COMMIT so a bad migration rolls back instead of landing.
            const violations = sqlite.prepare('PRAGMA foreign_key_check').all()
            if (violations.length > 0) {
              throw new Error(`Migration left ${violations.length} foreign key violation(s)`)
            }
            sqlite.exec('COMMIT')
          } catch (error) {
            sqlite.exec('ROLLBACK')
            throw error
          }
        } finally {
          sqlite.exec('PRAGMA foreign_keys = ON')
        }
      },
      { migrationsFolder: migrationsDir }
    )

    // Only after the migration succeeded: a failed one (thrown above) keeps every backup.
    if (takenBackup) pruneBackups(paths.backups, takenBackup, now(), log)

    return { db, close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

function run(
  sqlite: DatabaseSync,
  query: string,
  params: unknown[],
  method: 'run' | 'all' | 'values' | 'get'
): { rows: any[] } {
  const stmt = sqlite.prepare(query)
  const args = params as SQLInputValue[]
  if (method === 'run') {
    stmt.run(...args)
    return { rows: [] }
  }
  // sqlite-proxy wants each row as an array of column values, not an object.
  stmt.setReturnArrays(true)
  if (method === 'get') {
    return { rows: stmt.get(...args) as unknown as any[] }
  }
  return { rows: stmt.all(...args) as unknown as any[][] }
}

/**
 * `db.batch()`: all the queries or none. They run synchronously, so no other query can run in the middle of
 * them, as one can between the awaits of `db.transaction()` on this single connection. A savepoint rather than
 * BEGIN, so a batch inside a transaction that is already open still works.
 */
function runBatch(
  sqlite: DatabaseSync,
  queries: { sql: string; params: unknown[]; method: 'run' | 'all' | 'values' | 'get' }[]
): { rows: any[] }[] {
  sqlite.exec('SAVEPOINT batch')
  try {
    const results = queries.map((q) => run(sqlite, q.sql, q.params, q.method))
    sqlite.exec('RELEASE batch')
    return results
  } catch (error) {
    sqlite.exec('ROLLBACK TO batch')
    sqlite.exec('RELEASE batch')
    throw error
  }
}

/** Migrations in the journal that the database hasn't applied yet. */
function countPending(sqlite: DatabaseSync, migrationsDir: string): number {
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: unknown[] }
  const hasTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE)
  const applied = hasTable
    ? (sqlite.prepare(`SELECT count(*) AS n FROM "${MIGRATIONS_TABLE}"`).get() as { n: number }).n
    : 0
  return journal.entries.length - applied
}

/** VACUUM INTO, not a file copy: a copy can miss data that is still in the WAL file. */
function backUp(sqlite: DatabaseSync, backupsDir: string, at: Date): string {
  fs.mkdirSync(backupsDir, { recursive: true })
  const name = `mainbus-${formatStamp(at)}.db`
  sqlite.prepare('VACUUM INTO ?').run(path.join(backupsDir, name))
  return name
}

/**
 * Deletes old backups, keeping the newest BACKUPS_TO_KEEP and any younger than BACKUP_MIN_AGE_DAYS.
 * Age comes from the stamp in the file name (local time). Never removes `justTaken`; ignores other files.
 * A file that can't be deleted is logged and skipped: pruning never fails the start-up.
 */
export function pruneBackups(
  backupsDir: string,
  justTaken: string,
  now: Date,
  log: (message: string) => void
): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(backupsDir)
  } catch {
    return []
  }
  const found = names
    .map((name) => ({ name, at: parseStamp(name) }))
    .filter((f): f is { name: string; at: Date } => f.at !== null && f.name !== justTaken)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.name < b.name ? 1 : -1))
  const cutoff = now.getTime() - BACKUP_MIN_AGE_DAYS * 24 * 60 * 60 * 1000
  // The backup just taken counts as one of the newest.
  const removed: string[] = []
  for (const [i, f] of found.entries()) {
    if (i + 1 < BACKUPS_TO_KEEP || f.at.getTime() >= cutoff) continue
    try {
      fs.rmSync(path.join(backupsDir, f.name))
      removed.push(f.name)
      log(`Mainbus removed the old database backup ${f.name}`)
    } catch (error) {
      log(`Mainbus could not remove the old database backup ${f.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return removed
}

function parseStamp(name: string): Date | null {
  const m = /^mainbus-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  return new Date(y, mo - 1, d, h, mi, s)
}

function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

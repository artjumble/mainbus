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

/**
 * Opens (creating if needed) the Mainbus database, backs it up if migrations are pending, and migrates.
 * The sqlite-proxy adapter is async, so every query through `db` returns a promise.
 */
export async function openDb(
  paths: HomePaths,
  migrationsDir: string,
  now: () => Date = () => new Date()
): Promise<DbHandle> {
  fs.mkdirSync(paths.root, { recursive: true })
  const existed = fs.existsSync(paths.db)

  const sqlite = new DatabaseSync(paths.db)
  try {
    sqlite.exec('PRAGMA journal_mode = WAL')
    sqlite.exec('PRAGMA foreign_keys = ON')

    if (existed && countPending(sqlite, migrationsDir) > 0) {
      backUp(sqlite, paths.backups, now())
    }

    const db = drizzle((query, params, method) => Promise.resolve(run(sqlite, query, params, method)))
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
function backUp(sqlite: DatabaseSync, backupsDir: string, at: Date): void {
  fs.mkdirSync(backupsDir, { recursive: true })
  const target = path.join(backupsDir, `mainbus-${formatStamp(at)}.db`)
  sqlite.prepare('VACUUM INTO ?').run(target)
}

function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

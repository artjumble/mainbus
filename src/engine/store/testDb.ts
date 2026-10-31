import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveHome } from '../home'
import { openDb, type Db } from '../db/open'

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')

export const FIXED_NOW = new Date('2026-10-30T12:00:00.000Z')

/** Opens a migrated database in a temp home. Call `cleanup` in teardown: Windows can't delete an open DB file. */
export async function openTestDb(): Promise<{ db: Db; cleanup: () => void }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-store-'))
  const paths = resolveHome({ MAINBUS_HOME: tmp }, 'dev', os.homedir())
  const handle = await openDb(paths, migrationsDir)
  return {
    db: handle.db,
    cleanup: () => {
      handle.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

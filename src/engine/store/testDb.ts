import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LineupRole } from '../../shared/domain'
import { resolveHome } from '../home'
import { openDb, type Db } from '../db/open'
import type { LineupRepo } from './lineups'

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

/** A lineup role for runs in tests; `overrides` replaces any field. */
export function testRole(overrides: Partial<LineupRole> = {}): LineupRole {
  return {
    id: 'implementer',
    workspaceId: 'ws',
    lineup: 'change',
    position: 1,
    name: 'Implementer',
    instructions: 'Make the change.',
    activePhase: 'implementing',
    onProblem: 'ask_me',
    handBackTo: null,
    model: null,
    effort: null,
    toolProfile: 'edit',
    ...overrides
  }
}

/**
 * Cuts the workspace's lineup down to its Implementer, for tests of what a single role does.
 * Returns the saved lineup (the one role).
 */
export function implementerOnly(lineups: LineupRepo, workspaceId: string): Promise<LineupRole[]> {
  return lineups.get(workspaceId).then((lineup) => {
    const implementer = lineup.find((r) => r.name === 'Implementer')
    if (!implementer) throw new Error('No Implementer in the lineup')
    const { workspaceId: _w, lineup: _l, position: _p, ...input } = implementer
    return lineups.save(workspaceId, [{ ...input, handBackTo: null }])
  })
}

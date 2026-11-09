import { randomUUID } from 'node:crypto'
import { desc, eq, notInArray, and } from 'drizzle-orm'
import type { BaseTestCommandResult } from '../../shared/domain'
import type { Db } from '../db/open'
import { baseTestRuns } from '../db/schema'

/** How many runs of a workspace are kept. */
export const BASE_TEST_RUNS_KEPT = 10

export interface BaseTestRun {
  id: string
  workspaceId: string
  baseRef: string
  baseSha: string
  trigger: 'base_moved' | 'manual'
  startedAt: string
  endedAt: string
  /** Why the commands could not be run; null when they ran. */
  error: string | null
  results: BaseTestCommandResult[]
}

export interface BaseTestRepo {
  /** Records a run, then drops all but the newest BASE_TEST_RUNS_KEPT of the workspace. */
  add(run: Omit<BaseTestRun, 'id'>): Promise<BaseTestRun>
  /** The workspace's runs, newest first. */
  list(workspaceId: string): Promise<BaseTestRun[]>
  latest(workspaceId: string): Promise<BaseTestRun | null>
}

function toRun(row: typeof baseTestRuns.$inferSelect): BaseTestRun {
  let results: BaseTestCommandResult[] = []
  try {
    const parsed: unknown = JSON.parse(row.results)
    if (Array.isArray(parsed)) results = parsed as BaseTestCommandResult[]
  } catch {
    // An unreadable row counts as a run without results.
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    trigger: row.trigger,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    error: row.error,
    results
  }
}

export function createBaseTestRepo(db: Db): BaseTestRepo {
  async function list(workspaceId: string): Promise<BaseTestRun[]> {
    const rows = await db
      .select()
      .from(baseTestRuns)
      .where(eq(baseTestRuns.workspaceId, workspaceId))
      .orderBy(desc(baseTestRuns.startedAt), desc(baseTestRuns.endedAt))
    return rows.map(toRun)
  }

  return {
    async add(run) {
      const id = randomUUID()
      await db.insert(baseTestRuns).values({ ...run, id, results: JSON.stringify(run.results) })
      const keep = (await list(run.workspaceId)).slice(0, BASE_TEST_RUNS_KEPT).map((r) => r.id)
      await db.delete(baseTestRuns).where(and(eq(baseTestRuns.workspaceId, run.workspaceId), notInArray(baseTestRuns.id, keep)))
      return { ...run, id }
    },
    list,
    async latest(workspaceId) {
      return (await list(workspaceId))[0] ?? null
    }
  }
}

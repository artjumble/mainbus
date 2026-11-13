import { randomUUID } from 'node:crypto'
import { asc, eq, isNull, sql } from 'drizzle-orm'
import {
  checkReportsFolder,
  checkSetupCommand,
  checkSetupTimeout,
  checkTestCommands,
  REPORTS_FOLDER_DEFAULT,
  SETUP_TIMEOUT_DEFAULT,
  type ReportSettingsInput,
  type SetupSettingsInput,
  type TestCommand,
  type Workspace
} from '../../shared/domain'
import { MERGE_METHODS, type MergeMethod } from '../../shared/merge'
import type { Db } from '../db/open'
import { appSettings, workspaces } from '../db/schema'
import { slugify } from '../git/slug'
import { insertDefaultLineup } from './lineups'
import { insertDefaultPresets } from './presets'

const FOCUSED = 'focused_workspace'

export interface WorkspaceRepo {
  /**
   * Creates the workspace with its default lineup and presets. `name` is basename(repoPath); the slug starts from slugify(name) (or
   * `slug`) and gets a numeric suffix when another workspace, removed ones included, already uses it.
   */
  create(repoPath: string, baseBranch: string, name: string, slug?: string): Promise<Workspace>
  /** Every workspace that has not been removed, oldest first. */
  list(): Promise<Workspace[]>
  /** The workspace with this id; null when it is unknown or has been removed. */
  get(id: string): Promise<Workspace | null>
  /** Every workspace row, removed ones included, so a removed repo can be reopened. */
  listAll(): Promise<Array<Workspace & { removed: boolean }>>
  /** The remembered focused workspace; falls back to the oldest live one, and null when there is none. */
  focused(): Promise<Workspace | null>
  setFocused(id: string): Promise<void>
  /** Soft-removes the workspace: its row, tickets and history stay. */
  markRemoved(id: string): Promise<void>
  restore(id: string): Promise<void>
  setOpenPrOnReview(id: string, on: boolean): Promise<Workspace>
  setMergeMethod(id: string, method: MergeMethod): Promise<Workspace>
  /** Saves the base branch; the caller has checked that it exists. */
  setBaseBranch(id: string, branch: string): Promise<Workspace>
  /** Saves the settings given; a reports folder that leaves the repo is refused with the reason, and nothing is saved. */
  setReportSettings(id: string, settings: ReportSettingsInput): Promise<Workspace>
  /** Saves the setup settings given; a command or timeout that is refused throws with the reason, and nothing is saved. */
  setSetupSettings(id: string, settings: SetupSettingsInput): Promise<Workspace>
  /** Saves the list of test commands (empty turns the base-branch tests off); a list that is refused throws with the reason, and nothing is saved. */
  setTestCommands(id: string, commands: TestCommand[]): Promise<Workspace>
  /** Whether unattended mode was on for this workspace when the app last ran. */
  unattendedOn(id: string): Promise<boolean>
  setUnattendedOn(id: string, on: boolean): Promise<void>
}

function toMergeMethod(value: string): MergeMethod {
  return (MERGE_METHODS as string[]).includes(value) ? (value as MergeMethod) : 'merge'
}

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repoPath,
    baseBranch: row.baseBranch,
    slug: row.slug,
    openPrOnReview: row.openPrOnReview,
    mergeMethod: toMergeMethod(row.mergeMethod),
    saveReports: row.saveReports,
    reportsFolder: row.reportsFolder,
    setupCommand: row.setupCommand,
    setupTimeoutMinutes: row.setupTimeoutMinutes,
    testCommands: parseTestCommands(row.testCommands)
  }
}

function parseTestCommands(json: string): TestCommand[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as TestCommand[]) : []
  } catch {
    return []
  }
}

export function createWorkspaceRepo(db: Db, now: () => Date): WorkspaceRepo {
  const oldestFirst = [asc(workspaces.createdAt), asc(sql`rowid`)] as const

  async function get(id: string): Promise<Workspace | null> {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    return row && row.removedAt === null ? toWorkspace(row) : null
  }

  async function list(): Promise<Workspace[]> {
    const rows = await db
      .select()
      .from(workspaces)
      .where(isNull(workspaces.removedAt))
      .orderBy(...oldestFirst)
    return rows.map(toWorkspace)
  }

  return {
    async create(repoPath, baseBranch, name, slug) {
      const taken = new Set((await db.select({ slug: workspaces.slug }).from(workspaces)).map((r) => r.slug))
      const base = slug ?? slugify(name)
      let unique = base
      for (let n = 2; taken.has(unique); n++) unique = `${base}-${n}`
      const workspace: Workspace = {
        id: randomUUID(),
        name,
        repoPath,
        baseBranch,
        slug: unique,
        openPrOnReview: false,
        mergeMethod: 'merge',
        saveReports: true,
        reportsFolder: REPORTS_FOLDER_DEFAULT,
        setupCommand: '',
        setupTimeoutMinutes: SETUP_TIMEOUT_DEFAULT,
        testCommands: []
      }
      await db.insert(workspaces).values({ ...workspace, testCommands: '[]', createdAt: now().toISOString() })
      await insertDefaultLineup(db, workspace.id)
      await insertDefaultPresets(db, workspace.id, now)
      return workspace
    },

    list,
    get,

    async listAll() {
      const rows = await db.select().from(workspaces).orderBy(...oldestFirst)
      return rows.map((r) => ({ ...toWorkspace(r), removed: r.removedAt !== null }))
    },

    async focused() {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, FOCUSED))
      if (row) {
        const found = await get(row.value)
        if (found) return found
      }
      return (await list())[0] ?? null
    },

    async setFocused(id) {
      await db
        .insert(appSettings)
        .values({ key: FOCUSED, value: id })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: id } })
    },

    async markRemoved(id) {
      await db.update(workspaces).set({ removedAt: now().toISOString() }).where(eq(workspaces.id, id))
    },

    async restore(id) {
      await db.update(workspaces).set({ removedAt: null }).where(eq(workspaces.id, id))
    },

    async setOpenPrOnReview(id, on) {
      await db.update(workspaces).set({ openPrOnReview: on }).where(eq(workspaces.id, id))
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new Error(`Workspace not found: ${id}`)
      return toWorkspace(row)
    },

    async setBaseBranch(id, branch) {
      await db.update(workspaces).set({ baseBranch: branch }).where(eq(workspaces.id, id))
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new Error(`Workspace not found: ${id}`)
      return toWorkspace(row)
    },

    async setMergeMethod(id, method) {
      await db.update(workspaces).set({ mergeMethod: method }).where(eq(workspaces.id, id))
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new Error(`Workspace not found: ${id}`)
      return toWorkspace(row)
    },

    async setReportSettings(id, settings) {
      const set: Partial<typeof workspaces.$inferInsert> = {}
      if (settings.saveReports !== undefined) set.saveReports = settings.saveReports
      if (settings.reportsFolder !== undefined) {
        const checked = checkReportsFolder(settings.reportsFolder)
        if (!checked.ok) throw new Error(checked.reason)
        set.reportsFolder = checked.folder
      }
      if (Object.keys(set).length > 0) await db.update(workspaces).set(set).where(eq(workspaces.id, id))
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new Error(`Workspace not found: ${id}`)
      return toWorkspace(row)
    },

    async setSetupSettings(id, settings) {
      const set: Partial<typeof workspaces.$inferInsert> = {}
      if (settings.command !== undefined) {
        const checked = checkSetupCommand(settings.command)
        if (!checked.ok) throw new Error(checked.reason)
        set.setupCommand = checked.command
      }
      if (settings.timeoutMinutes !== undefined) {
        const checked = checkSetupTimeout(settings.timeoutMinutes)
        if (!checked.ok) throw new Error(checked.reason)
        set.setupTimeoutMinutes = checked.minutes
      }
      if (Object.keys(set).length > 0) await db.update(workspaces).set(set).where(eq(workspaces.id, id))
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new Error(`Workspace not found: ${id}`)
      return toWorkspace(row)
    },

    async setTestCommands(id, commands) {
      const checked = checkTestCommands(commands)
      if (!checked.ok) throw new Error(checked.reason)
      await db.update(workspaces).set({ testCommands: JSON.stringify(checked.commands) }).where(eq(workspaces.id, id))
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new Error(`Workspace not found: ${id}`)
      return toWorkspace(row)
    },

    async unattendedOn(id) {
      const [row] = await db.select({ on: workspaces.unattendedOn }).from(workspaces).where(eq(workspaces.id, id))
      return row?.on ?? false
    },

    async setUnattendedOn(id, on) {
      await db.update(workspaces).set({ unattendedOn: on }).where(eq(workspaces.id, id))
    }
  }
}

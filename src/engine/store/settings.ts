import { eq, inArray } from 'drizzle-orm'
import {
  AGENT_CAP_DEFAULT,
  AGENT_CAP_MAX,
  AGENT_CAP_MIN,
  THEME_CHOICES,
  THEME_DEFAULT,
  WHEN_CLOSED_DEFAULT,
  type AppSettings,
  type ThemeChoice,
  type WhenClosed
} from '../../shared/domain'
import type { Db } from '../db/open'
import { appSettings } from '../db/schema'

const MAX_AGENTS = 'max_agents'
const USAGE_LIMIT = 'usage_limit'
const WHEN_CLOSED = 'when_closed'
const THEME = 'theme'

function isThemeChoice(v: unknown): v is ThemeChoice {
  return THEME_CHOICES.includes(v as ThemeChoice)
}

/** The usage-limited state that is kept across a restart: when it began and when it resets (ISO; null when unknown). */
export interface StoredUsageLimit {
  since: string
  resetsAt: string | null
}

/** True for a whole number the setting accepts. */
export function validAgentCap(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= AGENT_CAP_MIN && n <= AGENT_CAP_MAX
}

export interface SettingsRepo {
  get(): Promise<AppSettings>
  /** Stores the number of role agents that may run at once; rejects anything but a whole number from 1 to 10. */
  setMaxAgents(n: number): Promise<AppSettings>
  /** Stores what closing the window does; rejects anything but 'tray' or 'quit'. */
  setWhenClosed(v: WhenClosed): Promise<AppSettings>
  /** Stores the colour scheme; rejects anything but 'light', 'dark' or 'system'. */
  setTheme(v: ThemeChoice): Promise<AppSettings>
  /** The usage limit Mainbus is in, or null when it is not limited. */
  usageLimit(): Promise<StoredUsageLimit | null>
  /** Stores the usage limit; null clears it. */
  setUsageLimit(limit: StoredUsageLimit | null): Promise<void>
}

export function createSettingsRepo(db: Db): SettingsRepo {
  async function get(): Promise<AppSettings> {
    // One read: the runner asks for the agent cap on every start.
    const rows = await db.select().from(appSettings).where(inArray(appSettings.key, [MAX_AGENTS, WHEN_CLOSED, THEME]))
    const value = (key: string): string | undefined => rows.find((r) => r.key === key)?.value
    const stored = Number(value(MAX_AGENTS) ?? NaN)
    const theme = value(THEME)
    return {
      maxAgents: validAgentCap(stored) ? stored : AGENT_CAP_DEFAULT,
      whenClosed: value(WHEN_CLOSED) === 'quit' ? 'quit' : WHEN_CLOSED_DEFAULT,
      theme: isThemeChoice(theme) ? theme : THEME_DEFAULT
    }
  }

  return {
    get,
    async usageLimit() {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, USAGE_LIMIT))
      if (!row) return null
      try {
        const v = JSON.parse(row.value) as Partial<StoredUsageLimit>
        if (typeof v.since !== 'string') return null
        return { since: v.since, resetsAt: typeof v.resetsAt === 'string' ? v.resetsAt : null }
      } catch {
        return null
      }
    },
    async setUsageLimit(limit) {
      if (limit === null) {
        await db.delete(appSettings).where(eq(appSettings.key, USAGE_LIMIT))
        return
      }
      const value = JSON.stringify(limit)
      await db.insert(appSettings).values({ key: USAGE_LIMIT, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } })
    },
    async setMaxAgents(n) {
      if (!validAgentCap(n)) throw new Error(`Agents running at once must be a whole number from ${AGENT_CAP_MIN} to ${AGENT_CAP_MAX}`)
      await db
        .insert(appSettings)
        .values({ key: MAX_AGENTS, value: String(n) })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: String(n) } })
      return get()
    },
    async setWhenClosed(v) {
      if (v !== 'tray' && v !== 'quit') throw new Error("When I close the window must be 'tray' or 'quit'")
      await db
        .insert(appSettings)
        .values({ key: WHEN_CLOSED, value: v })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: v } })
      return get()
    },
    async setTheme(v) {
      if (!isThemeChoice(v)) throw new Error("Theme must be 'light', 'dark' or 'system'")
      await db.insert(appSettings).values({ key: THEME, value: v }).onConflictDoUpdate({ target: appSettings.key, set: { value: v } })
      return get()
    }
  }
}

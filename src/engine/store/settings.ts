import { eq, inArray } from 'drizzle-orm'
import {
  AGENT_CAP_DEFAULT,
  AGENT_CAP_MAX,
  AGENT_CAP_MIN,
  isThemeId,
  ORCHESTRATOR_WEB_ACCESS_DEFAULT,
  THEME_CHOICES,
  THEME_IDS,
  THEME_SETTING_DEFAULT,
  themeOf,
  WHEN_CLOSED_DEFAULT,
  type AppSettings,
  type Effort,
  type ThemeChoice,
  type ThemeId,
  type ThemeScheme,
  type WhenClosed
} from '../../shared/domain'
import { EFFORTS } from '../../shared/models'
import {
  isEffort,
  isOrchestratorFamily,
  ORCHESTRATOR_EFFORT_DEFAULT,
  ORCHESTRATOR_FAMILIES,
  ORCHESTRATOR_MODEL_DEFAULT,
  type OrchestratorFamily
} from '../../shared/orchestratorModel'
import type { Db } from '../db/open'
import { appSettings } from '../db/schema'

const MAX_AGENTS = 'max_agents'
const USAGE_LIMIT = 'usage_limit'
const WHEN_CLOSED = 'when_closed'
const ORCHESTRATOR_WEB = 'orchestrator_web'
const ORCHESTRATOR_MODEL = 'orchestrator_model'
const ORCHESTRATOR_EFFORT = 'orchestrator_effort'
// The choice: a theme id or 'system'. Before named themes it held 'light', 'dark' or 'system', which are still choices.
const THEME = 'theme'
// The light and the dark theme Match Windows uses; with no row, Light and Dark, as before named themes.
const MATCH_WINDOWS: Record<ThemeScheme, string> = { light: 'theme_light', dark: 'theme_dark' }

function isThemeChoice(v: unknown): v is ThemeChoice {
  return THEME_CHOICES.includes(v as ThemeChoice)
}

function isThemeOf(scheme: ThemeScheme, v: unknown): v is ThemeId {
  return isThemeId(v) && themeOf(v).scheme === scheme
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
  /** Stores whether the orchestrator may read web pages; rejects anything but a boolean. */
  setOrchestratorWebAccess(on: boolean): Promise<AppSettings>
  /** Stores the orchestrator's model family; rejects anything but 'fable', 'opus' or 'sonnet'. */
  setOrchestratorModel(family: OrchestratorFamily): Promise<AppSettings>
  /** Stores the orchestrator's effort; rejects anything but low, medium, high, xhigh or max. */
  setOrchestratorEffort(effort: Effort): Promise<AppSettings>
  /** Stores the theme choice; rejects anything but a theme id or 'system'. */
  setTheme(v: ThemeChoice): Promise<AppSettings>
  /** Stores the light or the dark theme Match Windows uses; rejects an unknown id or a theme of the other scheme. */
  setMatchWindowsTheme(scheme: ThemeScheme, id: ThemeId): Promise<AppSettings>
  /** The usage limit Mainbus is in, or null when it is not limited. */
  usageLimit(): Promise<StoredUsageLimit | null>
  /** Stores the usage limit; null clears it. */
  setUsageLimit(limit: StoredUsageLimit | null): Promise<void>
}

export function createSettingsRepo(db: Db): SettingsRepo {
  async function get(): Promise<AppSettings> {
    // One read: the runner asks for the agent cap on every start.
    const rows = await db
      .select()
      .from(appSettings)
      .where(inArray(appSettings.key, [MAX_AGENTS, WHEN_CLOSED, ORCHESTRATOR_WEB, ORCHESTRATOR_MODEL, ORCHESTRATOR_EFFORT, THEME, MATCH_WINDOWS.light, MATCH_WINDOWS.dark]))
    const value = (key: string): string | undefined => rows.find((r) => r.key === key)?.value
    const stored = Number(value(MAX_AGENTS) ?? NaN)
    const choice = value(THEME)
    const light = value(MATCH_WINDOWS.light)
    const dark = value(MATCH_WINDOWS.dark)
    const model = value(ORCHESTRATOR_MODEL)
    const effort = value(ORCHESTRATOR_EFFORT)
    return {
      maxAgents: validAgentCap(stored) ? stored : AGENT_CAP_DEFAULT,
      whenClosed: value(WHEN_CLOSED) === 'quit' ? 'quit' : WHEN_CLOSED_DEFAULT,
      orchestratorWebAccess: value(ORCHESTRATOR_WEB) === 'off' ? false : ORCHESTRATOR_WEB_ACCESS_DEFAULT,
      orchestratorModel: isOrchestratorFamily(model) ? model : ORCHESTRATOR_MODEL_DEFAULT,
      orchestratorEffort: isEffort(effort) ? effort : ORCHESTRATOR_EFFORT_DEFAULT,
      theme: {
        choice: isThemeChoice(choice) ? choice : THEME_SETTING_DEFAULT.choice,
        light: isThemeOf('light', light) ? light : THEME_SETTING_DEFAULT.light,
        dark: isThemeOf('dark', dark) ? dark : THEME_SETTING_DEFAULT.dark
      }
    }
  }

  async function put(key: string, value: string): Promise<void> {
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } })
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
    async setOrchestratorWebAccess(on) {
      if (typeof on !== 'boolean') throw new Error('Let the orchestrator read web pages must be on or off')
      await put(ORCHESTRATOR_WEB, on ? 'on' : 'off')
      return get()
    },
    async setOrchestratorModel(family) {
      if (!isOrchestratorFamily(family)) throw new Error(`The orchestrator's model must be ${ORCHESTRATOR_FAMILIES.map((f) => `'${f}'`).join(', ')}`)
      await put(ORCHESTRATOR_MODEL, family)
      return get()
    },
    async setOrchestratorEffort(effort) {
      if (!isEffort(effort)) throw new Error(`The orchestrator's effort must be ${EFFORTS.map((e) => `'${e}'`).join(', ')}`)
      await put(ORCHESTRATOR_EFFORT, effort)
      return get()
    },
    async setTheme(v) {
      if (!isThemeChoice(v)) throw new Error(`Theme must be ${THEME_IDS.map((id) => `'${id}'`).join(', ')} or 'system'`)
      await put(THEME, v)
      return get()
    },
    async setMatchWindowsTheme(scheme, id) {
      if (scheme !== 'light' && scheme !== 'dark') throw new Error("Match Windows takes a 'light' or a 'dark' theme")
      if (!isThemeOf(scheme, id)) throw new Error(`The ${scheme} theme Match Windows uses must be a ${scheme} theme`)
      await put(MATCH_WINDOWS[scheme], id)
      return get()
    }
  }
}

import { eq } from 'drizzle-orm'
import { AGENT_CAP_DEFAULT, AGENT_CAP_MAX, AGENT_CAP_MIN, type AppSettings } from '../../shared/domain'
import type { Db } from '../db/open'
import { appSettings } from '../db/schema'

const MAX_AGENTS = 'max_agents'
const UNATTENDED = 'unattended'

/** True for a whole number the setting accepts. */
export function validAgentCap(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= AGENT_CAP_MIN && n <= AGENT_CAP_MAX
}

export interface SettingsRepo {
  get(): Promise<AppSettings>
  /** Stores the number of role agents that may run at once; rejects anything but a whole number from 1 to 10. */
  setMaxAgents(n: number): Promise<AppSettings>
  /** Whether unattended mode was on when the app last ran. Kept apart from AppSettings: the renderer doesn't read it. */
  unattendedOn(): Promise<boolean>
  setUnattendedOn(on: boolean): Promise<void>
}

export function createSettingsRepo(db: Db): SettingsRepo {
  async function get(): Promise<AppSettings> {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, MAX_AGENTS))
    const stored = row ? Number(row.value) : NaN
    return { maxAgents: validAgentCap(stored) ? stored : AGENT_CAP_DEFAULT }
  }

  return {
    get,
    async unattendedOn() {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, UNATTENDED))
      return row?.value === 'on'
    },
    async setUnattendedOn(on) {
      await db
        .insert(appSettings)
        .values({ key: UNATTENDED, value: on ? 'on' : 'off' })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: on ? 'on' : 'off' } })
    },
    async setMaxAgents(n) {
      if (!validAgentCap(n)) throw new Error(`Agents running at once must be a whole number from ${AGENT_CAP_MIN} to ${AGENT_CAP_MAX}`)
      await db
        .insert(appSettings)
        .values({ key: MAX_AGENTS, value: String(n) })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: String(n) } })
      return get()
    }
  }
}

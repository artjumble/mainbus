import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import type { StuckEpisode, StuckRule } from '../../shared/domain'
import type { Db } from '../db/open'
import { agentRuns, stuckEpisodes } from '../db/schema'
import { STUCK } from '../stuck/config'

/** What a check found: the rule that fired and the lines that show why. */
export interface StuckHit {
  rule: StuckRule
  evidence: string[]
}

/** What recording a hit did to the run's episode. */
export type HitChange = 'opened' | 'repeated' | 'escalated'

export interface StuckRepo {
  /**
   * Records a hit on the run: opens its episode, or counts the hit on the one that is open. A repeat takes the
   * latest hit's rule and evidence. The episode escalates when its count reaches the escalation count.
   */
  hit(runId: string, hit: StuckHit): Promise<{ episode: StuckEpisode; change: HitChange }>
  /** The run's open episode, or null. */
  open(runId: string): Promise<StuckEpisode | null>
  /** Closes the run's open episode; false when it had none. */
  close(runId: string): Promise<boolean>
  /** True when a dead process was ever reported on the run, open or closed: it is reported once per run. */
  hadDeadProcess(runId: string): Promise<boolean>
  /** The open episodes of every ticket's open run, by ticket id. */
  openByTicket(): Promise<Map<string, StuckEpisode>>
  /** The open episodes opened or escalated at or after `since` (all open ones when null), with their ticket and the run's role, oldest first. */
  changedSince(since: string | null): Promise<{ ticketId: string; role: string; episode: StuckEpisode }[]>
}

type Row = typeof stuckEpisodes.$inferSelect

function toEpisode(row: Row): StuckEpisode {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    rule: row.rule,
    evidence: JSON.parse(row.evidence) as string[],
    hitCount: row.hitCount,
    needsCloserLook: row.escalatedAt !== null || row.hitCount >= STUCK.escalateAtHit,
    openedAt: row.openedAt,
    lastHitAt: row.lastHitAt,
    escalatedAt: row.escalatedAt
  }
}

export function createStuckRepo(db: Db, now: () => Date): StuckRepo {
  const openOf = (runId: string) => and(eq(stuckEpisodes.agentRunId, runId), isNull(stuckEpisodes.closedAt))

  return {
    async hit(runId, hit) {
      const at = now().toISOString()
      const evidence = JSON.stringify(hit.evidence)
      const [repeated] = await db
        .update(stuckEpisodes)
        .set({ rule: hit.rule, evidence, lastHitAt: at, hitCount: sql`${stuckEpisodes.hitCount} + 1` })
        .where(openOf(runId))
        .returning()
      if (repeated) {
        if (repeated.hitCount >= STUCK.escalateAtHit && repeated.escalatedAt === null) {
          const [escalated] = await db
            .update(stuckEpisodes)
            .set({ escalatedAt: at })
            .where(eq(stuckEpisodes.id, repeated.id))
            .returning()
          return { episode: toEpisode(escalated!), change: 'escalated' }
        }
        return { episode: toEpisode(repeated), change: 'repeated' }
      }
      const [opened] = await db
        .insert(stuckEpisodes)
        .values({ id: randomUUID(), agentRunId: runId, rule: hit.rule, evidence, hitCount: 1, openedAt: at, lastHitAt: at })
        .returning()
      return { episode: toEpisode(opened!), change: 'opened' }
    },

    async open(runId) {
      const [row] = await db.select().from(stuckEpisodes).where(openOf(runId))
      return row ? toEpisode(row) : null
    },

    async close(runId) {
      const closed = await db
        .update(stuckEpisodes)
        .set({ closedAt: now().toISOString() })
        .where(openOf(runId))
        .returning({ id: stuckEpisodes.id })
      return closed.length > 0
    },

    async hadDeadProcess(runId) {
      const [row] = await db
        .select({ id: stuckEpisodes.id })
        .from(stuckEpisodes)
        .where(and(eq(stuckEpisodes.agentRunId, runId), eq(stuckEpisodes.rule, 'dead_process')))
        .limit(1)
      return row !== undefined
    },

    async openByTicket() {
      const rows = await db
        .select({ ticketId: agentRuns.ticketId, episode: stuckEpisodes })
        .from(stuckEpisodes)
        .innerJoin(agentRuns, eq(agentRuns.id, stuckEpisodes.agentRunId))
        .where(isNull(stuckEpisodes.closedAt))
        .orderBy(asc(stuckEpisodes.openedAt))
      return new Map(rows.map((r) => [r.ticketId, toEpisode(r.episode)]))
    },

    async changedSince(since) {
      const rows = await db
        .select({ ticketId: agentRuns.ticketId, role: agentRuns.role, episode: stuckEpisodes })
        .from(stuckEpisodes)
        .innerJoin(agentRuns, eq(agentRuns.id, stuckEpisodes.agentRunId))
        .where(
          and(
            isNull(stuckEpisodes.closedAt),
            since === null ? undefined : or(gte(stuckEpisodes.openedAt, since), gte(stuckEpisodes.escalatedAt, since))
          )
        )
        .orderBy(asc(stuckEpisodes.openedAt))
      return rows.map((r) => ({ ticketId: r.ticketId, role: r.role, episode: toEpisode(r.episode) }))
    }
  }
}

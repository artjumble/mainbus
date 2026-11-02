import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createRunRepo, type RunRepo } from './runs'
import { createStuckRepo, type StuckRepo } from './stuck'
import { FIXED_NOW, openTestDb, testRole } from './testDb'
import { createTicketRepo } from './tickets'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let runs: RunRepo
let stuck: StuckRepo
let ticketId: string
let runId: string
let clock: Date
const now = () => clock
const later = (minutes: number): string => new Date(FIXED_NOW.getTime() + minutes * 60_000).toISOString()

const hit = { rule: 'repeated_failure' as const, evidence: ['Bash failed 5 times in a row: npm test'] }

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  clock = FIXED_NOW
  const ws = await createWorkspaceRepo(db, now).create('/r', 'main', 'r', 'r')
  ticketId = (
    await createTicketRepo(db, now).create({ workspaceId: ws.id, title: 'T', intent: 'i', spec: '', criteria: [], labels: [], column: 'ready' })
  ).id
  runs = createRunRepo(db, now)
  stuck = createStuckRepo(db, now)
  runId = await runs.create(ticketId, [testRole()])
})
afterEach(() => cleanup())

describe('stuck episodes', () => {
  it('opens an episode on the first hit', async () => {
    const { episode, change } = await stuck.hit(runId, hit)
    expect(change).toBe('opened')
    expect(episode).toMatchObject({ agentRunId: runId, rule: 'repeated_failure', evidence: hit.evidence, hitCount: 1, needsCloserLook: false, escalatedAt: null })
    expect(await stuck.open(runId)).toEqual(episode)
  })

  it('counts a repeat hit on the same episode and keeps the latest rule and evidence', async () => {
    const { episode } = await stuck.hit(runId, hit)
    clock = new Date(later(5))
    const repeated = await stuck.hit(runId, { rule: 'silence', evidence: ['No events from the agent for 10 minutes'] })
    expect(repeated.change).toBe('repeated')
    expect(repeated.episode).toMatchObject({
      id: episode.id,
      rule: 'silence',
      evidence: ['No events from the agent for 10 minutes'],
      hitCount: 2,
      openedAt: episode.openedAt,
      lastHitAt: later(5)
    })
  })

  it('escalates at the third hit, once', async () => {
    await stuck.hit(runId, hit)
    await stuck.hit(runId, hit)
    clock = new Date(later(10))
    const third = await stuck.hit(runId, hit)
    expect(third.change).toBe('escalated')
    expect(third.episode).toMatchObject({ hitCount: 3, needsCloserLook: true, escalatedAt: later(10) })
    clock = new Date(later(15))
    const fourth = await stuck.hit(runId, hit)
    expect(fourth.change).toBe('repeated')
    expect(fourth.episode).toMatchObject({ hitCount: 4, needsCloserLook: true, escalatedAt: later(10) })
  })

  it('closes the open episode, and a later hit opens a new one', async () => {
    const first = (await stuck.hit(runId, hit)).episode
    expect(await stuck.close(runId)).toBe(true)
    expect(await stuck.close(runId)).toBe(false)
    expect(await stuck.open(runId)).toBeNull()
    const second = await stuck.hit(runId, hit)
    expect(second.change).toBe('opened')
    expect(second.episode.id).not.toBe(first.id)
  })

  it('records one redirect per episode and counts it on the run', async () => {
    const { episode } = await stuck.hit(runId, hit)
    expect(episode.redirectedAt).toBeNull()
    expect((await runs.latest(ticketId))!.redirectCount).toBe(0)

    clock = new Date(later(3))
    expect(await stuck.markRedirected(episode.id)).toBe(true)
    expect(await stuck.open(runId)).toMatchObject({ id: episode.id, redirectedAt: later(3) })
    expect((await runs.latest(ticketId))!.redirectCount).toBe(1)

    // Once per episode: the second is refused and counts nothing.
    expect(await stuck.markRedirected(episode.id)).toBe(false)
    expect((await runs.latest(ticketId))!.redirectCount).toBe(1)

    // A repeat hit keeps the redirect; a new episode starts unredirected and can be redirected again.
    expect((await stuck.hit(runId, hit)).episode.redirectedAt).toBe(later(3))
    await stuck.close(runId)
    const next = (await stuck.hit(runId, hit)).episode
    expect(next.redirectedAt).toBeNull()
    expect(await stuck.markRedirected(next.id)).toBe(true)
    expect((await runs.latest(ticketId))!.redirectCount).toBe(2)
  })

  it('does not redirect a closed episode', async () => {
    const { episode } = await stuck.hit(runId, hit)
    await stuck.close(runId)
    expect(await stuck.markRedirected(episode.id)).toBe(false)
    expect((await runs.latest(ticketId))!.redirectCount).toBe(0)
  })

  it('closes with the run, however it ends', async () => {
    await stuck.hit(runId, hit)
    await runs.end(runId, 'failed')
    expect(await stuck.open(runId)).toBeNull()
  })

  it('remembers a dead process after its episode closed', async () => {
    expect(await stuck.hadDeadProcess(runId)).toBe(false)
    await stuck.hit(runId, { rule: 'dead_process', evidence: ['The Implementer’s process ended'] })
    await stuck.close(runId)
    expect(await stuck.hadDeadProcess(runId)).toBe(true)
  })

  it('lists the open episodes by ticket', async () => {
    const other = await createTicketRepo(db, now).create({
      workspaceId: (await createWorkspaceRepo(db, now).get())!.id,
      title: 'U',
      intent: 'i',
      spec: '',
      criteria: [],
      labels: [],
      column: 'ready'
    })
    const otherRun = await runs.create(other.id, [testRole()])
    await stuck.hit(runId, hit)
    await stuck.hit(otherRun, hit)
    await stuck.close(otherRun)
    const open = await stuck.openByTicket()
    expect([...open.keys()]).toEqual([ticketId])
  })

  it('lists the open episodes opened or escalated at or after a time, with their role', async () => {
    await stuck.hit(runId, hit)
    expect((await stuck.changedSince(null)).map((c) => [c.ticketId, c.role])).toEqual([[ticketId, 'Implementer']])
    expect(await stuck.changedSince(later(1))).toEqual([])
    expect(await stuck.changedSince(FIXED_NOW.toISOString())).toHaveLength(1)

    // A repeat is not news; the escalation is.
    clock = new Date(later(5))
    await stuck.hit(runId, hit)
    expect(await stuck.changedSince(later(1))).toEqual([])
    clock = new Date(later(10))
    await stuck.hit(runId, hit)
    expect(await stuck.changedSince(later(1))).toHaveLength(1)

    await stuck.close(runId)
    expect(await stuck.changedSince(null)).toEqual([])
  })
})

describe('a declared wait on the run', () => {
  it('is stored, replaced by a later one, and gone once the run ends', async () => {
    expect((await runs.latest(ticketId))!.declaredWait).toBeNull()
    await runs.setDeclaredWait(runId, { reason: 'a build', until: later(30) })
    expect((await runs.latest(ticketId))!.declaredWait).toEqual({ reason: 'a build', until: later(30) })
    await runs.setDeclaredWait(runId, { reason: 'the tests', until: later(60) })
    expect((await runs.latest(ticketId))!.declaredWait).toEqual({ reason: 'the tests', until: later(60) })
    await runs.end(runId, 'stopped')
    expect((await runs.latest(ticketId))!.declaredWait).toBeNull()
  })

  it('is gone from a run that hands on', async () => {
    const next = testRole({ id: 'r2', name: 'Reviewer' })
    const first = await runs.create(ticketId, [testRole(), next])
    await runs.setDeclaredWait(first, { reason: 'a build', until: later(30) })
    await runs.handOn(first, next)
    const [, old] = (await runs.listForTicket(ticketId)).reverse()
    expect(old!.declaredWait).toBeNull()
  })

  it('listOpen has the runs that have not ended', async () => {
    const second = await runs.create(ticketId, [testRole()])
    await runs.end(runId, 'stopped')
    expect((await runs.listOpen()).map((r) => r.id)).toEqual([second])
  })
})

describe('replacing and the ladder', () => {
  it('lists every episode of the given runs, open or closed, oldest first', async () => {
    await stuck.hit(runId, hit)
    await stuck.close(runId)
    clock = new Date(later(10))
    await stuck.hit(runId, { rule: 'silence', evidence: ['No events'] })
    expect((await stuck.forRuns([runId])).map((e) => e.rule)).toEqual(['repeated_failure', 'silence'])
    expect(await stuck.forRuns([])).toEqual([])
    expect(await stuck.forRuns(['other'])).toEqual([])
  })

  it('reports a redirected episode that is hit again as news, but not one that is merely redirected', async () => {
    const { episode } = await stuck.hit(runId, hit)
    clock = new Date(later(2))
    await stuck.markRedirected(episode.id)
    // Redirected at +2 and not hit since: an old episode, nothing new.
    expect(await stuck.changedSince(later(1))).toEqual([])
    clock = new Date(later(8))
    await stuck.hit(runId, hit)
    expect((await stuck.changedSince(later(5))).map((c) => c.episode.id)).toEqual([episode.id])
    expect(await stuck.changedSince(later(9))).toEqual([])
  })

  it('an episode ends with its replaced run', async () => {
    await stuck.hit(runId, hit)
    const fresh = await runs.replace(runId, { model: 'opus', effort: 'high', extraInstructions: null, handoffSummary: 's' })
    expect(await stuck.open(runId)).toBeNull()
    expect(await stuck.open(fresh!.id)).toBeNull()
  })
})

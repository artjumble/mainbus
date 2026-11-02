import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { TicketState } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { FakeClock } from '../holds/clock'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, openTestDb, testRole } from '../store/testDb'
import { StuckDetector } from './detector'
import type { RunObservation } from './observation'

const MIN = 60_000
const START = FIXED_NOW

let cleanup: () => void
let repos: Repos
let clock: FakeClock
let ticketId: string
let runId: string
let emitted: EngineEvent[]
let detector: StuckDetector

/** What the fake runner reports, and the newest file change the fake probe finds. */
let scene: () => Partial<RunObservation>
let files: number | null

const now = (): number => clock.now().getTime()
const ago = (minutes: number): number => now() - minutes * MIN
/** A fixed moment: minutes before the start, whatever the time is now. */
const before = (minutes: number): number => START.getTime() - minutes * MIN
const iso = (ms: number): string => new Date(ms).toISOString()

const WORKING: TicketState = { column: 'in_progress', phase: 'implementing', agentStatus: 'working', summary: null, canContinue: false, pausedByUser: false, deferredUntil: null }

let seq = 0
function stored(at: number, event: ThreadEvent): StoredEvent {
  return { runId, seq: ++seq, at: iso(at), event }
}

/** Five attempts at one failing command, the last of them a minute before the start. */
function fiveFailures(): StoredEvent[] {
  return [0, 1, 2, 3, 4].flatMap((i) => [
    stored(before(5 - i), { kind: 'tool_call', id: `c${i}`, name: 'Bash', input: { command: 'npm test' } }),
    stored(before(5 - i), { kind: 'tool_result', id: `c${i}`, ok: false, summary: 'exit code 1' })
  ])
}

/**
 * A live process. Its times are minutes before the start (fixed, so they age as the clock moves); the last
 * activity is just now unless given, as it is for an agent that is busy.
 */
function live(over: { activity?: number; started?: number; turn?: number; inTurn?: boolean } = {}): RunObservation['live'] {
  const started = over.started ?? 1
  return {
    lastActivityAt: over.activity === undefined ? now() : before(over.activity),
    startedAt: before(started),
    turnStartedAt: before(over.turn ?? started),
    inTurn: over.inTurn ?? true
  }
}

type Rule = 'repeated_failure' | 'no_progress' | 'silence' | 'long_turn'

/** A run in which exactly one rule fires. */
const SCENARIOS: Record<Rule, () => { observation: Partial<RunObservation>; files: number | null }> = {
  repeated_failure: () => ({ observation: { events: fiveFailures(), live: live() }, files: null }),
  no_progress: () => ({ observation: { live: live({ started: 16 }) }, files: null }),
  silence: () => ({ observation: { live: live({ activity: 11, started: 11 }) }, files: null }),
  long_turn: () => ({ observation: { live: live({ started: 61 }) }, files: before(3) })
}

function useScenario(rule: Rule): void {
  scene = () => SCENARIOS[rule]().observation
  files = SCENARIOS[rule]().files
}

beforeEach(async () => {
  const testDb = await openTestDb()
  cleanup = testDb.cleanup
  clock = new FakeClock(START)
  repos = createRepos(testDb.db, () => clock.now())
  const ws = await repos.workspaces.create('C:\\code\\shop', 'main', 'shop', 'shop')
  ticketId = (
    await repos.tickets.create({ workspaceId: ws.id, title: 'Login', intent: 'Add login', spec: '', criteria: [], labels: [], column: 'ready' })
  ).id
  runId = await repos.runs.create(ticketId, [testRole()])
  emitted = []
  scene = () => ({ live: live() })
  files = null
  detector = new StuckDetector({
    repos,
    now: () => clock.now(),
    emit: (e) => emitted.push(e),
    timer: clock,
    observe: async () => ({
      runId,
      ticketId,
      workspaceId: ws.id,
      role: 'Implementer',
      worktreePath: 'C:\\work\\1-login',
      state: WORKING,
      launching: false,
      usageLimited: false,
      declaredWait: null,
      events: [],
      live: live(),
      ...scene()
    }),
    failIfExhausted: async () => false,
    newestChange: async () => files
  })
})

afterEach(() => {
  detector.dispose()
  cleanup()
})

const episode = () => repos.stuck.open(runId)

describe('the four rules, through the detector', () => {
  test.each(['repeated_failure', 'no_progress', 'silence', 'long_turn'] as const)('%s opens an episode of its own rule', async (rule) => {
    useScenario(rule)
    await detector.check()
    expect(await episode()).toMatchObject({ rule, hitCount: 1, needsCloserLook: false })
    expect(emitted).toContainEqual({ type: 'board.changed', workspaceId: expect.any(String) })
  })

  test('a healthy run opens nothing', async () => {
    await detector.check()
    expect(await episode()).toBeNull()
  })

  test('silence fires at ten minutes of the periodic check, and not before', async () => {
    const quietSince = now()
    scene = () => ({ live: { lastActivityAt: quietSince, startedAt: quietSince, turnStartedAt: quietSince, inTurn: false } })
    detector.start()
    await clock.advance(9 * MIN)
    expect(await episode()).toBeNull()
    await clock.advance(MIN)
    expect(await episode()).toMatchObject({ rule: 'silence', evidence: ['No events from the agent for 10 minutes'] })
  })

  test('the periodic check stops when the detector is disposed', async () => {
    const quietSince = now()
    scene = () => ({ live: { lastActivityAt: quietSince, startedAt: quietSince, turnStartedAt: quietSince, inTurn: false } })
    detector.start()
    detector.dispose()
    await clock.advance(30 * MIN)
    expect(await episode()).toBeNull()
    expect(clock.pending).toBe(0)
  })
})

describe('not stuck', () => {
  const CONDITIONS: Record<string, () => Promise<void> | void> = {
    'a declared wait is in force': () => {
      const before = scene
      scene = () => ({ ...before(), declaredWait: { reason: 'the full test suite', until: iso(now() + 10 * MIN) } })
    },
    'the ticket is held': async () => {
      await repos.holds.place('ticket', ticketId, {})
    },
    'a decision is open': () => {
      const before = scene
      scene = () => ({ ...before(), state: { ...WORKING, column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' } })
    },
    'files are still changing': () => {
      files = ago(1)
    },
    'the agent is paused': () => {
      const before = scene
      scene = () => ({ ...before(), live: null, state: { ...WORKING, agentStatus: 'paused', pausedByUser: true } })
    },
    'the agent is being launched or queued': () => {
      const before = scene
      scene = () => ({ ...before(), launching: true })
    },
    'a usage limit stopped the agent': () => {
      const before = scene
      scene = () => ({ ...before(), usageLimited: true })
    }
  }

  for (const [name, apply] of Object.entries(CONDITIONS)) {
    test.each(['repeated_failure', 'no_progress', 'silence', 'long_turn'] as const)(`no ${name}: %s does not fire`, async (rule) => {
      useScenario(rule)
      await apply()
      await detector.check()
      expect(await episode()).toBeNull()
    })
  }

  test('a declared wait that has passed no longer protects the agent, and its silence counts from where the wait ended', async () => {
    const until = now() + 5 * MIN
    scene = () => ({ live: live({ activity: 30, started: 30 }), declaredWait: { reason: 'a build', until: iso(until) } })
    await clock.advance(5 * MIN)
    await detector.check()
    expect(await episode()).toBeNull()
    await clock.advance(9 * MIN)
    await detector.check()
    expect(await episode()).toBeNull()
    await clock.advance(MIN)
    await detector.check()
    expect(await episode()).toMatchObject({ rule: 'silence' })
  })

  test('a low context reading never counts: nothing about it reaches the rules', async () => {
    const lowContext: StoredEvent = stored(ago(0), { kind: 'usage', inputTokens: 190_000, outputTokens: 1 })
    scene = () => ({ events: [lowContext], live: live() })
    await detector.check()
    expect(await episode()).toBeNull()
  })

  test('a run that has ended is not looked at', async () => {
    useScenario('silence')
    await repos.runs.end(runId, 'stopped')
    await detector.check()
    expect(await repos.stuck.hadDeadProcess(runId)).toBe(false)
    expect(await episode()).toBeNull()
  })
})

describe('no alert storms', () => {
  test('repeat hits grow one episode instead of opening another', async () => {
    useScenario('repeated_failure')
    await detector.check()
    const first = (await episode())!
    // Checks inside the spacing don't count.
    await clock.advance(MIN)
    await detector.check()
    expect(await episode()).toMatchObject({ id: first.id, hitCount: 1 })

    await clock.advance(5 * MIN)
    await detector.check()
    expect(await episode()).toMatchObject({ id: first.id, hitCount: 2, needsCloserLook: false, escalatedAt: null })
  })

  test('the third hit marks the episode as needing a closer look, once', async () => {
    useScenario('repeated_failure')
    for (let hit = 1; hit <= 3; hit++) {
      await detector.check()
      await clock.advance(5 * MIN)
    }
    const escalated = (await episode())!
    expect(escalated).toMatchObject({ hitCount: 3, needsCloserLook: true, escalatedAt: iso(START.getTime() + 10 * MIN) })

    await detector.check()
    await clock.advance(5 * MIN)
    expect(await episode()).toMatchObject({ id: escalated.id, hitCount: 4, escalatedAt: escalated.escalatedAt })
  })

  test('a repeat hit takes the latest rule and evidence', async () => {
    useScenario('repeated_failure')
    await detector.check()
    useScenario('no_progress')
    await clock.advance(5 * MIN)
    await detector.check()
    expect(await episode()).toMatchObject({ rule: 'no_progress', hitCount: 2 })
  })

  test('a new file change after the last hit closes the episode', async () => {
    useScenario('repeated_failure')
    await detector.check()
    expect(await episode()).not.toBeNull()
    emitted = []
    await clock.advance(MIN)
    files = now()
    await detector.check()
    expect(await episode()).toBeNull()
    expect(emitted).toContainEqual({ type: 'board.changed', workspaceId: expect.any(String) })
  })

  test('a new kind of tool after the last hit closes the episode; a kind seen before does not', async () => {
    useScenario('repeated_failure')
    await detector.check()
    await clock.advance(MIN)
    const base = SCENARIOS.repeated_failure().observation
    scene = () => ({ ...base, events: [...base.events!, stored(now(), { kind: 'tool_call', id: 'again', name: 'Bash', input: { command: 'ls' } })] })
    await detector.check()
    expect(await episode()).not.toBeNull()

    scene = () => ({ ...base, events: [...base.events!, stored(now(), { kind: 'tool_call', id: 'new', name: 'Edit', input: { file_path: 'a.ts' } })] })
    await detector.check()
    expect(await episode()).toBeNull()
  })

  test('a silence episode closes when events come again, and a long turn when the turn ends', async () => {
    useScenario('silence')
    await detector.check()
    await clock.advance(MIN)
    scene = () => ({ live: live({ started: 12 }) })
    await detector.check()
    expect(await episode()).toBeNull()

    useScenario('long_turn')
    await clock.advance(MIN)
    await detector.check()
    expect(await episode()).toMatchObject({ rule: 'long_turn' })
    scene = () => ({ live: live({ started: 62, inTurn: false }) })
    await detector.check()
    expect(await episode()).toBeNull()
  })

  test('after progress closed an episode, a later hit opens a new one', async () => {
    useScenario('repeated_failure')
    await detector.check()
    const first = (await episode())!
    files = now() + MIN
    await clock.advance(MIN)
    await detector.check()
    expect(await episode()).toBeNull()
    files = null
    await clock.advance(10 * MIN)
    await detector.check()
    const second = (await episode())!
    expect(second.id).not.toBe(first.id)
    expect(second.hitCount).toBe(1)
  })

  test('the episode closes when the run ends, by handoff, stop or failure', async () => {
    useScenario('repeated_failure')
    await detector.check()
    expect(await episode()).not.toBeNull()
    expect(await repos.runs.end(runId, 'stopped')).toBe(true)
    expect(await episode()).toBeNull()
  })

  test('the episode closes when the run hands on to the next role', async () => {
    const next = testRole({ id: 'reviewer', name: 'Reviewer' })
    runId = await repos.runs.create(ticketId, [testRole(), next])
    useScenario('repeated_failure')
    await detector.check()
    expect(await episode()).not.toBeNull()
    const handed = await repos.runs.handOn(runId, next)
    expect(handed).not.toBeNull()
    expect(await repos.stuck.open(runId)).toBeNull()
  })
})

describe('a dead process', () => {
  const dead = (): Partial<RunObservation> => ({
    live: null,
    state: { ...WORKING, agentStatus: 'paused', canContinue: true },
    events: [stored(ago(1), { kind: 'process_exit', code: null })]
  })

  test('is reported once per run, not on every check', async () => {
    scene = dead
    await detector.check()
    const first = (await episode())!
    expect(first).toMatchObject({ rule: 'dead_process', hitCount: 1 })

    for (let i = 0; i < 5; i++) {
      await clock.advance(10 * MIN)
      await detector.check()
    }
    expect(await episode()).toMatchObject({ id: first.id, hitCount: 1 })
    // Even once it was closed (the run was resumed), it is not reported again.
    await repos.stuck.close(runId)
    await detector.check()
    expect(await episode()).toBeNull()
  })

  test('is closed when the process is up again', async () => {
    scene = dead
    await detector.check()
    expect(await episode()).not.toBeNull()
    scene = () => ({ live: live() })
    await detector.check()
    expect(await episode()).toBeNull()
  })

  test('is not reported for the user pausing, a usage limit, a hold, or a process that simply is not up yet', async () => {
    for (const over of [
      { state: { ...WORKING, agentStatus: 'paused' as const, pausedByUser: true } },
      { usageLimited: true },
      { launching: true },
      { events: [] }
    ]) {
      scene = () => ({ ...dead(), ...over })
      await detector.check()
      expect(await episode()).toBeNull()
    }
    await repos.holds.place('ticket', ticketId, {})
    scene = dead
    await detector.check()
    expect(await episode()).toBeNull()
  })
})

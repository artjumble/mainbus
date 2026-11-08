import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { TicketState } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { FakeClock } from '../holds/clock'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, openTestDb, testRole } from '../store/testDb'
import { StuckDetector, type StuckNote } from './detector'
import type { RunObservation } from './observation'

const MIN = 60_000
const START = FIXED_NOW

let cleanup: () => void
let repos: Repos
let clock: FakeClock
let ticketId: string
let runId: string
let emitted: EngineEvent[]
let notes: StuckNote[]
/** The episodes the orchestrator was told of, and whether the run counts as failed when its episode opens. */
let wakes: { workspaceId: string; episodeId: string }[]
let exhausted: boolean
let detector: StuckDetector

/** What the fake runner reports, and the newest file change the fake probe finds. */
let scene: () => Partial<RunObservation>
let files: number | null
/** The commit the fake probe finds in the worktree. */
let head: string | null
let headReads: number

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

type Rule = 'repeated_failure' | 'no_progress' | 'silence' | 'no_milestone' | 'long_turn'

/** A run in which exactly one rule fires. */
const SCENARIOS: Record<Rule, () => { observation: Partial<RunObservation>; files: number | null }> = {
  repeated_failure: () => ({ observation: { events: fiveFailures(), live: live() }, files: null }),
  no_progress: () => ({ observation: { live: live({ started: 16 }) }, files: null }),
  silence: () => ({ observation: { live: live({ activity: 11, started: 11 }) }, files: null }),
  no_milestone: () => ({ observation: { live: live({ started: 31 }) }, files: before(3) }),
  // A message a minute ago, so only the ceiling is left to fire.
  long_turn: () => ({ observation: { live: live({ started: 181 }), events: [stored(ago(1), { kind: 'message', text: 'Still on it' })] }, files: before(3) })
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
  notes = []
  wakes = []
  exhausted = false
  scene = () => ({ live: live() })
  files = null
  head = 'aaa'
  headReads = 0
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
    failIfExhausted: async () => exhausted,
    noteStuck: async (_t, _r, note) => void notes.push(note),
    onStuck: async (workspaceId, e) => void wakes.push({ workspaceId, episodeId: e.id }),
    newestChange: async () => files,
    headCommit: async () => {
      headReads++
      return head
    }
  })
})

afterEach(() => {
  detector.dispose()
  cleanup()
})

const episode = () => repos.stuck.open(runId)

describe('the rules, through the detector', () => {
  test.each(['repeated_failure', 'no_progress', 'silence', 'no_milestone', 'long_turn'] as const)('%s opens an episode of its own rule', async (rule) => {
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
    'the agent is paused': () => {
      const before = scene
      scene = () => ({ ...before(), live: null, state: { ...WORKING, agentStatus: 'paused', pausedByUser: true } })
    },
    'the agent is being launched or queued': () => {
      const before = scene
      scene = () => ({ ...before(), launching: true })
    },
    'the agent is queued for a free slot': () => {
      const before = scene
      scene = () => ({ ...before(), live: null, state: { ...WORKING, agentStatus: 'queued', queuePosition: 1 } })
    },
    'a usage limit stopped the agent': () => {
      const before = scene
      scene = () => ({ ...before(), usageLimited: true })
    }
  }

  for (const [name, apply] of Object.entries(CONDITIONS)) {
    test.each(['repeated_failure', 'no_progress', 'silence', 'no_milestone', 'long_turn'] as const)(`no ${name}: %s does not fire`, async (rule) => {
      useScenario(rule)
      await apply()
      await detector.check()
      expect(await episode()).toBeNull()
    })
  }

  test.each(['repeated_failure', 'no_progress', 'silence'] as const)('files still changing: %s does not fire', async (rule) => {
    useScenario(rule)
    files = ago(1)
    await detector.check()
    expect(await episode()).toBeNull()
  })

  test.each(['no_milestone', 'long_turn'] as const)('files still changing do not stop %s', async (rule) => {
    useScenario(rule)
    files = ago(1)
    await detector.check()
    expect(await episode()).toMatchObject({ rule })
  })

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

describe('telling the thread', () => {
  test('notes an opened episode, with the count of the repeated failure, and the escalation, but not a plain repeat', async () => {
    useScenario('repeated_failure')
    for (let hit = 1; hit <= 4; hit++) {
      await detector.check()
      await clock.advance(5 * MIN)
    }
    expect(notes.map((n) => n.change)).toEqual(['opened', 'escalated'])
    expect(notes[0]).toMatchObject({ episode: { rule: 'repeated_failure' }, count: expect.any(Number) })
  })

  test('notes the first hit after the redirect as firing again, once', async () => {
    useScenario('repeated_failure')
    await detector.check()
    const opened = (await episode())!
    await repos.stuck.markRedirected(opened.id)
    await clock.advance(5 * MIN)
    await detector.check()
    await clock.advance(5 * MIN)
    await detector.check()
    // The third hit escalates; it is not a second "fired again".
    expect(notes.map((n) => n.change)).toEqual(['opened', 'fired_again', 'escalated'])
  })
})

describe('waking the orchestrator', () => {
  test('is told of an opened episode and its escalation, with the workspace, but not of a plain repeat', async () => {
    useScenario('repeated_failure')
    for (let hit = 1; hit <= 4; hit++) {
      await detector.check()
      await clock.advance(5 * MIN)
    }
    const id = (await episode())!.id
    expect(wakes).toEqual([
      { workspaceId: expect.any(String), episodeId: id },
      { workspaceId: expect.any(String), episodeId: id }
    ])
  })

  test('is told when an episode fires again after its redirect', async () => {
    useScenario('repeated_failure')
    await detector.check()
    await repos.stuck.markRedirected((await episode())!.id)
    await clock.advance(5 * MIN)
    await detector.check()
    expect(notes.map((n) => n.change)).toEqual(['opened', 'fired_again'])
    expect(wakes).toHaveLength(2)
  })

  test('is not told when the run failed instead of being offered another redirect: the failure is the news', async () => {
    useScenario('repeated_failure')
    exhausted = true
    await detector.check()
    // The thread still has its note; the orchestrator hears of the failure, not of the episode.
    expect(notes.map((n) => n.change)).toEqual(['opened'])
    expect(wakes).toEqual([])
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

  test('a silence episode closes when events come again, and a long turn when the turn ends, a message does not', async () => {
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
    scene = () => ({ live: live({ started: 182 }), events: [stored(ago(0), { kind: 'message', text: 'Hello' })] })
    await detector.check()
    expect(await episode()).toMatchObject({ rule: 'long_turn' })
    scene = () => ({ live: live({ started: 182, inTurn: false }) })
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

describe('the milestone rule', () => {
  test('git is not asked for the head of a run that is not working, or between turns', async () => {
    scene = () => ({ state: { ...WORKING, column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' } })
    await detector.check()
    scene = () => ({ live: live({ inTurn: false }) })
    await detector.check()
    expect(headReads).toBe(0)
    scene = () => ({ live: live() })
    await detector.check()
    expect(headReads).toBe(1)
  })

  test('a head seen for the first time is not a milestone; a head that moves restarts the count', async () => {
    const started = now()
    // Files keep changing, so only the turn rules can fire.
    scene = () => {
      files = now()
      return { live: { lastActivityAt: now(), startedAt: started, turnStartedAt: started, inTurn: true } }
    }
    detector.start()
    await clock.advance(5 * MIN)
    head = 'bbb'
    await clock.advance(29 * MIN)
    expect(await episode()).toBeNull()
    await clock.advance(MIN)
    expect(await episode()).toBeNull()
    await clock.advance(5 * MIN)
    expect(await episode()).toMatchObject({ rule: 'no_milestone' })
  })

  test('churn: files changing every minute with no milestone opens one episode at 30 minutes, and file changes do not close it', async () => {
    const started = now()
    scene = () => ({ live: { lastActivityAt: now(), startedAt: started, turnStartedAt: started, inTurn: true } })
    detector.start()
    for (let m = 1; m <= 34; m++) {
      files = now() + MIN - 1
      await clock.advance(MIN)
      if (m < 30) expect(await episode()).toBeNull()
    }
    expect(await episode()).toMatchObject({ rule: 'no_milestone' })
    expect(notes.map((n) => n.change)).toEqual(['opened'])
    expect(wakes).toHaveLength(1)
  })

  test('an episode closes on a message, a ticked criterion or a commit after the hit, and when the turn ends', async () => {
    useScenario('no_milestone')
    const base = SCENARIOS.no_milestone().observation
    const closing: [string, () => Partial<RunObservation>][] = [
      ['a message', () => ({ ...base, events: [stored(now(), { kind: 'message', text: 'Done with the parser' })] })],
      ['a tick', () => ({ ...base, events: [stored(now(), { kind: 'criterion_checked', index: 0, text: 'x' })] })],
      ['the turn ending', () => ({ live: live({ started: 31, inTurn: false }) })]
    ]
    for (const [, next] of closing) {
      scene = () => base
      await detector.check()
      expect(await episode()).toMatchObject({ rule: 'no_milestone' })
      await clock.advance(MIN)
      scene = next
      await detector.check()
      expect(await episode()).toBeNull()
    }
    // A commit: the head moves after the hit.
    scene = () => base
    await clock.advance(MIN)
    await detector.check()
    expect(await episode()).toMatchObject({ rule: 'no_milestone' })
    head = 'ccc'
    await clock.advance(MIN)
    await detector.check()
    expect(await episode()).toBeNull()
  })
})

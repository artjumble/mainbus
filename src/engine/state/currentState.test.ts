import { describe, expect, test } from 'vitest'
import type { Decision, Ticket, TicketState } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { currentState, type StateInput } from './currentState'

const ticket: Ticket = {
  id: 't-1',
  workspaceId: 'w-1',
  number: 5,
  kind: 'change',
  title: 'Add login',
  intent: [],
  spec: '',
  criteria: [],
  labels: [],
  manualColumn: 'backlog',
  branch: null,
  worktreePath: null,
  pr: null,
  prError: null,
  report: null,
  reportFile: null,
  reportCommit: null,
  reportFileError: null,
  promotedFrom: null,
  runSettings: null,
  setup: null,
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z'
}

function stored(seq: number, event: ThreadEvent): StoredEvent {
  return { runId: 'r-1', seq, at: '2026-10-30T10:00:00.000Z', event }
}

function pending(kind: Decision['kind'], question: string): Decision {
  return {
    id: 'd-1',
    deferredUntil: null,
    ticketId: 't-1',
    agentRunId: 'r-1',
    kind,
    question,
    request: null,
    options: [],
    recommended: null,
    allowAlways: true,
    status: 'pending',
    answer: null,
    createdAt: '2026-10-30T10:00:00.000Z',
    answeredAt: null,
    answeredBy: null,
    answeredVia: null
  }
}

const base: StateInput = {
  ticket,
  run: null,
  pendingDecisions: [],
  processAlive: false,
  activePhase: 'implementing'
}

/** `pausedByUser` is false unless a case says otherwise. */
const cases: Array<{ name: string; input: StateInput; expected: Omit<TicketState, 'pausedByUser' | 'deferredUntil'> & { pausedByUser?: true; deferredUntil?: string } }> = [
  {
    name: 'no run, manualColumn ready',
    input: { ...base, ticket: { ...ticket, manualColumn: 'ready' } },
    expected: { column: 'ready', phase: 'not_started', agentStatus: null, summary: null, canContinue: false }
  },
  {
    name: 'manualColumn done wins over a handoff run and a pending decision',
    input: {
      ...base,
      ticket: { ...ticket, manualColumn: 'done' },
      run: { endReason: 'handoff', events: [] },
      pendingDecisions: [pending('question', 'Which database?')]
    },
    expected: { column: 'done', phase: 'done', agentStatus: null, summary: null, canContinue: false }
  },
  {
    name: 'run ended with handoff',
    input: { ...base, run: { endReason: 'handoff', events: [] } },
    expected: {
      column: 'review',
      phase: 'ready_for_review',
      agentStatus: 'handed_off',
      summary: null,
      canContinue: false
    }
  },
  {
    name: 'pending question decision',
    input: { ...base, run: { endReason: null, events: [] }, pendingDecisions: [pending('question', 'Which database?')] },
    expected: {
      column: 'needs_you',
      phase: 'waiting_on_you',
      agentStatus: 'waiting_on_you',
      summary: 'Which database?',
      canContinue: false
    }
  },
  {
    name: 'pending permission decision',
    input: {
      ...base,
      run: { endReason: null, events: [] },
      pendingDecisions: [pending('permission', 'Implementer wants to run `pnpm install`')]
    },
    expected: {
      column: 'needs_you',
      phase: 'waiting_on_you',
      agentStatus: 'waiting_on_you',
      summary: 'Implementer wants to run `pnpm install`',
      canContinue: false
    }
  },
  {
    name: 'run ended with failed, last error event is "boom"',
    input: {
      ...base,
      run: {
        endReason: 'failed',
        events: [stored(1, { kind: 'error', message: 'first' }), stored(2, { kind: 'error', message: 'boom' })]
      }
    },
    expected: {
      column: 'needs_you',
      phase: 'implementing',
      agentStatus: 'failed',
      summary: 'Failed: boom',
      canContinue: false
    }
  },
  {
    name: 'run ended with failed, no error event, last failed turn_end has the error',
    input: {
      ...base,
      run: { endReason: 'failed', events: [stored(1, { kind: 'turn_end', ok: false, error: 'rate limited' })] }
    },
    expected: {
      column: 'needs_you',
      phase: 'implementing',
      agentStatus: 'failed',
      summary: 'Failed: rate limited',
      canContinue: false
    }
  },
  {
    name: 'run ended with failed, nothing to say',
    input: { ...base, run: { endReason: 'failed', events: [] } },
    expected: {
      column: 'needs_you',
      phase: 'implementing',
      agentStatus: 'failed',
      summary: 'Failed',
      canContinue: false
    }
  },
  {
    name: 'run ended with stopped, manualColumn ready',
    input: { ...base, ticket: { ...ticket, manualColumn: 'ready' }, run: { endReason: 'stopped', events: [] } },
    expected: { column: 'ready', phase: 'not_started', agentStatus: null, summary: null, canContinue: false }
  },
  {
    name: 'run ended with stopped, then moved to Backlog',
    input: { ...base, ticket: { ...ticket, manualColumn: 'backlog' }, run: { endReason: 'stopped', events: [] } },
    expected: { column: 'backlog', phase: 'not_started', agentStatus: null, summary: null, canContinue: false }
  },
  {
    name: 'run not ended, process not alive',
    input: { ...base, run: { endReason: null, events: [] }, processAlive: false },
    expected: { column: 'in_progress', phase: 'implementing', agentStatus: 'paused', summary: null, canContinue: true }
  },
  {
    name: 'run not ended, in the queue for a slot: queued, in progress, phase unchanged',
    input: { ...base, activePhase: 'testing', run: { endReason: null, events: [] }, processAlive: false, queuePosition: 2 },
    expected: { column: 'in_progress', phase: 'testing', agentStatus: 'queued', summary: null, canContinue: false, queuePosition: 2 }
  },
  {
    name: 'run not ended, paused by the usage limit: paused with the reason, and Continue is not offered',
    input: { ...base, run: { endReason: null, events: [] }, processAlive: false, limitPaused: { reason: 'Usage limit; resumes at 14:00' } },
    expected: {
      column: 'in_progress',
      phase: 'implementing',
      agentStatus: 'paused',
      summary: 'Usage limit; resumes at 14:00',
      canContinue: false,
      pausedByLimit: true
    }
  },
  {
    name: 'a pending decision wins over the usage limit pause',
    input: { ...base, run: { endReason: null, events: [] }, processAlive: false, limitPaused: { reason: 'Usage limit' }, pendingDecisions: [pending('question', 'Which API?')] },
    expected: { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', summary: 'Which API?', canContinue: false }
  },
  {
    name: 'a pause by the user wins over the usage limit pause',
    input: { ...base, run: { endReason: null, events: [stored(1, { kind: 'paused' })] }, processAlive: false, limitPaused: { reason: 'Usage limit' } },
    expected: { column: 'in_progress', phase: 'implementing', agentStatus: 'paused', summary: null, canContinue: false, pausedByUser: true }
  },
  {
    name: 'a pending decision wins over the queue',
    input: { ...base, run: { endReason: null, events: [] }, processAlive: false, queuePosition: 1, pendingDecisions: [pending('question', 'Which API?')] },
    expected: { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', summary: 'Which API?', canContinue: false }
  },
  {
    name: 'run not ended, process alive',
    input: { ...base, run: { endReason: null, events: [] }, processAlive: true },
    expected: { column: 'in_progress', phase: 'implementing', agentStatus: 'working', summary: null, canContinue: false }
  },
  {
    name: 'run ended with failed takes phase from activePhase',
    input: { ...base, activePhase: 'testing', run: { endReason: 'failed', events: [] } },
    expected: { column: 'needs_you', phase: 'testing', agentStatus: 'failed', summary: 'Failed', canContinue: false }
  },
  {
    name: 'run not ended, process not alive takes phase from activePhase',
    input: { ...base, activePhase: 'testing', run: { endReason: null, events: [] }, processAlive: false },
    expected: { column: 'in_progress', phase: 'testing', agentStatus: 'paused', summary: null, canContinue: true }
  },
  {
    // Never the latest in practice: the earlier role's run starts first. It must not read as Review or working.
    name: 'run handed back is paused mid-lineup',
    input: { ...base, run: { endReason: 'handed_back', events: [] }, processAlive: true },
    expected: { column: 'in_progress', phase: 'implementing', agentStatus: 'paused', summary: null, canContinue: true }
  },
  {
    name: 'run not ended, process alive takes phase from activePhase',
    input: { ...base, activePhase: 'testing', run: { endReason: null, events: [] }, processAlive: true },
    expected: { column: 'in_progress', phase: 'testing', agentStatus: 'working', summary: null, canContinue: false }
  },
  {
    name: 'paused by the user: paused with no Continue, even while the process is still going down',
    input: { ...base, run: { endReason: null, events: [stored(1, { kind: 'paused' })] }, processAlive: true },
    expected: {
      column: 'in_progress',
      phase: 'implementing',
      agentStatus: 'paused',
      summary: null,
      canContinue: false,
      pausedByUser: true
    }
  },
  {
    name: 'paused by the user and resumed since: working again',
    input: {
      ...base,
      run: { endReason: null, events: [stored(1, { kind: 'paused' }), stored(2, { kind: 'resumed' })] },
      processAlive: true
    },
    expected: { column: 'in_progress', phase: 'implementing', agentStatus: 'working', summary: null, canContinue: false }
  },
  {
    name: 'paused by the user with a question pending: the question wins',
    input: {
      ...base,
      run: { endReason: null, events: [stored(1, { kind: 'paused' })] },
      pendingDecisions: [pending('question', 'Which database?')]
    },
    expected: {
      column: 'needs_you',
      phase: 'waiting_on_you',
      agentStatus: 'waiting_on_you',
      summary: 'Which database?',
      canContinue: false
    }
  },
  {
    name: 'a deferred decision only: in progress, waiting on the user until its date, even with the process gone',
    input: {
      ...base,
      run: { endReason: null, events: [] },
      deferredDecisions: [
        { ...pending('question', 'Later one?'), status: 'deferred', deferredUntil: '2026-11-05T09:00:00.000Z' },
        { ...pending('question', 'Earlier one?'), id: 'd-2', status: 'deferred', deferredUntil: '2026-11-03T09:00:00.000Z' }
      ]
    },
    expected: {
      column: 'in_progress',
      phase: 'waiting_on_you',
      agentStatus: 'waiting_on_you',
      summary: 'Later one?',
      canContinue: false,
      deferredUntil: '2026-11-03T09:00:00.000Z'
    }
  },
  {
    name: 'a pending and a deferred decision: the pending one puts it in Needs you',
    input: {
      ...base,
      run: { endReason: null, events: [] },
      processAlive: true,
      pendingDecisions: [pending('question', 'Now?')],
      deferredDecisions: [{ ...pending('question', 'Later?'), id: 'd-2', status: 'deferred', deferredUntil: '2026-11-03T09:00:00.000Z' }]
    },
    expected: { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', summary: 'Now?', canContinue: false }
  },
  {
    name: 'a failed run with a deferred decision: failed wins',
    input: {
      ...base,
      run: { endReason: 'failed', events: [] },
      deferredDecisions: [{ ...pending('question', 'Later?'), status: 'deferred', deferredUntil: '2026-11-03T09:00:00.000Z' }]
    },
    expected: { column: 'needs_you', phase: 'implementing', agentStatus: 'failed', summary: 'Failed', canContinue: false }
  }
]

describe('currentState', () => {
  test.each(cases)('$name', ({ input, expected }) => {
    expect(currentState(input)).toEqual({ pausedByUser: false, deferredUntil: null, ...expected })
  })
})

describe('currentState while the setup command runs', () => {
  test('adds settingUp to whatever the state is, and nothing otherwise', () => {
    const running = currentState({ ...base, run: { endReason: null, events: [] }, processAlive: true, settingUp: true })
    expect(running).toMatchObject({ column: 'in_progress', agentStatus: 'working', settingUp: true })
    const ended = currentState({ ...base, run: { endReason: 'stopped', events: [] }, settingUp: true })
    expect(ended).toMatchObject({ column: 'backlog', agentStatus: null, settingUp: true })
    expect(currentState({ ...base, run: { endReason: null, events: [] }, processAlive: true })).not.toHaveProperty('settingUp')
  })
})

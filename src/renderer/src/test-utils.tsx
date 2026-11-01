import { MantineProvider } from '@mantine/core'
import { Notifications, notifications } from '@mantine/notifications'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import type { Decision, LineupRole, Ticket, TicketState, Workspace } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import type { BoardTicket } from './store'
import { cssVariablesResolver, theme } from './theme'

function Providers({ children }: { children: ReactNode }): ReactElement {
  // env="test" turns off transitions and portals, which jsdom cannot run.
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
      <Notifications />
      {children}
    </MantineProvider>
  )
}

/** Renders inside the app's MantineProvider, with the notification host mounted. */
export function renderWithMantine(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: Providers })
}

afterEach(() => {
  notifications.clean()
})

export const workspace: Workspace = {
  id: 'w1',
  name: 'mainbus',
  repoPath: 'C:\\repos\\mainbus',
  baseBranch: 'main',
  slug: 'mainbus',
  openPrOnReview: false
}

let counter = 0

export function makeTicket(overrides: Partial<Ticket> = {}, state: Partial<TicketState> = {}): BoardTicket {
  counter += 1
  return {
    id: `t${counter}`,
    workspaceId: 'w1',
    number: counter,
    kind: 'change',
    title: `Ticket ${counter}`,
    intent: [{ text: 'words', at: '2026-10-30T00:00:00.000Z' }],
    spec: '',
    criteria: [],
    labels: [],
    manualColumn: 'backlog',
    branch: null,
    worktreePath: null,
    pr: null,
    prError: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
    state: {
      column: 'backlog',
      phase: 'not_started',
      agentStatus: null,
      summary: null,
      canContinue: false,
      ...state
    }
  }
}

let seqCounter = 0

/** A stored (or, with seq 0, partial) thread event of run r1. */
export function makeEvent(event: ThreadEvent, overrides: Partial<StoredEvent> = {}): StoredEvent {
  seqCounter += 1
  return { runId: 'r1', seq: seqCounter, at: '2026-10-30T10:00:00.000Z', event, ...overrides }
}

export function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    ticketId: 't1',
    agentRunId: 'r1',
    kind: 'question',
    question: 'Which database?',
    options: ['SQLite', 'Postgres'],
    recommended: null,
    allowAlways: true,
    status: 'pending',
    answer: null,
    createdAt: '2026-10-30T10:00:00.000Z',
    answeredAt: null,
    ...overrides
  }
}

/** The default Change lineup, as `lineup.get` returns it for workspace w1. */
export function makeLineup(): LineupRole[] {
  const role = (id: string, position: number, name: string, extra: Partial<LineupRole>): LineupRole => ({
    id,
    workspaceId: 'w1',
    lineup: 'change',
    position,
    name,
    instructions: `Be the ${name}.`,
    activePhase: 'implementing',
    onProblem: 'hand_back',
    handBackTo: null,
    model: null,
    effort: null,
    toolProfile: 'read_only',
    ...extra
  })
  return [
    role('p', 1, 'Planner', { activePhase: 'planning', onProblem: 'ask_me' }),
    role('i', 2, 'Implementer', { handBackTo: 'p', toolProfile: 'edit' }),
    role('r', 3, 'Reviewer', { activePhase: 'reviewing', handBackTo: 'i' })
  ]
}

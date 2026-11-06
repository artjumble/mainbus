import { MantineProvider } from '@mantine/core'
import { Notifications, notifications } from '@mantine/notifications'
import axe from 'axe-core'
import { render, within, type RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import type { Decision, LineupRole, TicketState, Workspace } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import type { BoardTicket } from './store'
import { isThemeId, type ThemeId } from '../../shared/domain'
import { mantineThemes } from './theme'

/** The theme components are rendered in: Light, or another in its own test project (jsdom-dark, jsdom-night-owl, ...). */
export const testTheme: ThemeId = isThemeId(import.meta.env['MAINBUS_TEST_THEME']) ? import.meta.env['MAINBUS_TEST_THEME'] : 'light'
/** The colour scheme of that theme. */
export const testScheme = mantineThemes[testTheme].scheme

function Providers({ children }: { children: ReactNode }): ReactElement {
  const { theme, cssVariablesResolver } = mantineThemes[testTheme]
  // env="test" turns off transitions and portals, which jsdom cannot run.
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test" forceColorScheme={testScheme}>
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

/** A ticket on the board; its lineup strip is the default lineup, not started, unless `overrides` sets one. */
export function makeTicket(overrides: Partial<BoardTicket> = {}, state: Partial<TicketState> = {}): BoardTicket {
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
    report: null,
    promotedFrom: null,
    runSettings: null,
    runSettingsNotices: [],
    edits: [],
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    hold: null,
    stuck: null,
    attachments: [],
    lineup: makeLineup().map((r) => ({ id: r.id, name: r.name, status: 'not_started', active: false, replacements: 0 })),
    skipTo: null,
    pendingDecisions: [],
    deferredDecisions: [],
    ...overrides,
    state: {
      column: 'backlog',
      phase: 'not_started',
      agentStatus: null,
      summary: null,
      canContinue: false,
      pausedByUser: false,
      deferredUntil: null,
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
    deferredUntil: null,
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
    answeredBy: null,
    answeredVia: null,
    ...overrides
  }
}

/** A PNG's leading bytes and a little more: enough for the image check. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

export const pngFile = (name = 'shot.png'): File => new File([PNG_BYTES], name, { type: 'image/png' })
export const svgFile = (): File => new File(['<svg><script>alert(1)</script></svg>'], 'logo.svg', { type: 'image/svg+xml' })

/** A paste's or drop's data carrying `files` (and `text`), as jsdom has no DataTransfer. */
export function transfer(files: File[], text = ''): Partial<DataTransfer> {
  return {
    files: files as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
    getData: (type: string) => (type === 'text/plain' ? text : '')
  }
}

/** The text of each option of a native select, in order. */
export function optionLabels(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
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

/**
 * Fails when axe finds a violation in `container`. jsdom has no layout, so colour contrast is checked in the theme
 * test and the e2e axe run instead; `region` is off because a single component is not a page.
 *
 * One known Mantine finding is let through: an open Menu's dropdown holds a `role="presentation"` focus anchor
 * with a tabindex, which axe reports as aria-required-children on the menu. It is Mantine's own markup.
 */
export async function expectNoAxeViolations(
  container: Element = document.body,
  opts: { region?: boolean } = {}
): Promise<void> {
  // Run in every theme: make sure the scheme being checked is the one in use.
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', testScheme)
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: opts.region ?? false } }
  })
  const lines = results.violations.flatMap((v) => {
    const nodes = v.nodes.filter((n) => !(v.id === 'aria-required-children' && n.html.includes('data-menu-dropdown')))
    if (nodes.length === 0) return []
    const where = nodes.map((n) => `    ${n.target.join(' ')}: ${[...n.any, ...n.all].map((c) => c.message).join('; ')}`)
    return [[`${v.id}: ${v.help}`, ...where].join('\n')]
  })
  expect(lines, 'axe violations').toEqual([])
}

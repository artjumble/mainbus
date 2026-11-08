import { describe, expect, test, vi } from 'vitest'
import type { LineupPreset, LineupRole, Ticket, Workspace } from '../../shared/domain'
import type { CreateTicketsPayload } from '../../shared/proposals'
import { createInBacklog, createTickets } from './createTickets'
import { ProposalInvalid, type ExecContext } from './kind'

const MESSAGE = 'Please add two tickets.'

const ws: Workspace = {
  id: 'ws1',
  name: 'repo',
  repoPath: '/repo',
  baseBranch: 'main',
  slug: 'repo',
  openPrOnReview: false,
  saveReports: true,
  reportsFolder: 'docs/investigations',
  setupCommand: '',
  setupTimeoutMinutes: 15
}

const LINEUP = [
  { id: 'p', name: 'Planner', model: null, effort: null },
  { id: 'i', name: 'Implementer', model: null, effort: null },
  { id: 'r', name: 'Reviewer', model: null, effort: null }
] as LineupRole[]
const DOCS = {
  excludedRoleIds: ['p', 'r'],
  roles: { i: { model: 'sonnet', effort: 'medium' as const } },
  extraInstructions: null,
  roleNames: { p: 'Planner', i: 'Implementer', r: 'Reviewer' }
}
const presets: LineupPreset[] = [
  { id: 'a', workspaceId: ws.id, name: 'Full', settings: { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} } },
  { id: 'b', workspaceId: ws.id, name: 'Docs', settings: DOCS }
]
const source = async () => ({ presets, lineup: LINEUP })

const ctx = (extra: Partial<ExecContext> = {}) =>
  ({
    workspace: async () => ws,
    lineup: async () => LINEUP,
    presets: async () => presets,
    ticketByNumber: async () => null,
    orchestratorFolder: '/o',
    ...extra
  }) as unknown as ExecContext

const proposeWith = (input: unknown, c: ExecContext = ctx()) =>
  Promise.resolve(createTickets.propose(input, { userMessage: MESSAGE, workspaceId: ws.id }, c)) as Promise<CreateTicketsPayload>

const create = vi.fn(async (_ws: Workspace, inputs: { title: string }[]) => inputs.map((i, n) => ({ id: `n${n}`, number: n + 1, title: i.title }) as Ticket))
const created = (): Array<{ runSettings?: unknown }> => create.mock.calls.at(-1)![1] as Array<{ runSettings?: unknown }>

describe('create_tickets: preset', () => {
  test('is kept on the draft by name, and checked when proposed', async () => {
    const p = await proposeWith({ tickets: [{ title: 'A', preset: ' docs ' }, { title: 'B' }] })
    expect(p.tickets.map((t) => t.preset)).toEqual(['docs', undefined])
  })

  test('an unknown name is refused, naming the presets; so is a preset where there are none to look up', async () => {
    await expect(proposeWith({ tickets: [{ title: 'A' }, { title: 'B', preset: 'Nope' }] })).rejects.toThrow(
      'tickets.1.preset: there is no preset "Nope" in repo; its presets are Full, Docs'
    )
    await expect(proposeWith({ tickets: [{ title: 'A', preset: 'Docs' }] }, { workspace: async () => ws } as unknown as ExecContext)).rejects.toThrow('presets are not available here')
  })

  test('an Investigate draft with a preset is refused', async () => {
    await expect(proposeWith({ tickets: [{ title: 'A', kind: 'investigate', preset: 'Docs' }] })).rejects.toThrow(
      'tickets.0.preset: presets are for Change tickets'
    )
  })

  test('an override keeps the preset it sends', async () => {
    const stored = await proposeWith({ tickets: [{ title: 'A', preset: 'Docs' }] })
    expect(createTickets.override!(stored, { tickets: [{ title: 'A', preset: 'Docs' }], column: 'backlog' }).tickets[0]!.preset).toBe('Docs')
  })

  test('creating gives each ticket its preset settings (none for Full), and says so', async () => {
    const p = await proposeWith({ tickets: [{ title: 'A', preset: 'Docs' }, { title: 'B', preset: 'Full' }, { title: 'C' }] })
    const result = await createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, ctx({ createTickets: create }))
    expect(created()[0]!.runSettings).toEqual(DOCS)
    expect(created()[1]!.runSettings).toBeUndefined()
    expect(created()[2]!.runSettings).toBeUndefined()
    expect(createTickets.outcome(result)).toBe('Created #1 "A" (Docs preset), #2 "B" (Full preset) and #3 "C" in Backlog.')
  })

  test('a preset removed after the proposal fails the confirmation with the reason, creating nothing', async () => {
    create.mockClear()
    const p = await proposeWith({ tickets: [{ title: 'A', preset: 'Docs' }] })
    await expect(createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, ctx({ createTickets: create, presets: async () => [] }))).rejects.toThrow(
      'there is no preset "Docs" in repo; its presets are none'
    )
    expect(create).not.toHaveBeenCalled()
  })

  test('what a preset drops for a lineup that lacks the role comes back as notices', async () => {
    const p = await proposeWith({ tickets: [{ title: 'A', preset: 'Docs' }] })
    const noPlanner = LINEUP.filter((r) => r.id !== 'p')
    const result = await createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, ctx({ createTickets: create, lineup: async () => noPlanner }))
    expect(result.notices).toEqual(["Ticket 1: Planner isn't in this lineup, so the Docs preset's setting for it was dropped."])
    expect(createTickets.outcome(result)).toContain("Planner isn't in this lineup")
  })

  test('create_tickets in the Backlog takes it too, and refuses an unknown name creating nothing', async () => {
    const made = await createInBacklog({ tickets: [{ title: 'A', preset: 'Docs' }, { title: 'B' }] }, { userMessage: MESSAGE }, ws, create, '/o', undefined, source)
    expect(created()[0]!.runSettings).toEqual(DOCS)
    expect(made.presets).toEqual(['Docs', undefined])
    create.mockClear()
    await expect(createInBacklog({ tickets: [{ title: 'A', preset: 'Nope' }] }, { userMessage: MESSAGE }, ws, create, '/o', undefined, source)).rejects.toThrow(
      ProposalInvalid
    )
    await expect(createInBacklog({ tickets: [{ title: 'A', preset: 'Docs' }] }, { userMessage: MESSAGE }, ws, create, '/o')).rejects.toThrow(ProposalInvalid)
    expect(create).not.toHaveBeenCalled()
  })
})

import { z } from 'zod'
import type { RoleControlPayload, RoleControlResult } from '../../shared/proposals'
import { parsePayload, ProposalInvalid, type ActiveRole, type ExecContext, type ProposalKind } from './kind'

type Control = 'pause' | 'stop' | 'skip'

const proposeSchema = z.strictObject({ ticket: z.number().int().positive() })

interface ControlSpec {
  label: string
  /** Why the ticket's active role can't have this done to it now, or null. */
  whyNot(number: number, active: ActiveRole | null): string | null
  act(ctx: ExecContext, ticketId: string, expect: { agentRunId: string }): Promise<void>
  /** What the action did, for the orchestrator. */
  outcome(r: RoleControlResult): string
}

const SPECS: Record<Control, ControlSpec> = {
  pause: {
    label: 'pause a role',
    whyNot: (n, a) => (a?.agentStatus === 'working' ? null : `#${n} has no working role to pause`),
    act: (ctx, id, expect) => ctx.pauseTicket(id, expect),
    outcome: (r) => `Paused the ${r.role} on #${r.number} ${JSON.stringify(r.title)}; Resume continues it.`
  },
  stop: {
    label: 'stop a run',
    whyNot: (n, a) => (a ? null : `#${n} has no run to stop`),
    act: (ctx, id, expect) => ctx.stopTicket(id, expect),
    outcome: (r) => `Stopped the run on #${r.number} ${JSON.stringify(r.title)} (the ${r.role} was active); it is back in Ready.`
  },
  skip: {
    label: 'skip a role',
    // Like the ticket view's Skip: any active role of an open run, working or not.
    whyNot: (n, a) => (a ? null : `#${n} has no working role to skip`),
    act: (ctx, id, expect) => ctx.skipTicket(id, expect),
    outcome: (r) =>
      `Skipped the ${r.role} on #${r.number} ${JSON.stringify(r.title)}; its work so far was summarised for ` +
      (r.next ? `the ${r.next}, who started.` : `the next step: #${r.number} is in Review.`)
  }
}

const DONE: Record<Control, string> = { pause: 'paused', stop: 'stopped', skip: 'skipped' }

function make(control: Control): ProposalKind<RoleControlPayload, RoleControlResult> {
  const spec = SPECS[control]
  return {
    label: spec.label,
    atomicWithResult: false,
    evidenceKey: 'reason',
    evidenceRequired: true,

    async propose(input, turn, ctx) {
      const p = parsePayload(proposeSchema, input)
      const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
      if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
      const active = await ctx.activeRole(ticket)
      const why = spec.whyNot(ticket.number, active)
      if (why !== null || !active) throw new ProposalInvalid(`ticket: ${why ?? 'it has no active role'}`)
      return {
        ticketId: ticket.id,
        number: ticket.number,
        title: ticket.title,
        agentRunId: active.agentRunId,
        role: active.role,
        next: control === 'skip' ? active.next : null
      }
    },

    async execute(p, target, ctx) {
      const ws = await ctx.workspace(target.workspaceId)
      if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
      const ticket = await ctx.ticketByNumber(ws.id, p.number)
      if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
      const active = await ctx.activeRole(ticket)
      const nothing = `Nothing was ${DONE[control]}.`
      if (!active || active.agentRunId !== p.agentRunId) {
        const now = active ? `now: the ${active.role}` : 'the run has ended'
        throw new Error(`#${p.number} has moved on since this was proposed: the ${p.role} is no longer its active role (${now}). ${nothing}`)
      }
      const why = spec.whyNot(p.number, active)
      if (why !== null) {
        throw new Error(`The ${p.role} on #${p.number} is no longer ${active.agentStatus === 'working' ? 'eligible' : active.agentStatus} (${why}). ${nothing}`)
      }
      await spec.act(ctx, p.ticketId, { agentRunId: p.agentRunId })
      // The next role as it is now, which is the one that starts.
      return { ticketId: p.ticketId, number: p.number, title: p.title, role: p.role, next: control === 'skip' ? active.next : null }
    },

    outcome: spec.outcome
  }
}

export const pause = make('pause')
export const stop = make('stop')
export const skip = make('skip')

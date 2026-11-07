import { z } from 'zod'
import type { Effort } from '../../shared/domain'
import {
  EFFORTS,
  EXTRA_INSTRUCTIONS_MAX,
  MODEL_OPTIONS,
  modelAllowed,
  resolveModelEffort,
  sameRoleName
} from '../../shared/models'
import type { StartLineupPayload, StartLineupResult, StartRolePlan } from '../../shared/proposals'
import { applyRunSettings } from '../../shared/runSettings'
import { notDoneYetText } from '../../shared/dependencies'
import { listJoin } from './createTickets'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

const MODELS = MODEL_OPTIONS.map((o) => o.value) as [string, ...string[]]
const effortSchema = z.enum(EFFORTS as [Effort, ...Effort[]])
const extraSchema = z.string().max(EXTRA_INSTRUCTIONS_MAX, `must be at most ${EXTRA_INSTRUCTIONS_MAX} characters`)

const proposeSchema = z.strictObject({
  ticket: z.number().int().positive(),
  roles: z
    .array(z.strictObject({ role: z.string().min(1), model: z.enum(MODELS).optional(), effort: effortSchema.optional() }))
    .min(1, 'must have at least 1 role')
    .optional(),
  extraInstructions: extraSchema.optional()
})

const overrideSchema = z.strictObject({
  roles: z
    .array(z.strictObject({ roleId: z.string(), model: z.string(), effort: effortSchema }))
    .min(1, 'tick at least one role'),
  extraInstructions: extraSchema.default('')
})

/** Trimmed, or null when blank. */
function extraText(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** "Planner (opus, high), Implementer (sonnet, medium)". */
function rolesText(roles: { name: string; model: string; effort: Effort }[]): string {
  return listJoin(roles.map((r) => `${r.name} (${r.model}, ${r.effort})`))
}

/**
 * Starting a ticket with some or all of the lineup's roles, each with a model and effort. Each role's model and
 * effort are resolved when proposed (the ticket's saved run settings, else its own lineup setting, else the
 * orchestrator's choice, else the defaults) and stored, so the card shows exactly what will run.
 */
export const startLineup: ProposalKind<StartLineupPayload, StartLineupResult> = {
  label: 'start a ticket',
  atomicWithResult: false,
  evidenceKey: 'reason',

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    const why = await ctx.whyNotStartable(ticket)
    if (why !== null) throw new ProposalInvalid(`ticket: ${why}`)
    const open = (await ctx.openBlockers?.(ticket)) ?? []
    const userAsked = turn.origin === 'drag' || turn.origin === 'button'
    if (open.length > 0 && !userAsked) {
      const names = open.map((b) => `#${b.number} ${JSON.stringify(b.title)}`).join(', ')
      throw new ProposalInvalid(
        `ticket: #${ticket.number} is blocked by ${names}, which ${open.length === 1 ? "isn't" : "aren't"} Done; don't propose starting it until its blockers are Done`
      )
    }
    const lineup = await ctx.lineup(turn.workspaceId, ticket.kind)
    if (lineup.length === 0) throw new ProposalInvalid('roles: this workspace has no roles')

    const chosen = new Map<string, { model?: string; effort?: Effort }>()
    const listed: { role: string; model?: string; effort?: Effort }[] = p.roles ?? lineup.map((role) => ({ role: role.name }))
    for (const r of listed) {
      const role = lineup.find((l) => sameRoleName(l.name, r.role))
      if (!role) {
        const names = lineup.map((l) => JSON.stringify(l.name)).join(', ')
        throw new ProposalInvalid(`roles: there is no role ${JSON.stringify(r.role)} in the lineup; its roles are ${names}`)
      }
      if (chosen.has(role.id)) throw new ProposalInvalid(`roles: ${role.name} is listed twice`)
      chosen.set(role.id, r)
    }

    // The user's saved run settings win: their roles run (the orchestrator's list only gives those roles a model and
    // effort), and their model, effort and extra instructions beat the orchestrator's.
    const saved = applyRunSettings(ticket.runSettings, lineup).options
    const runs = (id: string): boolean => (saved.roleIds ? saved.roleIds.includes(id) : chosen.has(id))

    // In lineup order, whatever order the orchestrator listed them in.
    const roles: StartRolePlan[] = lineup
      .filter((role) => runs(role.id))
      .map((role) => {
        const resolved = resolveModelEffort(role, { user: saved.roles?.[role.id], proposed: chosen.get(role.id) })
        return { roleId: role.id, name: role.name, ...resolved }
      })
    const extraInstructions = saved.extraInstructions ?? extraText(p.extraInstructions)
    return {
      ticketId: ticket.id,
      number: ticket.number,
      title: ticket.title,
      roles,
      extraInstructions,
      // The user asked for it: the card says it is blocked, and confirming starts it anyway.
      ...(open.length > 0 ? { blockedBy: open.map((b) => ({ number: b.number, title: b.title })) } : {})
    }
  },

  override(stored, input) {
    const o = parsePayload(overrideSchema, input)
    const seen = new Set<string>()
    for (const r of o.roles) {
      const plan = stored.roles.find((s) => s.roleId === r.roleId)
      if (!plan) throw new ProposalInvalid(`roles: ${JSON.stringify(r.roleId)} is not a role of this proposal`)
      if (seen.has(r.roleId)) throw new ProposalInvalid(`roles: ${plan.name} is listed twice`)
      seen.add(r.roleId)
      if (!modelAllowed(plan, r.model)) throw new ProposalInvalid(`roles: ${plan.name} has an unknown model`)
    }
    return {
      ...stored,
      // In the proposal's order, which is the lineup's.
      roles: stored.roles
        .filter((s) => seen.has(s.roleId))
        .map((s) => {
          const r = o.roles.find((x) => x.roleId === s.roleId)!
          return { ...s, model: r.model, effort: r.effort, source: 'user' }
        }),
      extraInstructions: extraText(o.extraInstructions)
    }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace(target.workspaceId)
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    const why = await ctx.whyNotStartable(ticket)
    if (why !== null) throw new Error(why)
    const open = (await ctx.openBlockers?.(ticket)) ?? []
    if (open.length > 0 && p.blockedBy === undefined) {
      throw new Error(`#${ticket.number} is blocked now: ${notDoneYetText(open)}`)
    }
    // The values on the card go in as the user's choice for this start, so the run uses exactly them even if
    // a role's own setting changed since; they are not resolved again.
    await ctx.startTicket(p.ticketId, {
      roleIds: p.roles.map((r) => r.roleId),
      roles: Object.fromEntries(p.roles.map((r) => [r.roleId, { model: r.model, effort: r.effort }])),
      ...(p.extraInstructions !== null ? { extraInstructions: p.extraInstructions } : {})
    })
    return {
      ticketId: p.ticketId,
      number: p.number,
      title: p.title,
      roles: p.roles.map((r) => ({ name: r.name, model: r.model, effort: r.effort }))
    }
  },

  outcome(r) {
    return `Started #${r.number} ${JSON.stringify(r.title)} with ${rolesText(r.roles)}.`
  }
}

import type { EngineEvent } from '../../shared/api'
import type { Decision, IntentAddition } from '../../shared/domain'
import type { AnswerPayload, Proposal, ProposalFailure, ProposalKindName, ProposalOrigin } from '../../shared/proposals'
import { oneLine } from '../roles/prompt'
import type { ProposalRepo } from '../store/proposals'
import { whyNotPending } from './answer'
import { ProposalInvalid, type ExecContext, type ProposalKind } from './kind'
import { KINDS } from './registry'

export const EVIDENCE_MAX = 5_000

export const QUIT_ATOMIC_ERROR = 'Mainbus quit before carrying this out; nothing was created.'
export const QUIT_PARTIAL_ERROR = 'Mainbus quit while carrying this out; it may have partly happened. Check the board.'

export const NO_OVERRIDE = 'This proposal has nothing to change'

export const OUTCOME_HEADING = '[Mainbus] Since your last turn, the user decided on your proposals:'

export interface ProposalServiceDeps {
  repo: ProposalRepo
  emit: (e: EngineEvent) => void
  exec: ExecContext
  /** The kinds by name; tests may pass their own. */
  kinds?: Record<ProposalKindName, ProposalKind<unknown, unknown>>
}

/** `existing`: an equal proposal was already pending, and is returned as it is; nothing was stored. */
export type ProposeResult = { ok: true; proposal: Proposal; existing?: true } | { ok: false; error: string }

export interface ProposalService {
  /**
   * Validates and stores a pending proposal; an invalid one stores nothing and says why. A proposal for a ticket whose
   * kind already has one pending (an answer: the same decision) is not stored again: the pending one is returned.
   */
  propose(
    kind: ProposalKindName,
    input: unknown,
    at: { workspaceId: string; orchestratorRunId: string; userMessage: string | null; followUps?: IntentAddition[]; origin?: ProposalOrigin }
  ): Promise<ProposeResult>
  /**
   * Confirms a pending proposal (overridden when `override` is given) and carries it out. An invalid override
   * or a proposal no longer pending throws, changing nothing. A failure while carrying it out is not thrown: the
   * proposal comes back failed, with the error as its result.
   */
  confirm(id: string, override?: unknown): Promise<Proposal>
  /** Throws unless the proposal is still pending. */
  reject(id: string): Promise<Proposal>
  list(): Promise<Proposal[]>
  /**
   * A decision left pending (answered elsewhere, or deferred): every answer proposal still waiting on it fails
   * with why, so its card becomes a receipt rather than a live one that could answer twice.
   */
  decisionSettled(decision: Decision): Promise<void>
  /**
   * At startup: fails every proposal claimed with no result, since Mainbus quit while carrying it out. The error
   * says nothing was created for a kind whose result is recorded atomically, else that it may have partly happened.
   */
  failUnfinished(): Promise<void>
  /**
   * For the start of the orchestrator's next message: each proposal decided at or after `since` (every decided
   * one when null) and how it went. Null when there are none.
   */
  outcomeBlock(since: string | null): Promise<string | null>
}

/** The error for the user's receipt: a failed query's own cause, not the SQL and its parameters drizzle wraps it in. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.message.startsWith('Failed query:') && err.cause instanceof Error) return err.cause.message
  return err.message
}

/** Takes the optional evidence (the `key` field) off the orchestrator's input; the rest is the kind's payload. */
function splitEvidence(input: unknown, key: string): { evidence: string | null; payload: unknown } {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !Object.hasOwn(input, key)) {
    return { evidence: null, payload: input }
  }
  const { [key]: evidence, ...payload } = input as Record<string, unknown>
  if (evidence === undefined || evidence === null) return { evidence: null, payload }
  if (typeof evidence !== 'string') throw new ProposalInvalid(`${key}: must be text`)
  if (evidence.length > EVIDENCE_MAX) throw new ProposalInvalid(`${key}: must be at most ${EVIDENCE_MAX} characters`)
  return { evidence: evidence.trim() === '' ? null : evidence, payload }
}

export function createProposalService(deps: ProposalServiceDeps): ProposalService {
  const kinds = deps.kinds ?? (KINDS as Record<ProposalKindName, ProposalKind<unknown, unknown>>)

  function kindOf(name: string): ProposalKind<unknown, unknown> {
    if (!Object.hasOwn(kinds, name)) throw new Error(`Unknown kind of proposal: ${name}`)
    return kinds[name as ProposalKindName]
  }

  function changed(proposal: Proposal): Proposal {
    deps.emit({ type: 'proposal.changed', proposal })
    return proposal
  }

  function describe(p: Proposal): string {
    const kind = kindOf(p.kind)
    const by =
      p.origin === 'drag'
        ? ', made by the user dragging the card into In progress'
        : p.origin === 'button'
          ? ', made by the user pressing Replace… on the ticket'
          : ''
    const head = `- Proposal ${p.id} (${kind.label}${by})`
    switch (p.status) {
      case 'rejected':
        return `${head}: rejected by the user.`
      case 'failed':
        return `${head}: the user confirmed it, but it failed: ${oneLine((p.result as ProposalFailure).error)}`
      case 'confirmed':
      case 'overridden': {
        const how = p.status === 'confirmed' ? 'confirmed by the user' : 'changed by the user, then confirmed'
        const outcome = p.result === null ? 'Mainbus is still carrying it out.' : kind.outcome(p.result)
        return `${head}: ${how}. ${outcome}`
      }
      default:
        return `${head}: still waiting for the user.`
    }
  }

  /** The pending proposal of this kind on the payload's ticket (for an answer, on its decision), if any; kinds with no ticket never match. */
  async function pendingEqual(name: ProposalKindName, payload: unknown): Promise<Proposal | undefined> {
    const target = payload as { ticketId?: string; decisionId?: string }
    if (typeof target?.ticketId !== 'string') return undefined
    return (await deps.repo.list()).find((p) => {
      if (p.status !== 'pending' || p.kind !== name) return false
      const stored = p.payload as { ticketId?: string; decisionId?: string }
      return stored.ticketId === target.ticketId && (name !== 'answer' || stored.decisionId === target.decisionId)
    })
  }

  return {
    async propose(name, input, at) {
      const kind = kindOf(name)
      let payload: unknown
      let evidence: string | null
      try {
        const split = splitEvidence(input, kind.evidenceKey ?? 'evidence')
        evidence = split.evidence
        if (kind.evidenceRequired && evidence === null) throw new ProposalInvalid(`${kind.evidenceKey ?? 'evidence'}: required`)
        const turn = {
          userMessage: at.userMessage,
          workspaceId: at.workspaceId,
          ...(at.followUps?.length ? { followUps: at.followUps } : {}),
          ...(at.origin ? { origin: at.origin } : {})
        }
        payload = await kind.propose(split.payload, turn, deps.exec)
      } catch (err) {
        if (err instanceof ProposalInvalid) return { ok: false, error: err.message }
        throw err
      }
      const pending = await pendingEqual(name, payload)
      if (pending) return { ok: true, proposal: pending, existing: true }
      const proposal = await deps.repo.create({
        workspaceId: at.workspaceId,
        orchestratorRunId: at.orchestratorRunId,
        kind: name,
        origin: at.origin ?? 'orchestrator',
        payload,
        evidence
      })
      return { ok: true, proposal: changed(proposal) }
    },

    async confirm(id, override) {
      const stored = await deps.repo.get(id)
      const kind = kindOf(stored.kind)
      // Validated before claiming, so an invalid override leaves the proposal pending.
      if (override !== undefined && !kind.override) throw new ProposalInvalid(NO_OVERRIDE)
      const payload = override === undefined ? stored.payload : kind.override!(stored.payload, override, deps.exec.now())
      const claimed = changed(await deps.repo.claim(id, override === undefined ? 'confirmed' : 'overridden'))
      try {
        const result = await kind.execute(payload, { workspaceId: claimed.workspaceId, proposalId: id }, deps.exec)
        return changed(await deps.repo.finish(id, result))
      } catch (err) {
        return changed(await deps.repo.fail(id, errorText(err)))
      }
    },

    async reject(id) {
      return changed(await deps.repo.reject(id))
    },

    list: () => deps.repo.list(),

    async decisionSettled(decision) {
      const why = whyNotPending(decision, deps.exec.now())
      if (why === null) return
      for (const p of await deps.repo.list()) {
        if (p.kind !== 'answer' || p.status !== 'pending' || (p.payload as AnswerPayload).decisionId !== decision.id) continue
        const failed = await deps.repo.failPending(p.id, why)
        if (failed) changed(failed)
      }
    },

    async failUnfinished() {
      for (const p of await deps.repo.unfinished()) {
        await deps.repo.fail(p.id, kindOf(p.kind).atomicWithResult ? QUIT_ATOMIC_ERROR : QUIT_PARTIAL_ERROR)
      }
    },

    async outcomeBlock(since) {
      const decided = await deps.repo.decidedSince(since)
      if (decided.length === 0) return null
      return [OUTCOME_HEADING, ...decided.map(describe)].join('\n')
    }
  }
}

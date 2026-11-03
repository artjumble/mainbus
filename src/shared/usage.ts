// Shared by the engine and the renderer: pure functions only, no Node imports.
import type { UsageState } from './domain'
import { clockTime } from './waiting'

type Limited = Extract<UsageState, { kind: 'limited' }>

/** Why an agent is paused: "Usage limit; resumes at 14:00", or when the reset is unknown, when Mainbus tries again. */
export function usagePauseReason(state: Limited): string {
  if (state.resetsAt !== null) return `Usage limit; resumes at ${clockTime(state.resetsAt)}`
  return state.retryAt !== null ? `Usage limit; trying again at ${clockTime(state.retryAt)}` : 'Usage limit; resumes when it resets'
}

/** The banner's text; empty when nothing is wrong. */
export function usageBannerText(state: UsageState): string {
  if (state.kind === 'limited') {
    const agents = `${state.paused} ${state.paused === 1 ? 'agent' : 'agents'}`
    if (state.resetsAt !== null) return `Usage limit reached. ${agents} paused; resuming at ${clockTime(state.resetsAt)}.`
    const retry = state.retryAt !== null ? `trying again at ${clockTime(state.retryAt)}` : 'trying again soon'
    return `Usage limit reached. ${agents} paused; ${retry}.`
  }
  if (state.kind === 'warning') {
    return state.resetsAt !== null
      ? `Close to the usage limit: new agents wait until it resets at ${clockTime(state.resetsAt)}.`
      : 'Close to the usage limit: new agents wait until it resets.'
  }
  return ''
}

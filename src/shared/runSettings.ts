// Shared by the engine and the renderer: no Node imports.
import type { Effort, LineupRole, RunSettings, RunSettingsInput, StartOptions } from './domain'
import { EFFORTS, EXTRA_INSTRUCTIONS_MAX, modelAllowed, modelLabel, resolveModelEffort } from './models'

/** One role of a start being chosen: whether it runs, and with which model and effort. */
export interface RoleChoice {
  roleId: string
  name: string
  ticked: boolean
  model: string
  effort: Effort
}

type Role = Pick<LineupRole, 'id' | 'name' | 'model' | 'effort'>

/** What a ticket's saved run settings come to against its lineup as it is now. */
export interface AppliedRunSettings {
  /** The start they make: empty when nothing is saved, so the lineup's defaults run. */
  options: StartOptions
  /** What was dropped because the lineup changed since they were saved, one sentence each. */
  notices: string[]
  /** The saved settings without what was dropped; null when nothing is saved. */
  effective: RunSettings | null
}

/**
 * Applies saved run settings to the lineup: every role runs but the excluded ones (so a role added later runs), in
 * lineup order, with the saved model and effort of each. A saved role that has left the lineup, a model it no longer
 * allows or an unknown effort is dropped with a notice; if every role is left out, the whole lineup runs.
 */
export function applyRunSettings(saved: RunSettings | null, lineup: Role[]): AppliedRunSettings {
  if (saved === null) return { options: {}, notices: [], effective: null }
  const notices: string[] = []
  const inLineup = new Set(lineup.map((r) => r.id))
  const gone = [...new Set([...saved.excludedRoleIds, ...Object.keys(saved.roles)])].filter((id) => !inLineup.has(id))
  for (const id of gone) {
    const name = saved.roleNames[id] ?? 'A role'
    notices.push(`${name} is no longer in the lineup, so its saved setting was dropped.`)
  }

  let excluded = saved.excludedRoleIds.filter((id) => inLineup.has(id))
  if (lineup.length > 0 && excluded.length >= lineup.length) {
    notices.push('Every role in the lineup was left out, so the whole lineup runs.')
    excluded = []
  }

  const roles: RunSettings['roles'] = {}
  for (const role of lineup) {
    const choice = saved.roles[role.id]
    if (!choice) continue
    const kept: { model?: string; effort?: Effort } = {}
    if (choice.model !== undefined) {
      if (modelAllowed(role, choice.model)) kept.model = choice.model
      else notices.push(`${role.name}'s saved model ${modelLabel(choice.model)} is no longer available, so it uses the default.`)
    }
    if (choice.effort !== undefined) {
      if (EFFORTS.includes(choice.effort)) kept.effort = choice.effort
      else notices.push(`${role.name}'s saved effort ${choice.effort} is no longer available, so it uses the default.`)
    }
    if (kept.model !== undefined || kept.effort !== undefined) roles[role.id] = kept
  }

  const effective: RunSettings = { ...saved, excludedRoleIds: excluded, roles }
  const runIds = lineup.filter((r) => !excluded.includes(r.id)).map((r) => r.id)
  const runRoles = Object.fromEntries(Object.entries(roles).filter(([id]) => runIds.includes(id)))
  const options: StartOptions = {
    roleIds: runIds,
    ...(Object.keys(runRoles).length > 0 ? { roles: runRoles } : {}),
    ...(saved.extraInstructions !== null ? { extraInstructions: saved.extraInstructions } : {})
  }
  return { options, notices, effective }
}

/** A saved choice as words: "Opus, high", "Opus", "high effort". */
function choiceText(choice: { model?: string; effort?: Effort }): string {
  if (choice.model !== undefined && choice.effort !== undefined) return `${modelLabel(choice.model)}, ${choice.effort}`
  if (choice.model !== undefined) return modelLabel(choice.model)
  return `${choice.effort} effort`
}

/**
 * Run settings in one line, from the start they make: "Planner, Implementer · Implementer on Opus, high", with
 * " · extra instructions" when there are some. "Lineup defaults" when nothing is saved.
 */
export function runSettingsSummary(options: StartOptions, lineup: Pick<LineupRole, 'id' | 'name'>[]): string {
  if (options.roleIds === undefined) return 'Lineup defaults'
  const run = lineup.filter((r) => options.roleIds!.includes(r.id))
  const parts = [run.map((r) => r.name).join(', ')]
  const chosen = run.filter((r) => options.roles?.[r.id] !== undefined)
  if (chosen.length > 0) parts.push(chosen.map((r) => `${r.name} on ${choiceText(options.roles![r.id]!)}`).join(', '))
  if (options.extraInstructions !== undefined) parts.push('extra instructions')
  return parts.join(' · ')
}

/** The form's choices for saved run settings: each role ticked unless excluded, with its saved model and effort, else its usual ones. */
export function choicesFromSettings(lineup: Role[], saved: RunSettings | null): RoleChoice[] {
  const effective = applyRunSettings(saved, lineup).effective
  return lineup.map((role) => {
    const { model, effort } = resolveModelEffort(role, { user: effective?.roles[role.id] })
    return { roleId: role.id, name: role.name, ticked: !(effective?.excludedRoleIds.includes(role.id) ?? false), model, effort }
  })
}

/**
 * The run settings the form's choices save. Only a model or effort that differs from what the role runs with anyway
 * is kept, so one left as it was follows later lineup edits (and the orchestrator may still choose it).
 */
export function inputFromChoices(choices: RoleChoice[], lineup: Role[], extraInstructions: string): RunSettingsInput {
  const roles: RunSettingsInput['roles'] = {}
  for (const choice of choices) {
    const role = lineup.find((r) => r.id === choice.roleId)
    if (!role || !choice.ticked) continue
    const usual = resolveModelEffort(role)
    const kept = {
      ...(choice.model !== usual.model ? { model: choice.model } : {}),
      ...(choice.effort !== usual.effort ? { effort: choice.effort } : {})
    }
    if (kept.model !== undefined || kept.effort !== undefined) roles[role.id] = kept
  }
  return { excludedRoleIds: choices.filter((c) => !c.ticked).map((c) => c.roleId), roles, extraInstructions }
}

/**
 * Checks run settings against the ticket's lineup and returns them as stored: the role names filled in, the extra
 * instructions trimmed (null when blank). Throws a message for the user when they aren't valid.
 */
export function checkRunSettings(input: RunSettingsInput, lineup: Role[]): RunSettings {
  if (typeof input !== 'object' || input === null) throw new Error('The run settings are not valid')
  const { excludedRoleIds, roles, extraInstructions } = input
  const byId = new Map(lineup.map((r) => [r.id, r]))
  if (!Array.isArray(excludedRoleIds) || excludedRoleIds.some((id) => typeof id !== 'string')) {
    throw new Error('The roles left out are not valid')
  }
  const unknown = excludedRoleIds.find((id) => !byId.has(id))
  if (unknown !== undefined) throw new Error(`There is no role ${JSON.stringify(unknown)} in this lineup`)
  const excluded = [...new Set(excludedRoleIds)]
  if (excluded.length >= lineup.length) throw new Error('At least one role must run')
  if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) throw new Error('The roles are not valid')
  const kept: RunSettings['roles'] = {}
  for (const [id, choice] of Object.entries(roles)) {
    const role = byId.get(id)
    if (!role) throw new Error(`There is no role ${JSON.stringify(id)} in this lineup`)
    const { model, effort } = (choice ?? {}) as { model?: unknown; effort?: unknown }
    if (model !== undefined && (typeof model !== 'string' || !modelAllowed(role, model))) {
      throw new Error(`${role.name} has an unknown model: ${JSON.stringify(model)}`)
    }
    if (effort !== undefined && !EFFORTS.includes(effort as Effort)) {
      throw new Error(`${role.name} has an unknown effort: ${JSON.stringify(effort)}`)
    }
    if (model === undefined && effort === undefined) continue
    kept[id] = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort: effort as Effort } : {}) }
  }
  if (typeof extraInstructions !== 'string') throw new Error('Extra instructions must be text')
  if (extraInstructions.length > EXTRA_INSTRUCTIONS_MAX) {
    throw new Error(`Extra instructions must be at most ${EXTRA_INSTRUCTIONS_MAX} characters`)
  }
  const named = new Set([...excluded, ...Object.keys(kept)])
  return {
    excludedRoleIds: excluded,
    roles: kept,
    extraInstructions: extraInstructions.trim() === '' ? null : extraInstructions.trim(),
    roleNames: Object.fromEntries(lineup.filter((r) => named.has(r.id)).map((r) => [r.id, r.name]))
  }
}

// Shared by the engine and the renderer: no Node imports.
import type { Effort, LineupRole } from './domain'

/** Every effort the `claude` binary accepts. */
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The model aliases the `claude` binary accepts, as offered in the app. */
export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

/** A model a start may choose for `role`: one of MODEL_OPTIONS, or the role's own setting, which may be any alias. */
export function modelAllowed(role: Pick<LineupRole, 'model'>, model: string): boolean {
  return MODEL_OPTIONS.some((o) => o.value === model) || model === role.model
}

/** The efforts offered in the app's selects. */
export const EFFORT_OPTIONS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

/** The most extra instructions a start may carry. */
export const EXTRA_INSTRUCTIONS_MAX = 10_000

export interface ModelEffort {
  model: string
  effort: Effort
}

/** The model and effort a role runs with when nobody chose one, by role name. */
export const DEFAULT_MODELS: { name: string; model: string; effort: Effort }[] = [
  { name: 'Planner', model: 'opus', effort: 'high' },
  { name: 'Reviewer', model: 'opus', effort: 'medium' },
  { name: 'Implementer', model: 'sonnet', effort: 'medium' }
]

/** For any role not in DEFAULT_MODELS. */
export const OTHER_ROLE_DEFAULT: ModelEffort = { model: 'sonnet', effort: 'medium' }

/** The same role name, ignoring case and surrounding spaces. */
export function sameRoleName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The default table's model and effort for a role of this name. */
export function defaultFor(roleName: string): ModelEffort {
  const row = DEFAULT_MODELS.find((d) => sameRoleName(d.name, roleName))
  return row ? { model: row.model, effort: row.effort } : { ...OTHER_ROLE_DEFAULT }
}

/** Where a role's model or effort came from, highest precedence first. */
export type ModelSource = 'user' | 'role' | 'orchestrator' | 'default'

/** A label for a model value: its option label, or the value itself. */
export function modelLabel(model: string): string {
  return MODEL_OPTIONS.find((o) => o.value === model)?.label ?? model
}

/** A label for an effort value: "Low", "Xhigh"… */
export function effortLabel(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * The model and effort a role runs with. Each resolves on its own: the user's choice for this start, else the
 * role's own lineup setting, else the orchestrator's proposal, else the default table. `source` is the model's.
 */
export function resolveModelEffort(
  role: Pick<LineupRole, 'name' | 'model' | 'effort'>,
  choices: { user?: Partial<ModelEffort>; proposed?: Partial<ModelEffort> } = {}
): ModelEffort & { source: ModelSource } {
  const fallback = defaultFor(role.name)
  const pick = <T>(user: T | undefined, own: T | null, proposed: T | undefined, def: T): [T, ModelSource] =>
    user !== undefined
      ? [user, 'user']
      : own !== null
        ? [own, 'role']
        : proposed !== undefined
          ? [proposed, 'orchestrator']
          : [def, 'default']
  const [model, source] = pick(choices.user?.model, role.model, choices.proposed?.model, fallback.model)
  const [effort] = pick(choices.user?.effort, role.effort, choices.proposed?.effort, fallback.effort)
  return { model, effort, source }
}

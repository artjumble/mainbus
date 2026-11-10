// Shared by the engine and the renderer: no Node imports.
import type { Effort, LineupRole } from './domain'
import type { SupportedModel } from './orchestratorModel'

/** Every effort the `claude` binary accepts. */
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ModelOption {
  value: string
  label: string
}

/** The model families a role may run, in the order the app offers them. */
export const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type ModelFamily = (typeof MODEL_FAMILIES)[number]

const FAMILY_LABELS: Record<ModelFamily, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

/** When the binary's model list can't be read: the aliases every `claude` accepts, unversioned. */
export const ALIAS_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

// claude-<family>-<major>[-<minor>][-<date>]; a variant such as [1m] doesn't match.
const MODEL_ID = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/

export interface ModelVersion {
  family: ModelFamily
  major: number
  minor: number
}

/** A full model id's family and version, or null for anything else (an alias, a variant). */
export function parseModelId(id: string): ModelVersion | null {
  const match = MODEL_ID.exec(id)
  if (!match) return null
  return { family: match[1] as ModelFamily, major: Number(match[2]), minor: Number(match[3] ?? 0) }
}

/** Whether `a` is a later version than `b`. */
export function newerThan(a: ModelVersion, b: ModelVersion): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor)
}

/** "Fable 5.2", "Opus 5": a family's name and version. */
export function versionLabel(v: ModelVersion): string {
  return `${FAMILY_LABELS[v.family]} ${v.minor === 0 ? v.major : `${v.major}.${v.minor}`}`
}

/**
 * The models a role may run, from the binary's own list. Opus, Sonnet and Haiku are always their aliases, so saved
 * settings keep their meaning, labelled with the version each alias names. Fable is the latest Fable the list offers
 * by id (its alias when that names the latest, as the `fable` alias may lag behind), and is left out when there is none.
 */
export function roleModelOptions(models: SupportedModel[]): ModelOption[] {
  let fable: { id: string; version: ModelVersion } | null = null
  for (const m of models) {
    const id = m.resolvedModel ?? m.value
    const v = parseModelId(id)
    if (v?.family !== 'fable') continue
    if (!fable || newerThan(v, fable.version)) fable = { id, version: v }
  }
  const options: ModelOption[] = []
  if (fable) {
    const latest = fable
    const alias = models.some((m) => m.value === 'fable' && m.resolvedModel === latest.id)
    options.push({ value: alias ? 'fable' : latest.id, label: versionLabel(latest.version) })
  }
  for (const alias of ALIAS_MODEL_OPTIONS) {
    const resolved = models.find((m) => m.value === alias.value)?.resolvedModel
    const version = resolved === undefined ? null : parseModelId(resolved)
    options.push({ value: alias.value, label: version ? versionLabel(version) : alias.label })
  }
  return options
}

// What the user's `claude` offers: set by the engine once it has read the binary's list, and by the renderer from the
// engine. Until then, and when the list can't be read, the aliases.
let offered: ModelOption[] = [...ALIAS_MODEL_OPTIONS]

/** The models offered for agents' roles, in every select and schema: one list for the whole app. */
export function modelOptions(): ModelOption[] {
  return offered
}

/** Replaces the offered models (an empty list restores the aliases). */
export function setModelOptions(options: ModelOption[]): void {
  offered = options.length > 0 ? [...options] : [...ALIAS_MODEL_OPTIONS]
}

/** A model a start may choose for `role`: one of modelOptions(), or the role's own setting, which may be any alias. */
export function modelAllowed(role: Pick<LineupRole, 'model'>, model: string): boolean {
  return offered.some((o) => o.value === model) || model === role.model
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

/** A label for a model value: its option label, else its family and version ("Fable 5.1"), else the value itself. */
export function modelLabel(model: string): string {
  const option = offered.find((o) => o.value === model)
  if (option) return option.label
  const version = parseModelId(model)
  if (version) return versionLabel(version)
  return (MODEL_FAMILIES as readonly string[]).includes(model) ? FAMILY_LABELS[model as ModelFamily] : model
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

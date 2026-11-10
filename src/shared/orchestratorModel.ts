// Shared by the engine and the renderer: no Node imports.
import type { Effort, OrchestratorFamily } from './domain'
import { EFFORTS } from './models'

export type { OrchestratorFamily }

/** The model families the orchestrator may run: the latest of each that the user's `claude` offers. */
export const ORCHESTRATOR_FAMILIES: readonly OrchestratorFamily[] = ['fable', 'opus', 'sonnet']

export const ORCHESTRATOR_MODEL_DEFAULT: OrchestratorFamily = 'opus'
export const ORCHESTRATOR_EFFORT_DEFAULT: Effort = 'medium'

export const ORCHESTRATOR_MODEL_NOTE =
  'Higher effort and larger models make each orchestrator turn slower and use more of your plan.'

export function isOrchestratorFamily(v: unknown): v is OrchestratorFamily {
  return ORCHESTRATOR_FAMILIES.includes(v as OrchestratorFamily)
}

export function isEffort(v: unknown): v is Effort {
  return EFFORTS.includes(v as Effort)
}

/** A model as the `claude` binary lists it (the Agent SDK's supportedModels()). */
export interface SupportedModel {
  /** What to pass as the model: an alias or a full id. */
  value: string
  /** The full model id `value` resolves to. */
  resolvedModel?: string
  displayName: string
}

/** One choice of the setting: a family, the model to launch with, and its name and version. */
export interface OrchestratorModelOption {
  family: OrchestratorFamily
  model: string
  label: string
}

/** When the binary's list can't be read: its family aliases, which resolve to a version the binary picks. */
export const ALIAS_FALLBACK: OrchestratorModelOption[] = [
  { family: 'opus', model: 'opus', label: 'Opus' },
  { family: 'sonnet', model: 'sonnet', label: 'Sonnet' }
]

const FAMILY_NAMES: Record<OrchestratorFamily, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet' }

export function familyName(family: OrchestratorFamily): string {
  return FAMILY_NAMES[family]
}

// claude-<family>-<major>[-<minor>][-<date>]; a variant such as [1m] doesn't match.
const MODEL_ID = /^claude-(fable|opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/

/**
 * The latest Fable, Opus and Sonnet in the binary's list, in that order; a family it doesn't offer is left out. The
 * version is read from each model's full id, not from its alias, which may lag behind (`fable` can still name an
 * older Fable than one the list offers by id). The family's alias is used when it names the latest.
 */
export function latestOfEachFamily(models: SupportedModel[]): OrchestratorModelOption[] {
  const best = new Map<OrchestratorFamily, { id: string; major: number; minor: number }>()
  for (const m of models) {
    const id = m.resolvedModel ?? m.value
    const match = MODEL_ID.exec(id)
    if (!match) continue
    const family = match[1] as OrchestratorFamily
    const major = Number(match[2])
    const minor = Number(match[3] ?? 0)
    const now = best.get(family)
    if (!now || major > now.major || (major === now.major && minor > now.minor)) best.set(family, { id, major, minor })
  }
  return ORCHESTRATOR_FAMILIES.flatMap((family) => {
    const b = best.get(family)
    if (!b) return []
    const alias = models.some((m) => m.value === family && (m.resolvedModel ?? m.value) === b.id)
    const version = b.minor === 0 ? `${b.major}` : `${b.major}.${b.minor}`
    return [{ family, model: alias ? family : b.id, label: `${familyName(family)} ${version}` }]
  })
}

/** What the orchestrator runs with next, and what the setting offers. */
export interface OrchestratorModelState {
  /** The choices, from the binary's list, or ALIAS_FALLBACK when it couldn't be read. */
  options: OrchestratorModelOption[]
  fromBinary: boolean
  /** The saved choice. */
  saved: OrchestratorFamily
  /** What the next turn uses: the saved choice when it is offered, else the default (or the first offered). */
  current: OrchestratorModelOption
  effort: Effort
  /** Set when the saved choice isn't offered and another is used instead. */
  notice: string | null
}

export function orchestratorModelState(
  saved: { family: OrchestratorFamily; effort: Effort },
  offered: OrchestratorModelOption[],
  fromBinary: boolean
): OrchestratorModelState {
  const options = offered.length > 0 ? offered : ALIAS_FALLBACK
  const chosen = options.find((o) => o.family === saved.family)
  const current = chosen ?? options.find((o) => o.family === ORCHESTRATOR_MODEL_DEFAULT) ?? options[0]!
  const notice = chosen
    ? null
    : `${familyName(saved.family)} isn't offered by your claude${fromBinary ? '' : ' (its model list could not be read)'}, so the orchestrator uses ${current.label}.`
  return { options, fromBinary, saved: saved.family, current, effort: saved.effort, notice }
}

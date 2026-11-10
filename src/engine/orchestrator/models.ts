import type { Effort } from '../../shared/domain'
import { ALIAS_MODEL_OPTIONS, roleModelOptions, type ModelOption } from '../../shared/models'
import {
  ALIAS_FALLBACK,
  latestOfEachFamily,
  orchestratorModelState,
  type OrchestratorFamily,
  type OrchestratorModelOption,
  type OrchestratorModelState,
  type SupportedModel
} from '../../shared/orchestratorModel'

interface Offered {
  options: OrchestratorModelOption[]
  fromBinary: boolean
}

/**
 * The models the user's `claude` offers: read once from the binary's own list, then cached for the rest of the launch.
 * The orchestrator's choices and the roles' are both drawn from it. When the list can't be read (no binary, an error,
 * nothing Mainbus can use), the family aliases stand in.
 */
export class OrchestratorModels {
  private listed: Promise<SupportedModel[] | null> | null = null
  private offered: Promise<Offered> | null = null

  constructor(private readonly list: (() => Promise<SupportedModel[]>) | null) {}

  /** Reads the list the first time; every later call has the same answer. Never rejects. */
  load(): Promise<Offered> {
    this.offered ??= this.read()
    return this.offered
  }

  /** The models offered for agents' roles: Fable when the list has one, and the Opus, Sonnet and Haiku aliases. Never rejects. */
  async roleOptions(): Promise<ModelOption[]> {
    const models = await this.models()
    return models ? roleModelOptions(models) : [...ALIAS_MODEL_OPTIONS]
  }

  /** What the next turn runs with for these saved settings, and what the setting offers. */
  async state(saved: { orchestratorModel: OrchestratorFamily; orchestratorEffort: Effort }): Promise<OrchestratorModelState> {
    const { options, fromBinary } = await this.load()
    return orchestratorModelState({ family: saved.orchestratorModel, effort: saved.orchestratorEffort }, options, fromBinary)
  }

  /** The binary's list, or null when it can't be read. */
  private models(): Promise<SupportedModel[] | null> {
    this.listed ??= this.list
      ? this.list().catch((err: unknown) => {
          console.warn(`Mainbus could not read the model list of claude; using its aliases: ${err instanceof Error ? err.message : String(err)}`)
          return null
        })
      : Promise.resolve(null)
    return this.listed
  }

  private async read(): Promise<Offered> {
    const models = await this.models()
    if (models) {
      const options = latestOfEachFamily(models)
      if (options.length > 0) return { options, fromBinary: true }
      console.warn('Mainbus found no Fable, Opus or Sonnet in the model list of claude; using its aliases')
    }
    return { options: ALIAS_FALLBACK, fromBinary: false }
  }
}

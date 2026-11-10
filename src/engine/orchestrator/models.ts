import type { Effort } from '../../shared/domain'
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
 * The orchestrator models the user's `claude` offers: read once from the binary's own list, then cached for the rest
 * of the launch. When the list can't be read (no binary, an error, nothing Mainbus can use), the family aliases stand in.
 */
export class OrchestratorModels {
  private offered: Promise<Offered> | null = null

  constructor(private readonly list: (() => Promise<SupportedModel[]>) | null) {}

  /** Reads the list the first time; every later call has the same answer. Never rejects. */
  load(): Promise<Offered> {
    this.offered ??= this.read()
    return this.offered
  }

  /** What the next turn runs with for these saved settings, and what the setting offers. */
  async state(saved: { orchestratorModel: OrchestratorFamily; orchestratorEffort: Effort }): Promise<OrchestratorModelState> {
    const { options, fromBinary } = await this.load()
    return orchestratorModelState({ family: saved.orchestratorModel, effort: saved.orchestratorEffort }, options, fromBinary)
  }

  private async read(): Promise<Offered> {
    if (!this.list) return { options: ALIAS_FALLBACK, fromBinary: false }
    try {
      const options = latestOfEachFamily(await this.list())
      if (options.length > 0) return { options, fromBinary: true }
      console.warn('Mainbus found no Fable, Opus or Sonnet in the model list of claude; using its aliases')
    } catch (err) {
      console.warn(`Mainbus could not read the model list of claude; using its aliases: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { options: ALIAS_FALLBACK, fromBinary: false }
  }
}

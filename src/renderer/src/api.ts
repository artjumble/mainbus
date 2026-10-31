import {
  SETUP_REQUIRED,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type EngineEvent,
  type MainbusApi
} from '../../shared/api'

declare global {
  interface Window {
    mainbus: MainbusApi
  }
}

/** Sends a command to the engine. Rejects with the engine's error message. */
export function invoke<K extends CommandName>(command: K, ...args: CommandArgs<K>): Promise<CommandResult<K>> {
  return window.mainbus.invoke(command, ...args)
}

/** Subscribes to engine events; returns the unsubscribe function. */
export function onEngineEvent(listener: (e: EngineEvent) => void): () => void {
  return window.mainbus.on(listener)
}

/** Shows the native folder picker; null when the user cancels. */
export function openFolder(): Promise<string | null> {
  return window.mainbus.openFolder()
}

/** True when a rejected command failed because Claude Code isn't set up. Electron keeps the error's name in its message. */
export function isSetupRequired(err: unknown): boolean {
  return err instanceof Error && err.message.includes(SETUP_REQUIRED)
}

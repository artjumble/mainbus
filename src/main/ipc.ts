import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL, OPEN_FOLDER_CHANNEL } from '../shared/api'
import type { Engine } from '../engine'
import { isAppUrl } from './appUrl'

/**
 * Connects the engine to the renderer: one invoke channel in, one event channel out.
 * A command that throws rejects in the renderer with the error's message (Electron includes its name).
 * Only the app's own page, in the window's top frame, may send commands or open the folder picker.
 * `testRepos` (test runs only) are what the folder picker answers instead of showing the dialog, in order.
 * Returns a function that undoes the wiring.
 */
export function registerIpc(
  engine: Engine,
  getWindow: () => BrowserWindow | null,
  appUrl: string,
  testRepos: string[] | null = null
): () => void {
  let testPicks = 0
  const assertAppSender = (event: IpcMainInvokeEvent): void => {
    const frame = event.senderFrame
    if (
      event.sender !== getWindow()?.webContents ||
      !frame ||
      frame !== event.sender.mainFrame ||
      !isAppUrl(frame.url, appUrl)
    ) {
      throw new Error('Unexpected sender')
    }
  }

  ipcMain.handle(INVOKE_CHANNEL, (event, command: unknown, args: unknown) => {
    assertAppSender(event)
    if (typeof command !== 'string' || !Array.isArray(args)) throw new Error('Malformed command')
    // The engine rejects unknown command names itself.
    return (engine.invoke as (k: string, ...a: unknown[]) => Promise<unknown>)(command, ...args)
  })

  ipcMain.handle(OPEN_FOLDER_CHANNEL, async (event): Promise<string | null> => {
    assertAppSender(event)
    // The test folders in order, then the last again.
    if (testRepos) return testRepos[Math.min(testPicks++, testRepos.length - 1)] ?? null
    const win = getWindow()
    const options = { properties: ['openDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  const off = engine.on((e) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, e)
  })

  return () => {
    ipcMain.removeHandler(INVOKE_CHANNEL)
    ipcMain.removeHandler(OPEN_FOLDER_CHANNEL)
    off()
  }
}

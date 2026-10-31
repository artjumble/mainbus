import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL, OPEN_FOLDER_CHANNEL, type EngineEvent, type MainbusApi } from '../shared/api'

const api: MainbusApi = {
  invoke: (command, ...args) => ipcRenderer.invoke(INVOKE_CHANNEL, command, args),
  on: (listener) => {
    // The IpcRendererEvent is not passed on: it would expose the sender to the page.
    const handler = (_: IpcRendererEvent, e: EngineEvent): void => listener(e)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, handler)
    }
  },
  openFolder: () => ipcRenderer.invoke(OPEN_FOLDER_CHANNEL)
}

contextBridge.exposeInMainWorld('mainbus', api)

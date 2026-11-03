import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  NAVIGATE_CHANNEL,
  OPEN_FOLDER_CHANNEL,
  type AppNavigation,
  type EngineEvent,
  type MainbusApi
} from '../shared/api'

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
  openFolder: () => ipcRenderer.invoke(OPEN_FOLDER_CHANNEL),
  onNavigate: (listener) => {
    const handler = (_: IpcRendererEvent, nav: AppNavigation): void => listener(nav)
    ipcRenderer.on(NAVIGATE_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(NAVIGATE_CHANNEL, handler)
    }
  }
}

contextBridge.exposeInMainWorld('mainbus', api)

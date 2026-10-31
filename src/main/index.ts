import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { createEngine, type Engine } from '../engine'
import { runGit } from '../engine/git/git'
import { resolveHome } from '../engine/home'
import { FakeRuntime, type FakeStep } from '../engine/runtime/fakeRuntime'
import { execFileNode, resolveClaude, type ExecFn } from '../engine/runtime/resolveClaude'
import { SdkRuntime } from '../engine/runtime/sdkRuntime'
import type { AgentRuntime } from '../engine/runtime/types'
import { isAppUrl, isExternalWebUrl } from './appUrl'
import { fakeClaudeExec } from './fakeExec'
import { registerIpc } from './ipc'
import { testRepoFromEnv } from './testHooks'

let mainWindow: BrowserWindow | null = null
let engine: Engine | null = null

/** The one page the window may show: the dev server in dev, the built renderer otherwise. */
function appUrl(): string {
  return process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(path.join(import.meta.dirname, '../renderer/index.html')).href
}

function openExternally(url: string): void {
  if (isExternalWebUrl(url)) void shell.openExternal(url)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Mainbus',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Keep the title fixed rather than letting the page title replace it.
  win.on('page-title-updated', (event) => event.preventDefault())

  // The thread shows agent-written text and links. A page that is not ours must never load in this
  // window, because it would get `window.mainbus`: web links open in the user's browser instead.
  const home = appUrl()
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
  // Anything not clearly the app's own page is blocked, including when the check itself fails.
  const isHome = (url: string): boolean => {
    try {
      return isAppUrl(url, home)
    } catch {
      return false
    }
  }
  win.webContents.on('will-navigate', (event, url) => {
    if (isHome(url)) return
    event.preventDefault()
    openExternally(url)
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isHome(url)) event.preventDefault()
  })

  void win.loadURL(home)
  return win
}

/**
 * `MAINBUS_RUNTIME=fake:<script.json>` plays a scripted agent for tests. It is honored only when
 * MAINBUS_HOME is set, so a stray variable can never replace the real agent in a normal install.
 * A fake run also fakes the `claude` probes, so setup is ok without Claude Code installed.
 * Otherwise the user's own `claude` drives the agents; with no usable `claude`, there is no runtime.
 */
async function chooseRuntime(): Promise<{ runtime: AgentRuntime | null; exec: ExecFn }> {
  const fake = process.env['MAINBUS_RUNTIME']
  if (fake?.startsWith('fake:') && process.env['MAINBUS_HOME']) {
    const script = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fake.slice('fake:'.length)), 'utf8')) as FakeStep[]
    return { runtime: new FakeRuntime(script), exec: fakeClaudeExec }
  }
  const setup = await resolveClaude(execFileNode)
  return { runtime: setup.ok ? new SdkRuntime(setup.path, sdk) : null, exec: execFileNode }
}

// The data home comes first: the lock lives in userData, so stable, dev and test runs each get their own.
const home = resolveHome(process.env, app.isPackaged ? 'stable' : 'dev', os.homedir())
app.setPath('userData', path.join(home.root, 'electron'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app
    .whenReady()
    .then(async () => {
      const { runtime, exec } = await chooseRuntime()
      engine = await createEngine({
        paths: home,
        migrationsDir: app.isPackaged
          ? path.join(process.resourcesPath, 'migrations')
          : path.join(app.getAppPath(), 'src/engine/db/migrations'),
        runtime,
        git: runGit,
        exec
      })
      try {
        registerIpc(engine, () => mainWindow, appUrl(), testRepoFromEnv(process.env))
        mainWindow = createWindow()
        mainWindow.on('closed', () => {
          mainWindow = null
        })
      } catch (err) {
        // The window never opened: close the database cleanly before giving up.
        await engine.dispose().catch(() => {})
        throw err
      }
    })
    .catch((err: unknown) => {
      dialog.showErrorBox('Mainbus could not start', err instanceof Error ? err.message : String(err))
      app.exit(1)
    })

  // Quit only after the engine has stopped its agents and closed the database. A second quit request
  // while that is under way is held off too, and the first dispose is the only one.
  let disposing: Promise<void> | null = null
  let disposed = false
  app.on('before-quit', (event) => {
    if (disposed || !engine) return
    event.preventDefault()
    disposing ??= engine
      .dispose()
      .catch((err: unknown) => {
        console.error('Mainbus could not shut down cleanly:', err)
      })
      .finally(() => {
        disposed = true
        app.quit()
      })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, dialog, nativeTheme, powerSaveBlocker, shell } from 'electron'
import { createEngine, type Engine } from '../engine'
import { runCommand, type CommandRunner } from '../engine/git/command'
import { FakeGh } from '../engine/git/fakeGh'
import { FakeClock } from '../engine/holds/clock'
import { runGit } from '../engine/git/git'
import { invocationDir, resolveHome } from '../engine/home'
import { intakeEndpoint } from '../engine/intake/endpoint'
import { startIntakeServer, type IntakeServer } from '../engine/intake/server'
import { FakeRuntime, orchestratorScriptFromFile, scriptFromFile, type FakeScriptFile } from '../engine/runtime/fakeRuntime'
import { execFileNode, resolveClaude, type ExecFn } from '../engine/runtime/resolveClaude'
import { SdkRuntime } from '../engine/runtime/sdkRuntime'
import type { AgentRuntime } from '../engine/runtime/types'
import { isAppUrl, isExternalWebUrl } from './appUrl'
import { fakeClaudeExec } from './fakeExec'
import { registerIpc } from './ipc'
import { agentLauncher } from './launcher'
import { TrayController } from './tray/controller'
import { electronNotifier, electronTrayView, electronWindowPort, ensureStartMenuShortcut, filePrefs, realTimer } from './tray/electron'
import { recordingNotifier, recordTrayView, type TrayTestHook } from './tray/recording'
import { testClockStartFromEnv, testReposFromEnv, trayTestHookFromEnv } from './testHooks'
import { WindowTheme } from './windowTheme'

let mainWindow: BrowserWindow | null = null
let engine: Engine | null = null
let intake: IntakeServer | null = null
let tray: TrayController | null = null
/** Set when the app is quitting, so closing the window then really closes it instead of hiding it to the tray. */
let quitting = false
/** Why the intake pipe couldn't be opened; shown in the Connect agents settings. */
let intakeError: string | null = null
/** The window frame and background in the scheme of the Theme setting; set once the engine has read the setting. */
let windowTheme: WindowTheme | null = null

/**
 * The tray icon, the taskbar badge and the toasts. Not essential: when they can't start, the app runs without them
 * and the window closes as it always did. A test run records the toasts instead of showing them, and exposes the tray.
 */
function startTray(running: Engine): void {
  try {
    const testing = trayTestHookFromEnv(process.env)
    // Windows shows toasts only for an app with a Start Menu shortcut: the installed app keeps one. Never in development or tests.
    if (app.isPackaged && !process.env['MAINBUS_HOME']) ensureStartMenuShortcut()
    let view = electronTrayView()
    let notifier = electronNotifier()
    const hook: Partial<TrayTestHook> = {}
    if (testing) {
      const trayView = recordTrayView(view)
      const toasts = recordingNotifier()
      view = trayView.view
      notifier = toasts.notifier
      Object.assign(hook, trayView.hook, toasts.hook)
    }
    const controller = new TrayController({
      source: { invoke: (command, ...args) => (running.invoke as (k: string, ...a: unknown[]) => never)(command, ...args), on: (l) => running.on(l) },
      view,
      window: electronWindowPort(() => mainWindow, openMainWindow),
      notifier,
      prefs: filePrefs(path.join(home.root, 'electron', 'tray.json')),
      quit: () => app.quit(),
      timer: realTimer,
      onError: (err) => console.error('Mainbus tray:', err)
    })
    tray = controller
    if (testing) (globalThis as { __mainbusTray?: Partial<TrayTestHook> }).__mainbusTray = hook
    void controller.start()
  } catch (err) {
    console.error('Mainbus could not start its tray icon:', err)
  }
}

/** The one page the window may show: the dev server in dev, the built renderer otherwise. */
function appUrl(): string {
  return process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(path.join(import.meta.dirname, '../renderer/index.html')).href
}

/** Keeps the machine from sleeping while unattended mode has work under way; the engine starts and stops it. */
let blockerId: number | null = null
const keepAwake = {
  start(): void {
    blockerId ??= powerSaveBlocker.start('prevent-app-suspension')
  },
  stop(): void {
    if (blockerId === null) return
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

function openExternally(url: string): void {
  if (isExternalWebUrl(url)) void shell.openExternal(url)
}

/** Opens the main window and keeps `mainWindow` pointing at it; the tray calls this when no window is left. */
function openMainWindow(): BrowserWindow {
  const win = createWindow()
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Mainbus',
    autoHideMenuBar: true,
    // The ground of the chosen scheme, so a dark window shows no white before the page has painted.
    ...(windowTheme ? { backgroundColor: windowTheme.background() } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // With agents open, closing the window hides it to the tray instead. Electron can't wait for an async answer,
  // so the close is always held back and the tray controller then hides the window or quits.
  win.on('close', (event) => {
    if (quitting || !tray) return
    event.preventDefault()
    void tray.handleClose()
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
 * A fake run also fakes the `claude` probes, so setup is ok without Claude Code installed, and the GitHub CLI, so
 * opening a pull request never reaches GitHub (git itself still runs, against the test's own repositories).
 * Otherwise the user's own `claude` drives the agents; with no usable `claude`, there is no runtime.
 */
async function chooseRuntime(): Promise<{ runtime: AgentRuntime | null; exec: ExecFn; commands: CommandRunner }> {
  const fake = process.env['MAINBUS_RUNTIME']
  if (fake?.startsWith('fake:') && process.env['MAINBUS_HOME']) {
    const script = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fake.slice('fake:'.length)), 'utf8')) as FakeScriptFile
    const runtime = new FakeRuntime(scriptFromFile(script), {
      orchestrator: orchestratorScriptFromFile(script),
      // Sessions outlive the process, so an agent can be resumed after the app was killed.
      sessionsFile: path.join(home.root, 'fake-sessions.json')
    })
    return { runtime, exec: fakeClaudeExec, commands: new FakeGh().runner(runCommand) }
  }
  const setup = await resolveClaude(execFileNode)
  return {
    runtime: setup.ok ? new SdkRuntime(setup.path, sdk, { agentHome: home.root }) : null,
    exec: execFileNode,
    commands: runCommand
  }
}

// The data home comes first: the lock lives in userData, so stable, dev and test runs each get their own.
// A relative MAINBUS_HOME is taken from where `npm run dev` was typed, as the CLI does for `npm run mainbus`.
const home = resolveHome(
  process.env,
  app.isPackaged ? 'stable' : 'dev',
  os.homedir(),
  invocationDir(process.env, 'dev', process.cwd())
)
app.setPath('userData', path.join(home.root, 'electron'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app
    .whenReady()
    .then(async () => {
      const { runtime, exec, commands } = await chooseRuntime()
      // End-to-end tests only: a clock that moves when the test says (`__mainbusClock.advance(ms)` from the main process).
      const clockStart = testClockStartFromEnv(process.env)
      const clock = clockStart ? new FakeClock(clockStart) : undefined
      if (clock) (globalThis as { __mainbusClock?: FakeClock }).__mainbusClock = clock
      engine = await createEngine({
        paths: home,
        migrationsDir: app.isPackaged
          ? path.join(process.resourcesPath, 'migrations')
          : path.join(app.getAppPath(), 'src/engine/db/migrations'),
        runtime,
        git: runGit,
        exec,
        commands,
        launcher: agentLauncher({
          packaged: app.isPackaged,
          execPath: process.execPath,
          appPath: app.getAppPath(),
          home: process.env['MAINBUS_HOME'] ? home.root : null
        }),
        intakeError: () => intakeError,
        keepAwake,
        // With the test clock, the stuck detector's once-a-minute check moves with it.
        ...(clock ? { clock, stuck: { timer: clock } } : {})
      })
      try {
        registerIpc(engine, () => mainWindow, appUrl(), testReposFromEnv(process.env))
        const themed = new WindowTheme(nativeTheme, () => mainWindow)
        themed.apply((await engine.invoke('settings.get')).theme)
        engine.on((e) => {
          if (e.type === 'theme.changed') themed.apply(e.theme)
        })
        windowTheme = themed
        openMainWindow()
      } catch (err) {
        // The window never opened: close the database cleanly before giving up.
        await engine.dispose().catch(() => {})
        throw err
      }
      startTray(engine)
      // Local agents file tickets through the pipe. The board works without it, so a failure doesn't stop the
      // app: it is logged, and the Connect agents settings show it.
      const running = engine
      const endpoint = intakeEndpoint(home.root)
      intake = await startIntakeServer(endpoint, (method, params) => running.intake(method, params)).catch((err: unknown) => {
        console.error(`Mainbus could not start the agent intake on ${endpoint}:`, err)
        intakeError = `Mainbus couldn't open ${endpoint}: ${err instanceof Error ? err.message : String(err)}`
        return null
      })
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
    // First of all: from here on closing the window closes it, so quitting never waits on a window hidden in the tray.
    quitting = true
    if (disposed || !engine) return
    event.preventDefault()
    tray?.dispose()
    tray = null
    disposing ??= Promise.resolve(intake?.close())
      .then(() => engine?.dispose())
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

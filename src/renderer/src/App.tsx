import { AppShell, Button, Center, Loader, Stack, Text, Title, VisuallyHidden } from '@mantine/core'
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Announcer } from './Announcer'
import { Board } from './board/Board'
import { startNavigation } from './navigation'
import { showError } from './notify'
import { OrchestratorPanel, STRIP_WIDTH } from './orchestrator/OrchestratorPanel'
import { PanelResizeHandle } from './orchestrator/PanelResizeHandle'
import {
  clampPanelWidth,
  maxPanelWidth,
  readPanelOpen,
  readPanelWidth,
  writePanelOpen,
  writePanelWidth
} from './orchestrator/panelState'
import { AppSettings } from './settings/AppSettings'
import { SetupScreen } from './setup/SetupScreen'
import { startSync, useMainbus } from './store'
import { TicketView } from './ticket/TicketView'
import { OpenWorkspace } from './workspace/OpenWorkspace'
import { RAIL_WIDTH, WorkspaceRail } from './workspace/WorkspaceRail'
import { WorkspaceSettings } from './workspace/WorkspaceSettings'
import { UsageBanner } from './UsageBanner'

function subscribeToResize(notify: () => void): () => void {
  window.addEventListener('resize', notify)
  return () => window.removeEventListener('resize', notify)
}

function useWindowWidth(): number {
  return useSyncExternalStore(subscribeToResize, () => window.innerWidth)
}

export function App(): ReactElement {
  const setup = useMainbus((s) => s.setup)
  const workspace = useMainbus((s) => s.workspace)
  const workspaceLoaded = useMainbus((s) => s.workspaceLoaded)
  const loadError = useMainbus((s) => s.loadError)
  const load = useMainbus((s) => s.load)
  const currentTicketId = useMainbus((s) => s.currentTicketId)
  const [panelOpen, setPanelOpen] = useState(readPanelOpen)
  // The width the user chose; a small window shows it clamped, without losing it.
  const [panelWidth, setPanelWidth] = useState(readPanelWidth)
  const [resizing, setResizing] = useState(false)
  const windowWidth = useWindowWidth()
  const maxWidth = maxPanelWidth(windowWidth)
  const shownWidth = clampPanelWidth(panelWidth, windowWidth)

  const revealedProposal = useMainbus((s) => s.revealedProposal)
  const settingsOpen = useMainbus((s) => s.settingsOpen)
  const closeSettings = useMainbus((s) => s.closeSettings)
  const appSettingsOpen = useMainbus((s) => s.appSettingsOpen)
  const openAppSettings = useMainbus((s) => s.openAppSettings)
  const closeAppSettings = useMainbus((s) => s.closeAppSettings)

  useEffect(() => startSync((err) => showError(err, 'Could not load Mainbus')), [])
  useEffect(() => startNavigation(), [])

  // Ctrl+, opens the Mainbus settings from anywhere, a text field too, unless whatever has focus took the keys itself.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || e.key !== ',' || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return
      e.preventDefault()
      openAppSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openAppSettings])

  // The orchestrator sits beside the board and the ticket view; it stays mounted between them, so its thread is kept.
  const withPanel = !loadError && setup?.ok === true && workspaceLoaded && workspace !== null
  // The rail is there before the first workspace too, for the Mainbus settings.
  const withRail = !loadError && setup?.ok === true && workspaceLoaded

  function onPanelOpenChange(open: boolean): void {
    setPanelOpen(open)
    writePanelOpen(open)
  }

  function onPanelWidthChange(width: number, done: boolean): void {
    setPanelWidth(width)
    if (done) writePanelWidth(width)
  }

  // "Ask orchestrator to draft tickets" expands a collapsed panel; the panel's message box takes the text.
  const orchestratorPrefill = useMainbus((s) => s.orchestratorPrefill)
  useEffect(() => {
    if (orchestratorPrefill) onPanelOpenChange(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestratorPrefill])

  // A proposal to show (a card dragged into In progress) expands a collapsed panel.
  useEffect(() => {
    if (revealedProposal) onPanelOpenChange(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealedProposal])

  return (
    <AppShell
      // No slide while dragging, or the panel lags the pointer.
      transitionDuration={resizing ? 0 : undefined}
      // The rail's layout width is always the collapsed one; expanded, it lies over the board.
      navbar={withRail ? { width: RAIL_WIDTH, breakpoint: 0 } : undefined}
      // Breakpoint 0: never the mobile layout, where the aside goes full width over the board.
      aside={withPanel ? { width: panelOpen ? shownWidth : STRIP_WIDTH, breakpoint: 0 } : undefined}
    >
      <Announcer />
      {withRail && (
        <AppShell.Navbar>
          <WorkspaceRail />
        </AppShell.Navbar>
      )}
      {/* A column, so the board can fill the height under the usage banner. */}
      <AppShell.Main style={{ display: 'flex', flexDirection: 'column' }}>
        {/* The page's heading for screen readers; the window's title bar already says Mainbus. */}
        <VisuallyHidden>
          <Title order={1}>Mainbus</Title>
        </VisuallyHidden>
        {withPanel && <UsageBanner />}
        {screen()}
        {/* Outside screen(), so Settings from the rail works from the ticket view too. */}
        {withPanel && <WorkspaceSettings opened={settingsOpen} onClose={closeSettings} />}
        {/* Always there, so Ctrl+, works on every screen. */}
        <AppSettings opened={appSettingsOpen} onClose={closeAppSettings} />
      </AppShell.Main>
      {withPanel && (
        <AppShell.Aside aria-label="Orchestrator">
          {panelOpen && (
            <PanelResizeHandle
              width={shownWidth}
              max={maxWidth}
              onChange={onPanelWidthChange}
              onDraggingChange={setResizing}
            />
          )}
          <OrchestratorPanel open={panelOpen} onOpenChange={onPanelOpenChange} />
        </AppShell.Aside>
      )}
    </AppShell>
  )

  function screen(): ReactElement {
    if (loadError) {
      return (
        <Center mih="60vh">
          <Stack maw={520} gap="md" p="md">
            <Title order={2}>Mainbus could not start</Title>
            <Text>{loadError}</Text>
            <Button w="fit-content" onClick={() => void load()}>
              Try again
            </Button>
          </Stack>
        </Center>
      )
    }
    if (!setup || (setup.ok && !workspaceLoaded)) {
      return (
        <Center mih="60vh">
          <Loader />
        </Center>
      )
    }
    if (!setup.ok) return <SetupScreen />
    if (!workspace) return <OpenWorkspace />
    if (currentTicketId) return <TicketView />
    return <Board />
  }
}

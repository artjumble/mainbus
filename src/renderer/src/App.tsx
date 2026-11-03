import { AppShell, Button, Center, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { Board } from './board/Board'
import { startNavigation } from './navigation'
import { showError } from './notify'
import { OrchestratorPanel, PANEL_WIDTH, STRIP_WIDTH } from './orchestrator/OrchestratorPanel'
import { readPanelOpen, writePanelOpen } from './orchestrator/panelState'
import { SetupScreen } from './setup/SetupScreen'
import { startSync, useMainbus } from './store'
import { TicketView } from './ticket/TicketView'
import { OpenWorkspace } from './workspace/OpenWorkspace'
import { WorkspaceRail } from './workspace/WorkspaceRail'
import { WorkspaceSettings } from './workspace/WorkspaceSettings'
import { UsageBanner } from './UsageBanner'

export function App(): ReactElement {
  const setup = useMainbus((s) => s.setup)
  const workspace = useMainbus((s) => s.workspace)
  const workspaceLoaded = useMainbus((s) => s.workspaceLoaded)
  const loadError = useMainbus((s) => s.loadError)
  const load = useMainbus((s) => s.load)
  const currentTicketId = useMainbus((s) => s.currentTicketId)
  const [panelOpen, setPanelOpen] = useState(readPanelOpen)

  const revealedProposal = useMainbus((s) => s.revealedProposal)
  const settingsOpen = useMainbus((s) => s.settingsOpen)
  const closeSettings = useMainbus((s) => s.closeSettings)

  useEffect(() => startSync((err) => showError(err, 'Could not load Mainbus')), [])
  useEffect(() => startNavigation(), [])

  // The orchestrator sits beside the board and the ticket view; it stays mounted between them, so its thread is kept.
  const withPanel = !loadError && setup?.ok === true && workspaceLoaded && workspace !== null

  function onPanelOpenChange(open: boolean): void {
    setPanelOpen(open)
    writePanelOpen(open)
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
      header={{ height: 48 }}
      // Names beside the entries when wide, initials when narrow.
      navbar={withPanel ? { width: { base: 72, lg: 220 }, breakpoint: 0 } : undefined}
      // Breakpoint 0: never the mobile layout, where the aside goes full width over the board.
      aside={withPanel ? { width: panelOpen ? PANEL_WIDTH : STRIP_WIDTH, breakpoint: 0 } : undefined}
    >
      <AppShell.Header>
        <Group h="100%" px="md">
          <Title order={1} size="h4">
            Mainbus
          </Title>
        </Group>
      </AppShell.Header>
      {withPanel && (
        <AppShell.Navbar>
          <WorkspaceRail />
        </AppShell.Navbar>
      )}
      <AppShell.Main>
        {withPanel && <UsageBanner />}
        {screen()}
        {/* Outside screen(), so Settings from the rail works from the ticket view too. */}
        {withPanel && <WorkspaceSettings opened={settingsOpen} onClose={closeSettings} />}
      </AppShell.Main>
      {withPanel && (
        <AppShell.Aside aria-label="Orchestrator">
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

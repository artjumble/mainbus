import { AppShell, Button, Center, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { useEffect, type ReactElement } from 'react'
import { Board } from './board/Board'
import { showError } from './notify'
import { SetupScreen } from './setup/SetupScreen'
import { startSync, useMainbus } from './store'
import { TicketView } from './ticket/TicketView'
import { OpenWorkspace } from './workspace/OpenWorkspace'

export function App(): ReactElement {
  const setup = useMainbus((s) => s.setup)
  const workspace = useMainbus((s) => s.workspace)
  const workspaceLoaded = useMainbus((s) => s.workspaceLoaded)
  const loadError = useMainbus((s) => s.loadError)
  const load = useMainbus((s) => s.load)
  const currentTicketId = useMainbus((s) => s.currentTicketId)

  useEffect(() => startSync((err) => showError(err, 'Could not load Mainbus')), [])

  return (
    <AppShell header={{ height: 48 }}>
      <AppShell.Header>
        <Group h="100%" px="md">
          <Title order={1} size="h4">
            Mainbus
          </Title>
        </Group>
      </AppShell.Header>
      <AppShell.Main>{screen()}</AppShell.Main>
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

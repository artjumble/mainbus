import { Button, Center, Stack, Text, Title } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import { openFolder } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

/** Shown when Claude Code is ready but no repo is open yet. */
export function OpenWorkspace(): ReactElement {
  const openWorkspace = useMainbus((s) => s.openWorkspace)
  const [opening, setOpening] = useState(false)

  async function pick(): Promise<void> {
    setOpening(true)
    try {
      const folder = await openFolder()
      if (folder) await openWorkspace(folder)
    } catch (err) {
      showError(err, 'Could not open that folder')
    } finally {
      setOpening(false)
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Stack maw={520} gap="md">
        <Title order={2}>Welcome to Mainbus</Title>
        <Text>
          Mainbus runs Claude Code agents on your tickets, each in its own folder, and asks you only when it needs a
          decision. Add the git repository you want to work on to begin.
        </Text>
        <Text size="sm" c="dimmed">
          Claude Code can't ask you to trust a folder while Mainbus runs it, so Mainbus treats the folder you pick as
          trusted.
        </Text>
        <Button onClick={() => void pick()} loading={opening} w="fit-content" aria-label="Add workspace">
          + Add workspace
        </Button>
      </Stack>
    </Center>
  )
}

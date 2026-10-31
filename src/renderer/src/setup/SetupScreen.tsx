import { Alert, Anchor, Button, Center, Code, Stack, Text, Title } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import { showError } from '../notify'
import { useMainbus } from '../store'

const SETUP_DOCS_URL = 'https://code.claude.com/docs/en/setup'

/** Blocks the app until Claude Code is installed and signed in. Mainbus never signs in for the user. */
export function SetupScreen(): ReactElement {
  const setup = useMainbus((s) => s.setup)
  const checkSetup = useMainbus((s) => s.checkSetup)
  const [checking, setChecking] = useState(false)

  async function checkAgain(): Promise<void> {
    setChecking(true)
    try {
      await checkSetup()
    } catch (err) {
      showError(err, 'Could not check Claude Code')
    } finally {
      setChecking(false)
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Stack maw={520} gap="md">
        <Title order={2}>Set up Claude Code</Title>
        {setup && !setup.ok && <Reason reason={setup.reason} />}
        {setup && !setup.ok && setup.detail && (
          <Text size="sm" c="dimmed">
            {setup.detail}
          </Text>
        )}
        <Button onClick={() => void checkAgain()} loading={checking} w="fit-content">
          Check again
        </Button>
      </Stack>
    </Center>
  )
}

function Reason({ reason }: { reason: 'not_found' | 'not_logged_in' | 'restart_required' }): ReactElement {
  switch (reason) {
    case 'not_found':
      return (
        <Alert color="needs" title="Claude Code isn't installed">
          <Text size="sm">Mainbus runs its agents with Claude Code, and it can't find it on this computer.</Text>
          <Text size="sm" mt="xs">
            Install it by following the{' '}
            <Anchor href={SETUP_DOCS_URL} target="_blank" rel="noopener noreferrer">
              Claude Code setup guide
            </Anchor>
            , then choose Check again.
          </Text>
        </Alert>
      )
    case 'not_logged_in':
      return (
        <Alert color="needs" title="Claude Code isn't signed in">
          <Text size="sm">
            Open a terminal and run <Code>claude auth login</Code>. Mainbus never signs in for you, so run it yourself.
          </Text>
          <Text size="sm" mt="xs">
            When you're done, choose Check again.
          </Text>
        </Alert>
      )
    case 'restart_required':
      return (
        <Alert color="needs" title="Restart needed">
          <Text size="sm">Restart Mainbus to use Claude Code.</Text>
        </Alert>
      )
  }
}

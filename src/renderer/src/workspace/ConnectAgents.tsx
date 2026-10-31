import { Alert, Button, Code, CopyButton, Group, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { AgentLauncher } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { setupLines } from './connectLines'

/** Settings section: the lines to copy so Claude Code, Codex and Copilot can file tickets on this board. */
export function ConnectAgents({ opened }: { opened: boolean }): ReactElement {
  const [launcher, setLauncher] = useState<AgentLauncher | null>(null)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('agents.launcher')
      .then((found) => {
        if (!cancelled) setLauncher(found ?? null)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the agent setup')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  return (
    <Stack gap="sm" component="section" aria-label="Connect agents">
      <Title order={3} size="h4">
        Connect agents
      </Title>
      <Text size="sm" c="dimmed">
        Agents on this machine can file tickets here. They land in Backlog with the agent's name on them, for you to
        decide on. Agents can create, list and read tickets, nothing more.
      </Text>
      {launcher === null ? (
        <Text size="sm" c="dimmed">
          Not available.
        </Text>
      ) : (
        <>
          {launcher.kind === 'dev' && (
            <Text size="sm" c="dimmed">
              This is a dev build: these lines run the CLI from this checkout with Node, against the dev data home.
            </Text>
          )}
          {!launcher.exists && (
            <Alert color="yellow" variant="light" title="The launcher isn't there yet">
              {launcher.kind === 'stable'
                ? 'Run scripts\\build-stable.ps1 from your own terminal to write '
                : 'Run npm run build to write '}
              <Code>{launcher.program[launcher.program.length - 1]}</Code>.
            </Alert>
          )}
          {setupLines(launcher).map((line) => (
            <Stack key={line.id} gap={4}>
              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="sm" fw={500}>
                    {line.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {line.where}
                  </Text>
                </div>
                <CopyButton value={line.text}>
                  {({ copied, copy }) => (
                    <Button
                      size="compact-xs"
                      variant="light"
                      color={copied ? 'teal' : undefined}
                      onClick={copy}
                      aria-label={`Copy the ${line.title} setup`}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
              <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {line.text}
              </Code>
            </Stack>
          ))}
        </>
      )}
    </Stack>
  )
}

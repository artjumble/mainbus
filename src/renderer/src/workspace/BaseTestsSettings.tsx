import { ActionIcon, Badge, Button, Group, NativeSelect, Stack, Text, TextInput, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import {
  checkTestCommands,
  RESULTS_PLACEHOLDER,
  type BaseTestCommandResult,
  type BaseTestsView,
  type TestCommand,
  type TestResultFormat
} from '../../../shared/domain'
import { invoke, onEngineEvent } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

const FORMATS: { value: TestResultFormat; label: string }[] = [
  { value: 'plain', label: 'Plain (exit code and output)' },
  { value: 'vitest-json', label: 'Vitest JSON' },
  { value: 'playwright-json', label: 'Playwright JSON' },
  { value: 'junit-xml', label: 'JUnit XML' }
]

const sameCommands = (a: TestCommand[], b: TestCommand[]): boolean =>
  a.length === b.length && a.every((c, i) => c.name === b[i]!.name && c.command === b[i]!.command && c.format === b[i]!.format)

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function outcome(r: BaseTestCommandResult): string {
  if (r.timedOut) return 'timed out'
  if (r.failures.length > 0) return `${r.failures.length} failing`
  return r.exitCode === 0 ? 'passed' : `failed (exit code ${r.exitCode ?? 'none'})`
}

/** Settings section: the commands Mainbus runs on the newest base branch, and what they found. */
export function BaseTestsSettings({ opened }: { opened: boolean }): ReactElement {
  const workspace = useMainbus((s) => s.workspace)
  const workspaceId = workspace?.id ?? null
  const saved = workspace?.testCommands ?? []
  const [rows, setRows] = useState<TestCommand[]>(saved)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<BaseTestsView | null>(null)
  const [starting, setStarting] = useState(false)

  // Each opening starts from what is saved.
  useEffect(() => {
    if (opened) setRows(workspace?.testCommands ?? [])
  }, [opened, workspace?.testCommands])

  // What the last run found is read on opening and again whenever it changes.
  useEffect(() => {
    if (!opened || workspaceId === null) return
    let live = true
    const load = (): void => {
      invoke('workspace.baseTests', workspaceId)
        .then((v) => live && setView(v))
        .catch(() => {})
    }
    load()
    const off = onEngineEvent((e) => {
      if (e.type === 'baseTests.changed' && e.workspaceId === workspaceId) load()
    })
    return () => {
      live = false
      off?.()
    }
  }, [opened, workspaceId])

  const checked = checkTestCommands(rows)
  const changed = checked.ok ? !sameCommands(checked.commands, saved) : !sameCommands(rows, saved)

  function update(i: number, patch: Partial<TestCommand>): void {
    setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  async function save(): Promise<void> {
    if (!checked.ok) return
    setSaving(true)
    try {
      const ws = await invoke('workspace.setTestCommands', checked.commands, workspaceId ?? undefined)
      setRows(ws.testCommands)
      useMainbus.setState({ workspace: ws })
    } catch (err) {
      showError(err, 'Could not save the test commands')
    } finally {
      setSaving(false)
    }
  }

  async function runNow(): Promise<void> {
    setStarting(true)
    try {
      await invoke('workspace.runBaseTests', workspaceId ?? undefined)
    } catch (err) {
      showError(err, 'Could not run the base branch tests')
    } finally {
      setStarting(false)
    }
  }

  const running = view?.running ?? null
  const summary = view?.summary ?? null

  return (
    <Stack gap="sm" component="section" aria-label="Base branch tests">
      <Title order={3} size="h4">
        Base branch tests
      </Title>
      <Text size="sm" c="dimmed">
        Mainbus runs these commands itself on the newest base branch, in a folder of its own, whenever the base moves and no agent is working. Roles
        are then told which failures were already there. In a command, {RESULTS_PLACEHOLDER} becomes the path of a results file in Mainbus's data
        folder. Leave the list empty to turn this off.
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (changed && checked.ok) void save()
        }}
      >
        <Stack gap="xs">
          {rows.map((row, i) => (
            <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
              <TextInput
                aria-label={`Test command ${i + 1} name`}
                placeholder="Name, e.g. Unit"
                value={row.name}
                onChange={(e) => update(i, { name: e.currentTarget.value })}
                w={120}
                disabled={workspace === null}
              />
              <TextInput
                aria-label={`Test command ${i + 1} command`}
                placeholder={`e.g. npx vitest run --reporter=json --outputFile=${RESULTS_PLACEHOLDER}`}
                value={row.command}
                onChange={(e) => update(i, { command: e.currentTarget.value })}
                flex={1}
                disabled={workspace === null}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
              />
              <NativeSelect
                aria-label={`Test command ${i + 1} result format`}
                data={FORMATS}
                value={row.format}
                onChange={(e) => update(i, { format: e.currentTarget.value as TestResultFormat })}
                disabled={workspace === null}
              />
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={`Remove test command ${i + 1}`}
                onClick={() => setRows((current) => current.filter((_, j) => j !== i))}
              >
                <span aria-hidden>×</span>
              </ActionIcon>
            </Group>
          ))}
          {!checked.ok && rows.length > 0 && (
            <Text size="sm" c="red" role="alert">
              {checked.reason}
            </Text>
          )}
          <Group>
            <Button
              variant="default"
              size="compact-sm"
              disabled={workspace === null}
              onClick={() => setRows((current) => [...current, { name: '', command: '', format: 'plain' }])}
            >
              Add test command
            </Button>
            <Button type="submit" variant="default" size="compact-sm" loading={saving} disabled={!checked.ok || !changed}>
              Save test commands
            </Button>
          </Group>
        </Stack>
      </form>

      {saved.length > 0 && (
        <Stack gap="xs">
          <Group>
            <Button variant="default" size="compact-sm" loading={starting || running !== null} onClick={() => void runNow()}>
              Run base tests now
            </Button>
            {running !== null && (
              <Text size="sm" c="dimmed" role="status">
                Running on {running.baseSha.slice(0, 7)}
                {running.command ? ` (${running.command})` : ''}…
              </Text>
            )}
            {running === null && view?.waitingForAgents && (
              <Text size="sm" c="dimmed" role="status">
                Waiting for agents to finish
              </Text>
            )}
          </Group>
          {summary === null ? (
            <Text size="sm" c="dimmed">
              No run has finished yet.
            </Text>
          ) : (
            <Stack gap={4}>
              <Text size="sm">
                Last run {new Date(summary.at).toLocaleString()} on {summary.baseRef} at {summary.baseSha.slice(0, 7)}
              </Text>
              {summary.error !== null && (
                <Text size="sm" c="red">
                  Mainbus couldn't run the tests: {summary.error}
                </Text>
              )}
              {(view?.results ?? []).map((r) => (
                <Text key={r.name} size="sm" c="dimmed">
                  {r.name}: {outcome(r)} ({seconds(r.durationMs)})
                </Text>
              ))}
              <Text size="sm" fw={500}>
                Known failures
              </Text>
              {summary.knownFailures.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {summary.error === null ? 'All passed.' : 'None known from earlier runs.'}
                </Text>
              ) : (
                summary.knownFailures.map((f) => (
                  <Group key={`${f.command}\u0000${f.test ?? ''}`} gap="xs" wrap="nowrap" align="flex-start">
                    <Text size="sm" ff="monospace" style={{ wordBreak: 'break-word' }}>
                      {f.command}: {f.test ?? 'the command failed and named no failing test'}
                    </Text>
                    {f.intermittent && (
                      <Badge variant="light" color="yellow" style={{ flexShrink: 0 }}>
                        intermittent, {f.failedRuns} of {f.ofRuns} runs
                      </Badge>
                    )}
                  </Group>
                ))
              )}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}

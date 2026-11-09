import { Box, Button, Group, SegmentedControl, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import {
  categoryLine,
  commandLine,
  formatMinutes,
  TIME_CATEGORIES,
  timeReportCsv,
  type WorkspaceTimeReport
} from '../../../shared/timeBreakdown'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'
import { TimeBar, TimeLegend } from '../ticket/TimeBar'

type Range = '10' | '25' | '50' | 'dates'

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
}

/** Downloads the text as a file through a link, since the renderer cannot write files itself. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Settings section: where time went over the workspace's recent tickets that reached Review. */
export function TimeReportSettings({ opened }: { opened: boolean }): ReactElement {
  const workspace = useMainbus((s) => s.workspace)
  const workspaceId = workspace?.id ?? null
  const [range, setRange] = useState<Range>('10')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [report, setReport] = useState<WorkspaceTimeReport | null>(null)

  useEffect(() => {
    if (!opened || workspaceId === null) return
    let live = true
    const opts = range === 'dates' ? { ...(since ? { since } : {}), ...(until ? { until } : {}) } : { last: Number(range) }
    if (range === 'dates' && !since && !until) {
      setReport(null)
      return
    }
    invoke('workspace.timeReport', opts, workspaceId)
      .then((r) => live && setReport(r))
      .catch((err) => showError(err, 'Could not work out where the time went'))
    return () => {
      live = false
    }
  }, [opened, workspaceId, range, since, until])

  const exportCsv = (): void => {
    if (!report) return
    download(`mainbus-time-${slug(workspace?.name ?? '')}-${new Date().toISOString().slice(0, 10)}.csv`, timeReportCsv(report))
  }

  return (
    <Box component="section" aria-label="Where time goes">
      <Stack gap="sm">
        <Title order={3} size="h4">
          Where time goes
        </Title>
        <Text size="sm" c="dimmed">
          Worked out from each ticket's stored thread, over the tickets that reached Review.
        </Text>
        <SegmentedControl
          aria-label="Tickets to include"
          value={range}
          onChange={(v) => setRange(v as Range)}
          data={[
            { value: '10', label: 'Last 10' },
            { value: '25', label: 'Last 25' },
            { value: '50', label: 'Last 50' },
            { value: 'dates', label: 'Dates' }
          ]}
        />
        {range === 'dates' && (
          <Group gap="sm">
            <TextInput type="date" label="From" value={since} onChange={(e) => setSince(e.currentTarget.value)} />
            <TextInput type="date" label="To" value={until} onChange={(e) => setUntil(e.currentTarget.value)} />
          </Group>
        )}
        {report === null ? (
          <Text size="sm" c="dimmed">
            {range === 'dates' ? 'Pick a first or last day.' : 'Working it out…'}
          </Text>
        ) : report.ticketCount === 0 ? (
          <Text size="sm" c="dimmed">
            No ticket has reached Review in this range.
          </Text>
        ) : (
          <Stack gap="sm">
            <Text size="sm">
              {report.ticketCount} {report.ticketCount === 1 ? 'ticket' : 'tickets'} · {formatMinutes(report.totalMs)} in total · {formatMinutes(report.averageMs)} on average · median{' '}
              {report.medianToReviewMs === null ? 'unknown' : formatMinutes(report.medianToReviewMs)} from the first start to Review
            </Text>
            <TimeBar label="All tickets" byCategory={report.byCategory} totalMs={report.totalMs} />
            <TimeLegend byCategory={report.byCategory} />
            <Table aria-label="Time by category" withRowBorders={false} verticalSpacing={2}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Category</Table.Th>
                  <Table.Th ta="right">Total</Table.Th>
                  <Table.Th ta="right">Average per ticket</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {TIME_CATEGORIES.filter((c) => report.byCategory[c.id] > 0).map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td>{c.label}</Table.Td>
                    <Table.Td ta="right">{formatMinutes(report.byCategory[c.id])}</Table.Td>
                    <Table.Td ta="right">{formatMinutes(report.averages[c.id])}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Table aria-label="Time by role" withRowBorders={false} verticalSpacing={2}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Role</Table.Th>
                  <Table.Th ta="right">Total</Table.Th>
                  <Table.Th ta="right">Average where it ran</Table.Th>
                  <Table.Th>Mostly</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {report.roles.map((r) => (
                  <Table.Tr key={r.role}>
                    <Table.Td>{r.role}</Table.Td>
                    <Table.Td ta="right">{formatMinutes(r.totalMs)}</Table.Td>
                    <Table.Td ta="right">{formatMinutes(r.totalMs / Math.max(1, r.tickets))}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {categoryLine(r.byCategory).split(', ').slice(0, 3).join(', ')}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {report.commands.length > 0 && (
              <Stack gap={2}>
                <Text size="xs" tt="uppercase" c="dimmed" lts="0.04em">
                  Longest commands in total
                </Text>
                {report.commands.map((c) => (
                  <Text key={c.command} size="sm" ff="monospace">
                    {commandLine(c)}
                  </Text>
                ))}
              </Stack>
            )}
            <Group>
              <Button variant="default" size="xs" onClick={exportCsv}>
                Export CSV
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Box>
  )
}

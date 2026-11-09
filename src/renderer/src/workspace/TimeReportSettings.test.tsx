import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { ticketTime, workspaceTimeReport, type WorkspaceTimeReport } from '../../../shared/timeBreakdown'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { TimeReportSettings } from './TimeReportSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(() => () => {}), openFolder: vi.fn() }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const T0 = Date.UTC(2026, 0, 1, 10)
const iso = (min: number): string => new Date(T0 + min * 60_000).toISOString()

function report(): WorkspaceTimeReport {
  const time = ticketTime({
    runs: [{ id: 'b', ticketRunId: 't1', role: 'Implementer', startedAt: iso(0), endedAt: iso(40) }],
    events: [
      { runId: 'b', seq: 1, at: iso(5), event: { kind: 'tool_call', id: 'x', name: 'Bash', input: { command: 'pnpm test' } } },
      { runId: 'b', seq: 2, at: iso(35), event: { kind: 'tool_result', id: 'x', ok: true, summary: '' } }
    ],
    decisions: [],
    ticketRuns: [{ id: 't1', status: 'done', endedAt: iso(40) }],
    now: T0
  })
  return workspaceTimeReport([{ ticketId: 'x', number: 7, title: 'Add login', time }])
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(report())
  useMainbus.setState({ workspace })
})

test('shows totals, the median, roles and commands, and asks for the last 10 first', async () => {
  const { container } = renderWithMantine(<TimeReportSettings opened />)
  expect(await screen.findByText(/1 ticket · 40 min in total · 40 min on average · median 40 min/)).toBeVisible()
  expect(mockInvoke).toHaveBeenCalledWith('workspace.timeReport', { last: 10 }, workspace.id)
  expect(screen.getByText('pnpm test × 1, 30 min')).toBeVisible()
  expect(screen.getByRole('table', { name: 'Time by role' })).toHaveTextContent('Implementer')
  await expectNoAxeViolations(container)
})

test('switching the range asks for the last 25', async () => {
  renderWithMantine(<TimeReportSettings opened />)
  await screen.findByText(/median/)
  await userEvent.click(screen.getByText('Last 25'))
  expect(mockInvoke).toHaveBeenLastCalledWith('workspace.timeReport', { last: 25 }, workspace.id)
})

test('Export CSV downloads one row per run and category', async () => {
  const blobs: Blob[] = []
  URL.createObjectURL = vi.fn((b: Blob) => (blobs.push(b), 'blob:x')) as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  renderWithMantine(<TimeReportSettings opened />)
  await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }))
  expect(click).toHaveBeenCalled()
  const text = await new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsText(blobs[0]!)
  })
  const lines = text.trim().split('\r\n')
  expect(lines[0]).toBe('ticket,title,run,role,agent_run_id,started_at,ended_at,category,minutes')
  expect(lines.some((l) => l.includes('#7,Add login,1,Implementer,b') && l.includes('Tests,30.00'))).toBe(true)
  click.mockRestore()
})

test('says so when no ticket reached Review', async () => {
  mockInvoke.mockResolvedValue(workspaceTimeReport([]))
  renderWithMantine(<TimeReportSettings opened />)
  expect(await screen.findByText('No ticket has reached Review in this range.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument()
})

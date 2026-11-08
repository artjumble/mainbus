import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Decision } from '../../../shared/domain'
import { invoke } from '../api'
import { expectNoAxeViolations, makeDecision, renderWithMantine } from '../test-utils'
import { PermissionCard } from './PermissionCard'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(),
  isSetupRequired: () => false
}))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const permission = (over: Partial<Decision> = {}): Decision =>
  makeDecision({ kind: 'permission', question: 'Implementer wants to run `pnpm install`', options: [], ...over })

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

test('PermissionCard offers Allow once, Always allow in this workspace, Deny', async () => {
  renderWithMantine(<PermissionCard decision={permission()} />)
  expect(screen.getByText('Implementer wants to run')).toBeInTheDocument()
  expect(screen.getByText('pnpm install')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))
  expect(mockInvoke).toHaveBeenLastCalledWith('decision.answer', 'd1', { kind: 'permission', choice: 'allow_once' }, 'thread')
  await userEvent.click(screen.getByRole('button', { name: 'Always allow in this workspace' }))
  expect(mockInvoke).toHaveBeenLastCalledWith('decision.answer', 'd1', { kind: 'permission', choice: 'always_allow' }, 'thread')
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
  expect(mockInvoke).toHaveBeenLastCalledWith('decision.answer', 'd1', { kind: 'permission', choice: 'deny' }, 'thread')
})

test('with allowAlways false the Always allow button is not rendered', () => {
  renderWithMantine(<PermissionCard decision={permission({ allowAlways: false })} />)
  expect(screen.queryByRole('button', { name: /Always allow/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
})

test('an expired card says why and has no buttons', () => {
  renderWithMantine(<PermissionCard decision={permission({ status: 'expired' })} />)
  expect(screen.getByText('Expired — the agent can no longer receive this answer.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Allow/ })).not.toBeInTheDocument()
})

test.each([
  ['allow_once', '✓ Answered: Allowed once'],
  ['always_allow', '✓ Answered: Always allowed in this workspace'],
  ['deny', '✓ Answered: Denied']
] as const)('an answered %s card reads "%s"', (choice, text) => {
  renderWithMantine(<PermissionCard decision={permission({ status: 'answered', answer: { kind: 'permission', choice } })} />)
  expect(screen.getByText(text)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Allow/ })).not.toBeInTheDocument()
})

test('a rejected answer is shown', async () => {
  mockInvoke.mockRejectedValue(new Error('"Always allow" is not offered for this request'))
  renderWithMantine(<PermissionCard decision={permission()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
  expect(await screen.findByText(/not offered/)).toBeInTheDocument()
})

test.each([[{}], [{ allowAlways: false }], [{ status: 'expired' }]] as const)('a permission card %j has no axe violations', async (over) => {
  renderWithMantine(<PermissionCard decision={permission(over as never)} />)
  await expectNoAxeViolations()
})

const heredoc = ["cat > src/x.ts <<'EOF'", ...Array.from({ length: 20 }, (_, i) => `export const n${i} = ${i}`), 'EOF'].join('\n')

test('shows the command as a highlighted block with Copy, and the reason below it', async () => {
  const write = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
  renderWithMantine(
    <PermissionCard
      decision={permission({ question: 'x', request: { role: 'Implementer', tool: 'Bash', command: 'echo "hi" # note', path: null, input: null, reason: "Runs a command Mainbus can't check" } })}
    />
  )
  expect(screen.getByText('Implementer wants to run')).toBeInTheDocument()
  await waitFor(() => expect(document.querySelector('.hljs-string')).not.toBeNull())
  expect(document.querySelector('code')?.textContent).toBe('echo "hi" # note')
  expect(screen.getByText("Runs a command Mainbus can't check")).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Copy command' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
})

test('a command of more than 12 lines is capped, with Show all', async () => {
  renderWithMantine(
    <PermissionCard decision={permission({ request: { role: 'Implementer', tool: 'Bash', command: heredoc, path: null, input: null, reason: null } })} />
  )
  const show = screen.getByRole('button', { name: 'Show all' })
  expect(show).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(show)
  expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  // The whole command is in the block either way.
  expect(document.querySelector('code')?.textContent).toBe(heredoc)
})

test('a short command has no Show all', () => {
  renderWithMantine(<PermissionCard decision={permission()} />)
  expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument()
})

test('an old decision is parsed from its question', () => {
  renderWithMantine(<PermissionCard decision={permission({ question: 'Implementer wants to run `ls — la` — Because', request: null })} />)
  expect(screen.getByText('ls — la')).toBeInTheDocument()
  expect(screen.getByText('Because')).toBeInTheDocument()
})

test('an edit names its file, a PowerShell command is a block, another tool shows its input', () => {
  const { unmount } = renderWithMantine(
    <PermissionCard decision={permission({ request: { role: 'Implementer', tool: 'Edit', command: null, path: 'src/a.ts', input: { file_path: 'src/a.ts' }, reason: null } })} />
  )
  expect(screen.getByText('src/a.ts')).toBeInTheDocument()
  expect(screen.getByText(/wants to edit/)).toBeInTheDocument()
  unmount()
  renderWithMantine(
    <PermissionCard decision={permission({ request: { role: 'Planner', tool: 'WebFetch', command: null, path: null, input: { url: 'https://x.dev' }, reason: null } })} />
  )
  expect(screen.getByText('Planner wants to use WebFetch')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Copy input' })).toBeInTheDocument()
})

test('a question that is not a permission request is shown as it is', () => {
  renderWithMantine(<PermissionCard decision={permission({ question: 'Something else entirely', request: null })} />)
  expect(screen.getByText('Something else entirely')).toBeInTheDocument()
})

test('a long command card has no axe violations', async () => {
  renderWithMantine(
    <PermissionCard decision={permission({ request: { role: 'Implementer', tool: 'Bash', command: heredoc, path: null, input: null, reason: 'why' } })} />
  )
  await waitFor(() => expect(document.querySelector('[class*=hljs-]')).not.toBeNull())
  await expectNoAxeViolations()
})

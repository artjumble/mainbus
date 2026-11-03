import { screen } from '@testing-library/react'
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
  expect(screen.getByText('Implementer wants to run `pnpm install`')).toBeInTheDocument()
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
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test.each([
  ['allow_once', '✓ Answered: Allowed once'],
  ['always_allow', '✓ Answered: Always allowed in this workspace'],
  ['deny', '✓ Answered: Denied']
] as const)('an answered %s card reads "%s"', (choice, text) => {
  renderWithMantine(<PermissionCard decision={permission({ status: 'answered', answer: { kind: 'permission', choice } })} />)
  expect(screen.getByText(text)).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
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

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MergeOutcome, MergePlan, MergePreview } from '../../../shared/merge'
import { invoke } from '../api'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { MergeModal } from './MergeModal'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn() }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const TICKET = { id: 't7', number: 7, title: 'Add login' }
const LOCAL: MergePlan = { kind: 'local', base: 'main', branch: 'feat', head: 'a', how: 'fast_forward', commits: 2, checkout: '/repo', currentBranch: 'main', message: null }
const PR = (method: 'merge' | 'squash' | 'rebase'): MergePlan => ({
  kind: 'pull_request',
  base: 'main',
  branch: 'feat',
  head: 'a',
  method,
  pr: { url: 'https://github.com/o/r/pull/3', number: 3 }
})

let preview: MergePreview
let outcome: MergeOutcome
const onClose = vi.fn()

beforeEach(() => {
  mockInvoke.mockReset()
  onClose.mockReset()
  preview = { ok: true, plan: LOCAL }
  outcome = { plan: LOCAL, commit: 'b', moved: 'moved', fetchError: null }
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'ticket.mergePreview') return preview
    if (command === 'ticket.merge') return outcome
    return undefined
  })
})

const open = () => renderWithMantine(<MergeModal opened ticket={TICKET} onClose={onClose} />)

test('says a fast-forward will happen in the checkout, and asks the engine for exactly that plan', async () => {
  open()
  expect(await screen.findByText('Fast-forwards main to feat (2 commits) in your checkout, with git merge --ff-only. No merge commit.')).toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: /Delete the branch on GitHub/ })).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Merge' }))

  expect(mockInvoke).toHaveBeenCalledWith('ticket.merge', 't7', { expect: LOCAL, moveToDone: true, deleteBranch: false })
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(await screen.findByText('Merged #7')).toBeInTheDocument()
})

test.each([
  ['merge', 'with a merge commit'],
  ['squash', 'by squashing it into one commit'],
  ['rebase', 'by rebasing its commits']
] as const)('says a pull request is merged %s on GitHub and that the checkout is not touched', async (method, words) => {
  preview = { ok: true, plan: PR(method) }
  open()
  expect(await screen.findByText(new RegExp(`Merges pull request #3 into main on GitHub ${words}`))).toBeInTheDocument()
  expect(screen.getByText("Your checkout isn't touched: pull main afterwards.")).toBeInTheDocument()
})

test('has Move to Done ticked and Delete the branch unticked by default, and sends the choices', async () => {
  preview = { ok: true, plan: PR('squash') }
  open()
  const done = await screen.findByRole('checkbox', { name: /Move to Done afterwards/ })
  const del = screen.getByRole('checkbox', { name: 'Delete the branch on GitHub afterwards' })
  expect(done).toBeChecked()
  expect(del).not.toBeChecked()

  await userEvent.click(del)
  await userEvent.click(done)
  await userEvent.click(screen.getByRole('button', { name: 'Merge' }))

  expect(mockInvoke).toHaveBeenCalledWith('ticket.merge', 't7', { expect: PR('squash'), moveToDone: false, deleteBranch: true })
})

test('says a merge commit will be made, and an unchecked-out base only moves its branch', async () => {
  preview = { ok: true, plan: { ...LOCAL, how: 'merge_commit', message: 'Merge #7: Add login' } }
  const { unmount } = open()
  expect(await screen.findByText(/with a merge commit, "Merge #7: Add login"\. It has no conflicts\./)).toBeInTheDocument()
  unmount()

  preview = { ok: true, plan: { ...LOCAL, how: 'fast_forward_ref', checkout: null } }
  open()
  expect(await screen.findByText(/main isn't checked out, so no files in your checkout change\./)).toBeInTheDocument()
})

test('shows why it cannot merge and what to do, with Merge disabled', async () => {
  preview = { ok: false, reason: 'Your checkout (/repo) has uncommitted changes: a.txt', suggest: 'commit_or_stash' }
  open()
  expect(await screen.findByText('Your checkout (/repo) has uncommitted changes: a.txt')).toBeInTheDocument()
  expect(screen.getByText('Commit or stash your changes, then try again.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

test('shows GitHub\'s refusal in an alert and stays open', async () => {
  preview = { ok: true, plan: PR('merge') }
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'ticket.mergePreview') return preview
    throw new Error("Error invoking remote method 'engine:invoke': Error: GitHub refused the merge: required checks have not passed")
  })
  open()
  await userEvent.click(await screen.findByRole('button', { name: 'Merge' }))
  expect(await screen.findByText('GitHub refused the merge: required checks have not passed')).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
})

test('says the merge is done but the ticket stayed in Review when its folder is dirty', async () => {
  outcome = { ...outcome, moved: 'dirty' }
  open()
  await userEvent.click(await screen.findByRole('button', { name: 'Merge' }))
  expect(await screen.findByText(/stayed in Review/)).toBeInTheDocument()
})

test('has no accessibility violations', async () => {
  open()
  await screen.findByRole('button', { name: 'Merge' })
  await expectNoAxeViolations(document.body)
})

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { BaseBranchNotice } from './BaseBranchNotice'

function show(warning: Parameters<typeof BaseBranchNotice>[0]['warning']): { onAdd: () => void; onCancel: () => void } {
  const handlers = { onAdd: vi.fn(), onCancel: vi.fn() }
  renderWithMantine(<BaseBranchNotice warning={warning} {...handlers} />)
  return handlers
}

test('names the branch that becomes the base, and offers Add anyway and Cancel', async () => {
  const { onAdd, onCancel } = show({ branch: 'fm/hunter', notOnRemote: false, restored: false })
  expect(screen.getByText(/You're on fm\/hunter\. Mainbus uses the checked-out branch as this workspace's base/)).toBeInTheDocument()
  expect(screen.queryByText(/isn't on origin/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Add anyway' }))
  expect(onAdd).toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onCancel).toHaveBeenCalled()
  await expectNoAxeViolations()
})

test('says pull requests will fail when the branch is not on origin', () => {
  show({ branch: 'fm/hunter', notOnRemote: true, restored: false })
  expect(screen.getByText("This branch isn't on origin, so pull requests will fail.")).toBeInTheDocument()
})

test('a restored workspace says its old base is coming back', () => {
  show({ branch: 'fm/old', notOnRemote: false, restored: true })
  expect(screen.getByText(/comes back with its old base branch, fm\/old/)).toBeInTheDocument()
})

import { screen } from '@testing-library/react'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { BaseBranchNotice } from './BaseBranchNotice'

function show(warning: Parameters<typeof BaseBranchNotice>[0]['warning'], withHint = false): void {
  renderWithMantine(<BaseBranchNotice warning={warning} withHint={withHint} />)
}

test('explains that the branch becomes the base', async () => {
  show({ branch: 'fm/hunter', notOnRemote: false, restored: false })
  expect(screen.getByText(/Mainbus uses this branch as the workspace's base: every ticket starts from it/)).toBeInTheDocument()
  expect(screen.queryByText(/isn't on origin/)).not.toBeInTheDocument()
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

test('the hint to switch branches shows only when asked for', () => {
  show({ branch: 'fm/hunter', notOnRemote: false, restored: false }, true)
  expect(screen.getByText(/switch to it \(for example git switch main\)/)).toBeInTheDocument()
})

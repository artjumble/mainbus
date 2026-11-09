import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FolderReadiness, SetupPreview } from '../../../shared/api'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { GitSetup } from './GitSetup'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const plain: FolderReadiness = { status: 'not_a_repo', folder: '/r/plain', root: '/r/plain' }
const clean: SetupPreview = {
  root: '/r/plain',
  files: 3,
  bytes: 2048,
  entries: [
    { name: 'README.md', folder: false, files: 1, bytes: 10 },
    { name: 'src', folder: true, files: 2, bytes: 2038 }
  ],
  warnings: []
}
const flagged: SetupPreview = {
  ...clean,
  warnings: [
    { kind: 'secret', path: '.env', files: 1, bytes: 9 },
    { kind: 'generated', path: 'node_modules', files: 40, bytes: 4096 }
  ]
}

function engine(preview: SetupPreview, prepare: () => unknown = () => workspace): void {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'workspace.previewSetup') return preview
    if (command === 'workspace.prepare') return prepare()
    if (command === 'workspace.summaries') return []
    return { tickets: [] }
  })
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
})

function show(readiness: FolderReadiness, onDone = vi.fn(), onCancel = vi.fn()): void {
  renderWithMantine(<GitSetup readiness={readiness} onDone={onDone} onCancel={onCancel} />)
}

test('a folder without a repository says so and offers to set up, with the files option selected', async () => {
  engine(clean)
  show(plain)
  expect(screen.getByText("/r/plain isn't a git repository yet.")).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: /Commit the folder's current files/ })).toBeChecked()
  expect(await screen.findByText('3 files, 2.0 KB')).toBeInTheDocument()
  expect(screen.getByText('src/ (2 files)')).toBeInTheDocument()
  expect(screen.getByText('README.md')).toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

test('a repository without commits says which repository will be used', async () => {
  engine({ ...clean, root: '/r/repo' })
  show({ status: 'no_commits', folder: '/r/repo/sub', root: '/r/repo' })
  expect(screen.getByText('The repository at /r/repo has no commits yet.')).toBeInTheDocument()
  expect(screen.getByText(/inside the repository at \/r\/repo; Mainbus will use \/r\/repo/)).toBeInTheDocument()
  expect(await screen.findByText('3 files, 2.0 KB')).toBeInTheDocument()
})

test('a detached HEAD is explained with the commands, and cannot be set up', () => {
  show({ status: 'detached_head', folder: '/r/repo', root: '/r/repo' })
  expect(screen.getByText(/isn't on a branch/)).toBeInTheDocument()
  expect(screen.getByText('git switch <branch>')).toBeInTheDocument()
  expect(screen.getByText('git switch -c <name>')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Set up and add workspace' })).not.toBeInTheDocument()
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('warnings show, with a .gitignore checkbox that the empty commit disables', async () => {
  engine(flagged)
  show(plain)
  expect(await screen.findByText('.env: looks like a secret')).toBeInTheDocument()
  expect(screen.getByText(/node_modules\/: generated files \(40 files/)).toBeInTheDocument()
  const box = screen.getByRole('checkbox', { name: 'Add a .gitignore for the flagged items' })
  expect(box).not.toBeChecked()
  expect(box).toBeEnabled()
  await userEvent.click(screen.getByRole('radio', { name: 'Start with an empty commit' }))
  expect(screen.getByText(/existing files won't be in ticket folders until you commit them/)).toBeInTheDocument()
  expect(box).toBeDisabled()
})

test('Set up commits the files with the gitignore choice, then reports done', async () => {
  engine(flagged)
  const onDone = vi.fn()
  show(plain, onDone)
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Add a .gitignore for the flagged items' }))
  await userEvent.click(screen.getByRole('button', { name: 'Set up and add workspace' }))
  await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(mockInvoke).toHaveBeenCalledWith('workspace.prepare', '/r/plain', { commitFiles: true, writeGitignore: true })
})

test('Set up with the empty commit sends commitFiles false', async () => {
  engine(clean)
  const onDone = vi.fn()
  show(plain, onDone)
  await userEvent.click(screen.getByRole('radio', { name: 'Start with an empty commit' }))
  await userEvent.click(screen.getByRole('button', { name: 'Set up and add workspace' }))
  await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(mockInvoke).toHaveBeenCalledWith('workspace.prepare', '/r/plain', { commitFiles: false, writeGitignore: false })
})

test('an error shows with its line breaks, and the dialog stays', async () => {
  engine(clean, () => {
    throw new Error("Error invoking remote method 'engine:invoke': Error: Git doesn't know who you are.\ngit config --global user.name \"Your Name\"")
  })
  const onDone = vi.fn()
  show(plain, onDone)
  await userEvent.click(screen.getByRole('button', { name: 'Set up and add workspace' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent("Git doesn't know who you are.")
  expect(alert).toHaveTextContent('git config --global user.name "Your Name"')
  expect(onDone).not.toHaveBeenCalled()
})

test('Cancel changes nothing', async () => {
  engine(clean)
  const onCancel = vi.fn()
  show(plain, vi.fn(), onCancel)
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onCancel).toHaveBeenCalled()
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.prepare', expect.anything(), expect.anything())
})

test('has no axe violations', async () => {
  engine(flagged)
  show(plain)
  await screen.findByText('.env: looks like a secret')
  await expectNoAxeViolations()
})

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GhStatus } from '../../../shared/domain'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { renderWithMantine, workspace } from '../test-utils'
import { PullRequestSettings } from './PullRequestSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let on: boolean
let gh: GhStatus

beforeEach(() => {
  mockInvoke.mockReset()
  on = false
  gh = { ok: true }
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.get') return { ...workspace, openPrOnReview: on }
    if (command === 'workspace.setOpenPrOnReview') {
      on = args[0] as boolean
      return { ...workspace, openPrOnReview: on }
    }
    if (command === 'github.check') return gh
    return undefined
  })
})

const toggle = (): Promise<HTMLElement> => screen.findByRole('switch', { name: /^Open a PR when a ticket reaches Review/ })

test('is off by default, and switching it on saves it for the workspace', async () => {
  renderWithMantine(<PullRequestSettings opened />)
  const sw = await toggle()
  await vi.waitFor(() => expect(sw).toBeEnabled())
  expect(sw).not.toBeChecked()
  expect(mockInvoke).not.toHaveBeenCalledWith('github.check')

  await userEvent.click(sw)

  expect(mockInvoke).toHaveBeenCalledWith('workspace.setOpenPrOnReview', true)
  await vi.waitFor(() => expect(sw).toBeChecked())
  expect(useMainbus.getState().workspace?.openPrOnReview).toBe(true)
  expect(mockInvoke).toHaveBeenCalledWith('github.check')
  expect(screen.queryByText(/No PR can be opened/)).not.toBeInTheDocument()
})

test('says so when gh is missing or signed out while it is on', async () => {
  on = true
  gh = { ok: false, reason: 'the GitHub CLI (gh) is not signed in; run `gh auth login`' }
  renderWithMantine(<PullRequestSettings opened />)
  expect(
    await screen.findByText('No PR can be opened: the GitHub CLI (gh) is not signed in; run `gh auth login`.')
  ).toBeInTheDocument()

  await userEvent.click(await toggle())
  await vi.waitFor(() => expect(screen.queryByText(/No PR can be opened/)).not.toBeInTheDocument())
})

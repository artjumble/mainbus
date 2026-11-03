import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { ToolRow } from './ToolRow'

test('a ToolRow starts collapsed, showing the tool name and the result summary', () => {
  renderWithMantine(<ToolRow name="Edit" input={{ file_path: 'a.ts' }} result={{ ok: true, summary: 'Edited a.ts' }} />)
  expect(screen.getByText('Edit')).toBeInTheDocument()
  expect(screen.getByText('Edited a.ts')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Edit/ })).toHaveAttribute('aria-expanded', 'false')
})

test('expanding a ToolRow shows the tool input', async () => {
  renderWithMantine(<ToolRow name="Edit" input={{ file_path: 'a.ts' }} result={{ ok: true, summary: 'done' }} />)
  await userEvent.click(screen.getByRole('button', { name: /Edit/ }))
  expect(screen.getByRole('button', { name: /Edit/ })).toHaveAttribute('aria-expanded', 'true')
  expect(await screen.findByText(/"file_path": "a.ts"/)).toBeVisible()
})

test('a ToolRow without a result yet says it is running; a failed result is marked', () => {
  const { unmount } = renderWithMantine(<ToolRow name="Bash" input={{ command: 'ls' }} />)
  expect(screen.getByText('Running…')).toBeInTheDocument()
  unmount()
  renderWithMantine(<ToolRow name="Bash" input={{}} result={{ ok: false, summary: 'exit 1' }} />)
  expect(screen.getByText('exit 1')).toBeInTheDocument()
  expect(screen.getByText('Failed')).toBeInTheDocument()
})

test('a collapsed, expanded, running and failed row have no axe violations', async () => {
  renderWithMantine(
    <>
      <ToolRow name="Edit" input={{ file_path: 'a.ts' }} result={{ ok: true, summary: 'done' }} />
      <ToolRow name="Bash" input={{}} />
      <ToolRow name="Bash" input={{}} result={{ ok: false, summary: 'exit 1' }} />
    </>
  )
  await expectNoAxeViolations()
  await userEvent.click(screen.getByRole('button', { name: /Edit/ }))
  await expectNoAxeViolations()
})

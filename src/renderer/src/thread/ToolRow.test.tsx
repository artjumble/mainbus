import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { ToolRow, toolTarget } from './ToolRow'

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

test.each([
  ['Read', { file_path: 'C:\\Users\\dev\\AppData\\Local\\Mainbus\\work\\web-app\\42-add-csv-export\\src\\reports\\renderers\\table.ts' }],
  ['PowerShell', { command: 'Get-ChildItem -Recurse -Filter *.ts src\\renderer\\src\\thread | Select-String -Pattern "ToolRow" -SimpleMatch' }]
])('in a narrow row with a long target, the %s tag keeps its width and never scrolls; the target is cut short', (name, input) => {
  renderWithMantine(
    <div style={{ width: 160 }}>
      <ToolRow name={name} input={input} result={{ ok: true, summary: '42 lines' }} />
    </div>
  )
  const tag = document.querySelector<HTMLElement>('[data-tool-tag]')!
  expect(tag).toHaveTextContent(name)
  // jsdom has no layout, so the measured check is in the artboard e2e test; here, the styles that keep the tag whole.
  expect(getComputedStyle(tag).flexShrink).toBe('0')
  expect(getComputedStyle(tag).overflow).toBe('visible')
  const label = tag.querySelector<HTMLElement>('.mantine-Badge-label')!
  expect(getComputedStyle(label).overflow).toBe('visible')
  expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
  const target = document.querySelector<HTMLElement>('[data-tool-target]')!
  expect(target).toHaveAttribute('title', toolTarget(input))
  expect(target).toHaveAttribute('data-truncate', 'end')
})

test('a ToolRow names what the tool acted on, from its input', () => {
  renderWithMantine(<ToolRow name="Read" input={{ file_path: 'tests/fixtures/cart.ts' }} result={{ ok: true, summary: '42 lines' }} />)
  expect(screen.getByText('tests/fixtures/cart.ts')).toBeInTheDocument()
  expect(toolTarget({ pattern: 'TODO' })).toBe('TODO')
  expect(toolTarget({})).toBeNull()
  expect(toolTarget('x')).toBeNull()
})

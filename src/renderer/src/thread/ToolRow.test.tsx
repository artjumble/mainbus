import { screen, waitFor } from '@testing-library/react'
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
  const { container } = renderWithMantine(<ToolRow name="Edit" input={{ file_path: 'a.ts' }} result={{ ok: true, summary: 'done' }} />)
  await userEvent.click(screen.getByRole('button', { name: /Edit/ }))
  expect(screen.getByRole('button', { name: /Edit/ })).toHaveAttribute('aria-expanded', 'true')
  await waitFor(() => expect(container.querySelector('pre code')).toHaveTextContent('"file_path": "a.ts"'))
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

test('the input is a JSON block, and a shell command is a shell block above the rest', async () => {
  const { container } = renderWithMantine(
    <>
      <ToolRow name="Read" input={{ file_path: 'a.ts' }} result={{ ok: true, summary: 'done' }} />
      <ToolRow name="Bash" input={{ command: 'ls -la', description: 'List' }} result={{ ok: true, summary: 'done' }} />
    </>
  )
  for (const button of screen.getAllByRole('button', { name: /Read|Bash/ })) await userEvent.click(button)
  await waitFor(() => expect(screen.getAllByText('json')).toHaveLength(2))
  expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Copy input' })).toHaveLength(2)
  const blocks = (): (string | null)[] => Array.from(container.querySelectorAll('pre code')).map((c) => c.textContent)
  await waitFor(() => expect(blocks()).toEqual(['{\n  "file_path": "a.ts"\n}', 'ls -la', '{\n  "description": "List"\n}']))
  await expectNoAxeViolations()
})

test('in a narrow row with a very long command, the Failed tag and the name tag stay whole', () => {
  const command = `git log --oneline ${'--format=%H%n%an%n%s '.repeat(20)}| grep -v fixup`
  renderWithMantine(
    <div style={{ width: 160 }}>
      <ToolRow name="Bash" input={{ command }} result={{ ok: false, summary: 'exit 1: a long failure message' }} />
    </div>
  )
  // jsdom has no layout, so these are the styles that keep the tags whole (the artboard e2e test measures the name tag only).
  for (const [selector, text] of [['[data-failed-tag]', 'Failed'], ['[data-tool-tag]', 'Bash']] as const) {
    const tag = document.querySelector<HTMLElement>(selector)!
    expect(tag).toHaveTextContent(new RegExp(`^${text}$`))
    expect(getComputedStyle(tag).flexShrink).toBe('0')
    expect(getComputedStyle(tag).overflow).toBe('visible')
    const label = tag.querySelector<HTMLElement>('.mantine-Badge-label')!
    expect(getComputedStyle(label).overflow).toBe('visible')
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
  }
})

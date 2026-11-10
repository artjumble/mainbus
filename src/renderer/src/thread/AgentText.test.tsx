import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { AgentText } from './Thread'

const fence = (lang: string, body: string): string => '```' + lang + '\n' + body + '\n```'

test('a ts fence is highlighted, labelled, copyable and monospaced', async () => {
  const { container } = renderWithMantine(<AgentText text={'Here:\n\n' + fence('ts', 'const x: number = 1 // one')} />)
  await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
  expect(container.querySelector('.hljs-comment')?.textContent).toBe('// one')
  expect(container.querySelector('pre code')?.textContent).toBe('const x: number = 1 // one')
  expect(screen.getByText('ts')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
})

test('json and bash fences are highlighted', async () => {
  const { container } = renderWithMantine(<AgentText text={fence('json', '{ "a": 1 }') + '\n\n' + fence('bash', 'echo "hi" && ls')} />)
  await waitFor(() => expect(container.querySelectorAll('.hljs-number, .hljs-string, .hljs-attr').length).toBeGreaterThan(2))
  expect(container.querySelector('.hljs-number')?.textContent).toBe('1')
  expect(container.querySelector('.hljs-built_in')?.textContent).toBe('echo')
  expect(screen.getByText('json')).toBeInTheDocument()
  expect(screen.getByText('bash')).toBeInTheDocument()
})

test('a fence with no language, or one that is not loaded, stays plain text', async () => {
  const { container } = renderWithMantine(<AgentText text={fence('', 'plain <b>text</b>') + '\n\n' + fence('python', 'print("<i>x</i>")')} />)
  expect(await screen.findByText('text')).toBeInTheDocument()
  expect(screen.getByText('python')).toBeInTheDocument()
  expect(container.querySelector('pre b')).toBeNull()
  expect(container.querySelector('pre i')).toBeNull()
  expect(container.querySelectorAll('pre code')[0]?.textContent).toBe('plain <b>text</b>')
  expect(container.querySelectorAll('pre code')[1]?.textContent).toBe('print("<i>x</i>")')
})

test('inline code is a code element and not a block', () => {
  const { container } = renderWithMantine(<AgentText text="Run `npm test` now" />)
  expect(screen.getByText('npm test').tagName).toBe('CODE')
  expect(container.querySelector('pre')).toBeNull()
  expect(screen.queryByRole('button', { name: /Copy/ })).not.toBeInTheDocument()
})

test('raw HTML is still not rendered, in a paragraph or in a fence', async () => {
  const text = '<img src="x" onerror="1"> <script>window.hacked = 1</script>\n\n' + fence('html', '<img src="y" onerror="1"><script>1</script>')
  const { container } = renderWithMantine(<AgentText text={text} />)
  await screen.findByText('html')
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('pre code')?.textContent).toBe('<img src="y" onerror="1"><script>1</script>')
})

test('links still open outside the app', () => {
  renderWithMantine(<AgentText text="[docs](https://example.com/a)" />)
  expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('target', '_blank')
})

test('Copy writes the code', async () => {
  const write = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
  renderWithMantine(<AgentText text={fence('ts', 'const a = 1')} />)
  await userEvent.click(screen.getByRole('button', { name: 'Copy code' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
})

test('a message with code has no axe violations', async () => {
  const { container } = renderWithMantine(<AgentText text={'Text `inline`\n\n' + fence('ts', 'const x = 1\n'.repeat(30))} />)
  await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
  await expectNoAxeViolations()
})

const TABLE = '| Name | Qty | Note |\n|:---|:---:|---:|\n| **a** | 1 | `x` |\n| b | 2 | [l](https://example.com) |'

test('a markdown table renders as a table with headers and alignment, and inline formatting', () => {
  const { container } = renderWithMantine(<AgentText text={TABLE} />)
  expect(container.querySelector('table')).not.toBeNull()
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Qty', 'Note'])
  expect(screen.getByRole('columnheader', { name: 'Qty' })).toHaveStyle({ textAlign: 'center' })
  expect(screen.getByRole('columnheader', { name: 'Note' })).toHaveStyle({ textAlign: 'right' })
  expect(screen.getByText('a').tagName).toBe('STRONG')
  expect(screen.getByText('x').tagName).toBe('CODE')
  expect(screen.getByRole('link', { name: 'l' })).toHaveAttribute('target', '_blank')
})

test('a table sits in its own scrollable box', () => {
  const { container } = renderWithMantine(<AgentText text={TABLE} />)
  const box = container.querySelector('table')?.parentElement
  expect(box?.getAttribute('role')).toBe('region')
  expect(box?.className).toMatch(/tableScroll/)
})

test('task lists show read-only checkboxes', () => {
  renderWithMantine(<AgentText text={'- [x] done\n- [ ] todo'} />)
  const boxes = screen.getAllByRole('checkbox')
  expect(boxes).toHaveLength(2)
  boxes.forEach((b) => expect(b).toBeDisabled())
  expect(boxes[0]).toBeChecked()
  expect(boxes[1]).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Done' })).toBeInTheDocument()
})

test('strikethrough and autolinks render', () => {
  const { container } = renderWithMantine(<AgentText text="~~gone~~ see https://example.com/x" />)
  expect(container.querySelector('del')?.textContent).toBe('gone')
  expect(screen.getByRole('link', { name: 'https://example.com/x' })).toHaveAttribute('target', '_blank')
})

test('a table and a task list have no axe violations', async () => {
  renderWithMantine(<AgentText text={TABLE + '\n\n- [x] done\n- [ ] todo'} />)
  await expectNoAxeViolations()
})

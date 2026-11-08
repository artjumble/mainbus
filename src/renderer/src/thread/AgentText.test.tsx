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

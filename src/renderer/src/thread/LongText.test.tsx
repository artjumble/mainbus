/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoredEvent, ThreadEvent } from '../../../shared/events'
import { makeEvent, renderWithMantine } from '../test-utils'
import { Thread } from './Thread'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))

const ev = (event: ThreadEvent): StoredEvent => makeEvent(event)
const RUNS = { r1: { id: 'r1', ticketRunId: 'tr1', role: 'Implementer' } }
const LONG_LINE = '='.repeat(300)
const LONG_URL = 'https://example.com/' + 'a/'.repeat(150)

const css = readFileSync(join(process.cwd(), 'src/renderer/src/thread/Thread.module.css'), 'utf8')
// jsdom does no layout, so these check the rules that make the text wrap, not the widths.
const rule = (selector: string): string => new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''

function renderThread(events: ThreadEvent[]): HTMLElement {
  return renderWithMantine(<Thread events={events.map(ev)} decisions={[]} runs={RUNS} />).container
}

test('the plain-text rule keeps line breaks and wraps a run with no break opportunity', () => {
  expect(rule('.wrap')).toMatch(/white-space:\s*pre-wrap/)
  expect(rule('.wrap')).toMatch(/overflow-wrap:\s*anywhere/)
})

test('a user message, a notice and an error carry the wrap rule', () => {
  const container = renderThread([
    ({ kind: 'user_message', text: `log\n${LONG_LINE}\n${LONG_URL}` }),
    ({ kind: 'notice', text: LONG_URL }),
    ({ kind: 'error', message: LONG_LINE })
  ])
  for (const kind of ['user_message', 'notice', 'error']) {
    expect(container.querySelector(`[data-event="${kind}"]`)!.className).toMatch(/wrap/)
  }
  expect(container.querySelector('[data-event="user_message"]')!.textContent).toContain(LONG_LINE)
})

test('agent markdown wraps a long URL and a long word, and its code blocks keep to themselves', () => {
  const container = renderThread([
    ({ kind: 'message', text: `See ${LONG_URL} and \`${LONG_LINE}\`\n\n\`\`\`bash\n${LONG_LINE}\n\`\`\`` })
  ])
  const markdown = container.querySelector('[data-event="message"] > div:last-child') as HTMLElement
  expect(markdown.className).toMatch(/markdown/)
  expect(rule('.markdown')).toMatch(/overflow-wrap:\s*anywhere/)
  expect(css).toMatch(/\.markdown pre,\s*\.markdown pre code\s*\{[^}]*overflow-wrap:\s*normal/)
  expect(container.querySelector('pre code')!.textContent).toBe(LONG_LINE)
})

test('the thread never scrolls sideways', () => {
  const container = renderThread([({ kind: 'user_message', text: LONG_LINE })])
  const scroller = container.querySelector('[data-event]')!.closest('[style*="overflow-y"]') as HTMLElement
  expect(scroller).toHaveStyle({ overflowX: 'hidden', minWidth: '0' })
})

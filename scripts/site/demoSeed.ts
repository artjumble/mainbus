import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { FakeScriptFile, FakeStep } from '../../src/engine/runtime/fakeRuntime'
import { branchName, folderName } from '../../src/engine/git/slug'

/**
 * The fictional demo board the marketing site's screenshots show: two small repositories (a web shop and a notes app),
 * their tickets, and the FakeRuntime script every agent plays. Nothing here comes from a real board or a real person.
 */

/** The git identity of the demo repositories: Investigate reports are committed with it. */
export const DEMO_GIT = { name: 'Demo Developer', email: 'demo@example.com' }

/** The demo's folders as the screenshots show them, in place of the temporary folder the run really uses. */
export const DEMO_PROJECTS = 'C:\\Users\\demo\\Projects'
export const DEMO_HOME = 'C:\\Users\\demo\\AppData\\Local\\Mainbus'

const MIN = 60_000

export type WorkspaceKey = 'acme-web' | 'field-notes'

export interface DemoTicket {
  /** The ticket's number in its workspace: tickets are created in this order, so the numbers are fixed. */
  n: number
  title: string
  intent: string
  spec: string
  criteria: string[]
  labels: string[]
  column: 'backlog' | 'ready'
  kind?: 'investigate'
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', `user.name=${DEMO_GIT.name}`, '-c', `user.email=${DEMO_GIT.email}`, ...args], { cwd, windowsHide: true, stdio: 'pipe' })
}

function writeRepo(dir: string, files: Record<string, string>, message: string): string {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  // Repo-local, so the reports Mainbus commits with the user's identity carry the demo's.
  git(dir, 'config', 'user.name', DEMO_GIT.name)
  git(dir, 'config', 'user.email', DEMO_GIT.email)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', message)
  return dir
}

/** Makes the two throwaway repositories in `parent`, with a little real-looking code, and returns their paths. */
export function makeDemoRepos(parent: string): Record<WorkspaceKey, string> {
  const acme = writeRepo(
    path.join(parent, 'acme-web'),
    {
      'README.md': '# acme-web\n\nThe Acme storefront: product pages, the cart and checkout.\n\n```\npnpm install\npnpm dev\n```\n',
      'package.json': JSON.stringify(
        { name: 'acme-web', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', typecheck: 'tsc --noEmit' } },
        null,
        2
      ) + '\n',
      'src/cart/total.ts':
        "import type { LineItem } from './types'\n\n/** The cart's total, in the currency's major unit. */\nexport function sumLineItems(items: LineItem[]): number {\n  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)\n}\n",
      'src/cart/types.ts': 'export interface LineItem {\n  sku: string\n  price: number\n  quantity: number\n}\n',
      'src/cart/checkout.ts':
        "import { sumLineItems } from './total'\nimport type { LineItem } from './types'\n\nexport interface Checkout {\n  items: LineItem[]\n  postcode: string\n}\n\nexport function orderTotal(checkout: Checkout): number {\n  return sumLineItems(checkout.items)\n}\n",
      'src/cart/total.test.ts':
        "import { expect, test } from 'vitest'\nimport { sumLineItems } from './total'\n\ntest('rounds totals to the cent', () => {\n  expect(sumLineItems([{ sku: 'mug', price: 6.663, quantity: 3 }])).toBe(19.99)\n})\n",
      'src/api/webhooks.ts':
        "export interface PaymentEvent {\n  id: string\n  type: 'payment.succeeded' | 'payment.failed'\n}\n\nexport async function handlePaymentWebhook(event: PaymentEvent): Promise<void> {\n  // TODO: retry when the order service is down\n  await fetch('/internal/orders', { method: 'POST', body: JSON.stringify(event) })\n}\n",
      'src/shipping/rates.ts':
        "/** Days from dispatch to delivery, by the first letters of the postcode. */\nexport const DELIVERY_DAYS: Record<string, number> = { N: 1, E: 1, SW: 2, M: 2, EH: 3 }\n"
    },
    'Storefront with cart and checkout'
  )
  const notes = writeRepo(
    path.join(parent, 'field-notes'),
    {
      'README.md': '# field-notes\n\nA small notes app that works offline and syncs when it can.\n',
      'package.json': JSON.stringify({ name: 'field-notes', private: true, type: 'module', scripts: { dev: 'vite' } }, null, 2) + '\n',
      'src/sync/queue.ts':
        "import type { Edit } from '../notes/types'\n\nconst pending: Edit[] = []\n\nexport function enqueue(edit: Edit): void {\n  pending.push(edit)\n}\n\nexport function drain(): Edit[] {\n  return pending.splice(0)\n}\n",
      'src/sync/merge.ts':
        "import type { Note } from '../notes/types'\n\n/** The server's copy wins when both changed. */\nexport function merge(local: Note, remote: Note): Note {\n  return remote.updatedAt >= local.updatedAt ? remote : local\n}\n",
      'src/notes/types.ts':
        'export interface Note {\n  id: string\n  body: string\n  updatedAt: number\n}\n\nexport interface Edit {\n  noteId: string\n  body: string\n  at: number\n}\n'
    },
    'Notes with offline sync'
  )
  return { 'acme-web': acme, 'field-notes': notes }
}

export const TICKETS: Record<WorkspaceKey, DemoTicket[]> = {
  'acme-web': [
    {
      n: 1,
      title: 'Show delivery estimates at checkout',
      intent: 'People keep emailing to ask when their order will arrive. Show an estimated delivery date at checkout, based on the postcode.',
      spec: 'Add `estimateDelivery(postcode, now)` in `src/shipping/` using the existing `DELIVERY_DAYS` table, skipping weekends. Show "Arrives by <date>" under the order total once a postcode is entered.',
      criteria: ['The estimate skips Saturdays and Sundays', 'An unknown postcode shows no estimate rather than a wrong one', 'Unit tests cover both'],
      labels: ['checkout', 'shipping'],
      column: 'ready'
    },
    {
      n: 2,
      title: 'Retry failed payment webhooks',
      intent: 'When the order service is down, payment webhooks are lost. Retry them a few times before giving up, and log the ones that still fail.',
      spec: 'Wrap `handlePaymentWebhook` in a retry with exponential backoff (1 s, 4 s, 16 s). Retry only network errors and 5xx responses. After the last attempt, log the event id at error level.',
      criteria: ['Retries up to three times with exponential backoff', 'A 4xx response is not retried', 'Failures after the last attempt are logged with the event id'],
      labels: ['payments', 'reliability'],
      column: 'ready'
    },
    {
      n: 3,
      title: 'Format prices for each currency',
      intent: 'Prices show as 19.9 instead of £19.90, and euro prices use the wrong separator. Format them properly for each currency.',
      spec: '',
      criteria: [],
      labels: ['i18n'],
      column: 'ready'
    },
    {
      n: 4,
      title: 'Upgrade the payments SDK to v5',
      intent: 'v4 of the payments SDK is end of life in March. Upgrade to v5.',
      spec: 'Bump the SDK, follow the migration guide for `createIntent`, and keep the existing tests passing.',
      criteria: ['The SDK is on v5', 'Checkout tests pass'],
      labels: ['payments', 'dependencies'],
      column: 'ready'
    },
    {
      n: 5,
      title: 'Fix the flaky cart total test',
      intent: 'The cart total test fails about one run in five. Find out why and fix it properly, not with a retry.',
      spec: 'The failure is a rounding difference in `sumLineItems`. Fix the calculation rather than loosening the assertion.',
      criteria: ['The test passes 50 runs in a row', 'Totals are rounded to the cent in one place'],
      labels: ['cart', 'tests'],
      column: 'ready'
    },
    {
      n: 6,
      title: 'Rate-limit the login endpoint',
      intent: 'Someone is trying passwords against /login. Limit attempts per account and per IP.',
      spec: '',
      criteria: [],
      labels: ['security'],
      column: 'ready'
    },
    {
      n: 7,
      title: 'Add a sitemap.xml',
      intent: 'Search engines should find every product page. Generate a sitemap.xml at build time.',
      spec: 'Write `dist/sitemap.xml` from the product catalogue during `pnpm build`.',
      criteria: ['Every product page is listed', 'The file validates against the sitemap schema'],
      labels: ['seo'],
      column: 'ready'
    },
    {
      n: 8,
      title: 'Support discount codes',
      intent: 'Marketing wants discount codes for the spring sale: a percentage off, with an expiry date.',
      spec: '',
      criteria: [],
      labels: ['checkout'],
      column: 'ready'
    },
    {
      n: 9,
      title: 'Dark mode for the storefront',
      intent: 'Follow the visitor’s system setting for light and dark.',
      spec: '',
      criteria: [],
      labels: ['design'],
      column: 'backlog'
    },
    {
      n: 10,
      title: 'Move product images to a CDN',
      intent: 'Product images are slow to load abroad. Serve them from a CDN.',
      spec: '',
      criteria: [],
      labels: ['performance'],
      column: 'backlog'
    },
    {
      n: 11,
      title: 'Add an order history page',
      intent: 'Signed-in customers should see their past orders.',
      spec: '',
      criteria: [],
      labels: ['account'],
      column: 'backlog'
    },
    {
      n: 12,
      title: 'Tidy up the README',
      intent: 'The README still describes the old deploy script.',
      spec: '',
      criteria: [],
      labels: ['docs'],
      column: 'backlog'
    }
  ],
  'field-notes': [
    {
      n: 1,
      title: 'Why do offline edits go missing after sync?',
      intent: 'Two people said notes they edited on the train were back to the old text once they were online again. Find out why before we change anything.',
      spec: '',
      criteria: [],
      labels: ['sync', 'bug'],
      column: 'ready',
      kind: 'investigate'
    },
    {
      n: 2,
      title: 'Export notes as Markdown',
      intent: 'Let people export all their notes as a zip of Markdown files.',
      spec: 'One file per note, named after its first line, with the date in the front matter.',
      criteria: ['Every note is exported', 'File names are unique and safe on Windows and macOS'],
      labels: ['export'],
      column: 'ready'
    },
    {
      n: 3,
      title: 'Filter notes by tag',
      intent: 'A tag list in the sidebar that filters the notes.',
      spec: '',
      criteria: [],
      labels: ['ui'],
      column: 'backlog'
    },
    {
      n: 4,
      title: 'Fix the week view’s date header',
      intent: 'The week view shows the wrong month on the first of the month.',
      spec: '',
      criteria: [],
      labels: ['bug'],
      column: 'backlog'
    }
  ]
}

/** The ticket of `ws` numbered `n`. */
export function ticket(ws: WorkspaceKey, n: number): DemoTicket {
  return TICKETS[ws].find((t) => t.n === n)!
}

/** A file in a ticket's worktree, as the demo's tool rows show it (the fictional data home, not the real one). */
function wt(ws: WorkspaceKey, n: number, rel: string): string {
  return [DEMO_HOME, 'work', ws, folderName(n, ticket(ws, n).title), ...rel.split('/')].join('\\')
}

let ids = 0
const say = (text: string): FakeStep => ({ emit: { kind: 'message', text } })
const think = (text: string, seconds: number): FakeStep => ({ emit: { kind: 'thinking', text, durationMs: seconds * 1000 } })
const session = (id: string): FakeStep => ({ emit: { kind: 'session', sessionId: `demo-${id}` } })
const turnEnd: FakeStep = { emit: { kind: 'turn_end', ok: true } }
const wait: FakeStep = { waitForSend: true }
const later = (minutes: number): FakeStep => ({ advanceClock: Math.round(minutes * MIN) })
const usage = (seconds: number, input = 18_000, output = 2_400): FakeStep => ({
  emit: { kind: 'usage', inputTokens: input, outputTokens: output, cacheReadTokens: input * 4, cacheWriteTokens: 0, models: {}, durationMs: seconds * 1000 }
})

/** A tool call and its result; with `minutes`, the fake clock moves on while it runs. */
function tool(name: string, input: unknown, summary: string, opts: { ok?: boolean; minutes?: number } = {}): FakeStep[] {
  const id = `demo-tool-${++ids}`
  return [
    { emit: { kind: 'tool_call', id, name, input } },
    ...(opts.minutes ? [later(opts.minutes)] : []),
    { emit: { kind: 'tool_result', id, ok: opts.ok ?? true, summary } }
  ]
}
const bash = (command: string, summary: string, opts: { ok?: boolean; minutes?: number } = {}): FakeStep[] => tool('Bash', { command }, summary, opts)
const read = (file: string, summary: string, minutes?: number): FakeStep[] => tool('Read', { file_path: file }, summary, minutes ? { minutes } : {})
const grep = (pattern: string, summary: string): FakeStep[] => tool('Grep', { pattern, path: 'src' }, summary)
const edit = (file: string, minutes?: number): FakeStep[] => tool('Edit', { file_path: file, old_string: '…', new_string: '…' }, 'Updated', minutes ? { minutes } : {})
const handoff = (summary: string, notesForNext: string): FakeStep => ({ callTool: 'handoff', args: { summary, notesForNext } })
const tick = (index: number): FakeStep => ({ callTool: 'checkCriterion', args: { index } })
/** A real commit in the ticket's worktree, and the Bash row an agent's commit would show. */
function commit(message: string, files: Record<string, string>): FakeStep[] {
  return [
    ...Object.entries(files).map(([p, content]): FakeStep => ({ writeFile: { path: p, content } })),
    { git: ['add', '.'] },
    { git: ['commit', '-m', message] },
    ...bash(`git add -A && git commit -m "${message}"`, '1 commit')
  ]
}

const ESTIMATE_TS = `import { DELIVERY_DAYS } from './rates'

/** The day an order placed at \`now\` arrives, skipping weekends; null for a postcode with no rate. */
export function estimateDelivery(postcode: string, now: Date): Date | null {
  const area = Object.keys(DELIVERY_DAYS).find((prefix) => postcode.toUpperCase().startsWith(prefix))
  if (area === undefined) return null
  const day = new Date(now)
  for (let left = DELIVERY_DAYS[area]!; left > 0; ) {
    day.setDate(day.getDate() + 1)
    if (day.getDay() !== 0 && day.getDay() !== 6) left--
  }
  return day
}
`

const RETRY_TS = `const DELAYS_MS = [1_000, 4_000, 16_000]

/** Runs \`send\` again after each delay while it fails with a network error or a 5xx response. */
export async function withRetry(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await send().catch(() => null)
    if (res && res.status < 500) return res
    if (attempt === DELAYS_MS.length) throw new Error('gave up after ' + (attempt + 1) + ' attempts')
    await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]))
  }
}
`

const REPORT = `## Summary

Offline edits are lost when the same note was also changed on another device while this one was offline. \`merge()\` in \`src/sync/merge.ts\` keeps whichever copy has the later \`updatedAt\`, and a queued edit carries the time it was **made**, so an edit made offline always looks older than one made online since.

## What happens

1. On the train, the note is edited at 08:10. \`enqueue()\` stores the edit with \`at: 08:10\`.
2. At 08:40 the same note is changed on the laptop, so the server copy has \`updatedAt: 08:40\`.
3. At 09:05 the phone is back online. \`drain()\` sends the edit stamped 08:10, \`merge()\` compares it with the server's 08:40, and the server's copy wins.

The text typed on the train is dropped without a trace. Nothing is logged.

## Evidence

- \`src/sync/merge.ts:4\`: last-writer-wins on \`updatedAt\` alone.
- \`src/sync/queue.ts\`: edits keep only the note id, the body and a time; there is no base version to detect a conflict.
- No test covers two edits to the same note from different devices.

## Options

| Option | Trade-off |
|---|---|
| Keep both versions and flag a conflict | Small change; no data lost, the person picks. |
| Three-way merge of the text | Needs the base version in each edit. |
| Lock notes while offline | Stops the loss, but blocks real use. |

## Recommendation

Store the base version in each queued edit, and when the server copy changed since, keep both and show a conflict banner. A three-way merge can follow later.
`

/** The FakeRuntime script for the whole demo; `resetsAt` (Unix seconds) is when the usage limit at the end resets. */
export function demoScript(resetsAt: number): FakeScriptFile {
  ids = 0
  return {
    // Anything without a script of its own stays open and quiet.
    '*': [],
    'acme-web#1': {
      Planner: [
        session('a1-planner'),
        say('Reading the checkout flow and the shipping rates.'),
        ...read(wt('acme-web', 1, 'src/cart/checkout.ts'), '11 lines', 1),
        ...grep('DELIVERY_DAYS', '1 file'),
        ...read(wt('acme-web', 1, 'src/shipping/rates.ts'), '2 lines', 1),
        think('The rates table is keyed by postcode prefix, so the longest matching prefix should win. Weekends need skipping.', 6),
        later(2),
        // A turn's recorded time, as long as its log says it took.
        usage(4 * 60),
        say('Plan: a pure `estimateDelivery(postcode, now)` beside the rates table, and a line under the order total. Unknown postcodes show nothing.'),
        handoff(
          'Plan: add estimateDelivery() in src/shipping/estimate.ts using DELIVERY_DAYS and skipping weekends; render "Arrives by <date>" under the total in checkout.',
          'Keep it pure (pass `now` in) so the tests can pin the date. An unknown postcode returns null.'
        ),
        turnEnd
      ],
      Implementer: [
        session('a1-implementer'),
        say('Writing `estimateDelivery` first, then the checkout line.'),
        ...read(wt('acme-web', 1, 'src/shipping/rates.ts'), '2 lines'),
        { writeFile: { path: 'src/shipping/estimate.ts', content: ESTIMATE_TS } },
        ...edit(wt('acme-web', 1, 'src/shipping/estimate.ts'), 2),
        ...edit(wt('acme-web', 1, 'src/cart/checkout.ts'), 1),
        ...bash('pnpm test src/shipping', '6 passed', { minutes: 3 }),
        say('Tests pass, including Friday orders landing on Monday.'),
        ...bash('pnpm typecheck', 'No errors', { minutes: 2 }),
        ...commit('Show delivery estimates at checkout', {
          'src/shipping/estimate.test.ts': "import { expect, test } from 'vitest'\nimport { estimateDelivery } from './estimate'\n\ntest('skips weekends', () => {\n  expect(estimateDelivery('N1 9GU', new Date('2026-11-06'))?.getDay()).toBe(1)\n})\n"
        }),
        tick(0),
        tick(1),
        later(1),
        usage(9 * 60),
        handoff('Added estimateDelivery() with tests, and the "Arrives by" line under the order total.', 'Check the unknown-postcode case in the UI too.'),
        turnEnd
      ],
      Reviewer: [
        session('a1-reviewer'),
        ...bash('git diff main...HEAD --stat', '3 files changed, 41 insertions(+)', { minutes: 1 }),
        ...read(wt('acme-web', 1, 'src/shipping/estimate.ts'), '14 lines'),
        ...bash('pnpm test', '19 passed', { minutes: 3 }),
        tick(2),
        say('Weekends are skipped, an unknown postcode shows nothing, and both have tests. Ready for you.'),
        later(1),
        usage(5 * 60),
        handoff('Reviewed: all three criteria hold, tests pass.', 'none'),
        turnEnd
      ]
    },
    'acme-web#2': {
      Planner: [
        session('a2-planner'),
        say('Reading the webhook handler.'),
        ...read(wt('acme-web', 2, 'src/api/webhooks.ts'), '10 lines'),
        ...grep('handlePaymentWebhook', '2 files'),
        handoff('Plan: a small withRetry() helper (1 s, 4 s, 16 s) around the POST in handlePaymentWebhook; log the event id after the last attempt.', 'Only network errors and 5xx are retryable.'),
        turnEnd
      ],
      Implementer: [
        session('a2-implementer'),
        say('Adding `withRetry` and wrapping the POST.'),
        { writeFile: { path: 'src/api/retry.ts', content: RETRY_TS } },
        ...edit(wt('acme-web', 2, 'src/api/retry.ts')),
        ...edit(wt('acme-web', 2, 'src/api/webhooks.ts')),
        ...bash('pnpm test src/api', '8 passed'),
        ...commit('Retry failed payment webhooks', {}),
        tick(0),
        handoff('Added withRetry() with exponential backoff and wrapped the order POST.', 'Logging is in the catch at the end.'),
        turnEnd
      ],
      Reviewer: [
        session('a2-reviewer'),
        ...bash('git diff main...HEAD', '2 files changed, 24 insertions(+), 1 deletion(-)'),
        ...read(wt('acme-web', 2, 'src/api/retry.ts'), '11 lines'),
        think('`res.status < 500` returns on 4xx, good. But a fetch that throws is caught as null and retried, which is right... and a 429 returns at once. The criterion says 4xx is not retried: that holds. The logging, though, is missing.', 9),
        say('Retries and backoff are right, but nothing is logged when the last attempt fails: the error is thrown and swallowed by the caller.'),
        tick(1),
        { callTool: 'reportProblem', args: { details: 'Criterion 3 is not met: after the last attempt the error is thrown, but handlePaymentWebhook never logs the event id. Add a logger.error with event.id before rethrowing, and a test for it.' } },
        turnEnd
      ],
      'Implementer resumed': [
        say('Adding the log line and a test for it.'),
        ...edit(wt('acme-web', 2, 'src/api/webhooks.ts')),
        ...bash('pnpm test src/api', '9 passed'),
        ...commit('Log webhooks that still fail after retrying', { 'src/api/webhooks.log.ts': '// logged with the event id\n' }),
        handoff('Failures after the last attempt are now logged with the event id, with a test.', 'Look again at criterion 3.'),
        turnEnd
      ],
      'Reviewer resumed': [
        say('Checking the new log line and running the API tests again.'),
        ...read(wt('acme-web', 2, 'src/api/webhooks.ts'), '17 lines'),
        { emit: { kind: 'tool_call', id: 'demo-a2-running', name: 'Bash', input: { command: 'pnpm test src/api --reporter=verbose' } } },
        wait
      ]
    },
    'acme-web#3': {
      Planner: [
        session('a3-planner'),
        say('Looking for every place a price is turned into text.'),
        ...grep('toFixed\\(|price\\b', '5 files'),
        ...read(wt('acme-web', 3, 'src/cart/checkout.ts'), '11 lines'),
        {
          callTool: 'askUser',
          args: {
            question: 'Prices are formatted by hand in five places. Should I switch them all to the built-in Intl.NumberFormat, or add a money library such as dinero.js?',
            options: ['Intl.NumberFormat, no new dependency', 'dinero.js, which also handles currency arithmetic'],
            recommended: 0
          }
        },
        turnEnd,
        wait
      ]
    },
    'acme-web#4': {
      Planner: [
        session('a4-planner'),
        handoff('Plan: bump to v5, rename createIntent to paymentIntents.create, update the two call sites.', 'The migration guide is in node_modules/@acme-pay/sdk/MIGRATING.md after install.'),
        turnEnd
      ],
      Implementer: [
        session('a4-implementer'),
        say('Bumping the SDK and following the migration guide.'),
        ...edit(wt('acme-web', 4, 'package.json')),
        ...bash('pnpm install', 'Packages: +3 -3'),
        ...edit(wt('acme-web', 4, 'src/cart/checkout.ts')),
        ...bash('pnpm test src/cart', '12 passed'),
        ...commit('Upgrade the payments SDK to v5', { 'src/payments/sdk-version.txt': '5.0.2\n' }),
        tick(0),
        tick(1),
        say('Pushing the branch so CI can run the payment sandbox tests.'),
        { requestPermission: { toolName: 'Bash', input: { command: `git push origin ${branchName(4, ticket('acme-web', 4).title)}` }, toolUseId: 'demo-push' } },
        wait
      ]
    },
    'acme-web#5': {
      Planner: [
        session('a5-planner'),
        handoff('Plan: reproduce the failure, then fix the rounding in sumLineItems.', 'It fails on floating-point sums.'),
        turnEnd
      ],
      Implementer: [
        session('a5-implementer'),
        say('Reproducing the failure first.'),
        ...read(wt('acme-web', 5, 'src/cart/total.test.ts'), '6 lines'),
        ...[1, 2, 3, 4, 5].flatMap(() =>
          bash('pnpm test src/cart/total.test.ts', 'FAIL rounds totals to the cent: expected 19.99, received 19.988999999999997', { ok: false })
        ),
        wait,
        say('Right: the rounding belongs in `sumLineItems`, not the test. Rounding each line to the cent there.'),
        ...edit(wt('acme-web', 5, 'src/cart/total.ts')),
        wait
      ]
    },
    'acme-web#6': {
      Planner: [
        session('a6-planner'),
        say('Reading how sessions and /login are handled.'),
        ...grep('login', '3 files'),
        {
          callTool: 'askUser',
          args: {
            question: 'Where should the attempt counts live? Redis is shared by every server, but the shop runs on one server today.',
            options: ['Redis, ready for more servers', 'In memory, simplest for one server'],
            recommended: 0
          }
        },
        turnEnd,
        wait
      ]
    },
    'field-notes#1': {
      Investigator: [
        session('f1-investigator'),
        say('Reading the sync queue and the merge.'),
        ...read(wt('field-notes', 1, 'src/sync/queue.ts'), '11 lines'),
        ...read(wt('field-notes', 1, 'src/sync/merge.ts'), '6 lines'),
        ...grep('updatedAt', '3 files'),
        think('The edit keeps the time it was made, but the merge only compares updatedAt. If the server copy changed later, the offline edit loses with no trace.', 12),
        ...bash('git log --oneline -5 -- src/sync', '1 commit'),
        { callTool: 'submitReport', args: { markdown: REPORT } },
        turnEnd
      ]
    },
    'field-notes#2': {
      Planner: [
        session('f2-planner'),
        say('Reading how notes are stored.'),
        ...read(wt('field-notes', 2, 'src/notes/types.ts'), '11 lines'),
        wait,
        { emit: { kind: 'rate_limit', status: 'rejected', resetsAt, windows: {} } },
        { emit: { kind: 'turn_end', ok: false, error: 'Claude AI usage limit reached' } },
        wait
      ]
    },
    Orchestrator: [
      // Woken by the stuck agent on #5.
      // The drafting request starts it.
      session('orchestrator'),
      ...tool('mcp__mainbus__list_tickets', { workspace: 'acme-web' }, '12 tickets'),
      ...tool('Read', { file_path: `${DEMO_PROJECTS}\\acme-web\\src\\cart\\checkout.ts` }, '11 lines'),
      ...tool('Grep', { pattern: 'gift|voucher', path: `${DEMO_PROJECTS}\\acme-web\\src` }, 'No matches'),
      { emit: { kind: 'tool_call', id: 'demo-o-draft', name: 'mcp__mainbus__propose_create_tickets', input: {} } },
      {
        callTool: 'proposeCreateTickets',
        args: {
          tickets: [
            {
              title: 'Gift cards: issue and store codes',
              spec: 'A gift_cards table (code, balance, currency, expiry) and an admin form to issue a card. Codes are 16 characters, unambiguous.',
              criteria: ['A card can be issued with a balance and an expiry', 'Codes are unique and never reuse 0/O or 1/I'],
              labels: ['gift-cards']
            },
            {
              title: 'Gift cards: redeem at checkout',
              spec: 'A "Gift card" field at checkout that takes off up to the remaining balance, after discounts and before shipping.',
              criteria: ['A partial balance is kept for next time', 'An expired card is refused with a clear message'],
              labels: ['gift-cards', 'checkout'],
              blocked_by: [{ draft: 0 }]
            },
            {
              title: 'Gift cards: balance lookup page',
              spec: 'A public page where a code shows its balance and expiry, rate-limited like /login.',
              labels: ['gift-cards']
            }
          ],
          evidence: 'checkout.ts has orderTotal() with no adjustments yet, and nothing in src mentions gift cards or vouchers.'
        }
      },
      { emit: { kind: 'tool_result', id: 'demo-o-draft', ok: true, summary: 'Proposed' } },
      say('I’ve drafted three tickets. Redeeming waits on issuing; the lookup page can go in any order. Untick any you don’t want, or edit them first.'),
      turnEnd,
      wait,
      // Woken by the stuck agent on #5.
      ...tool('mcp__mainbus__get_recent_events', { workspace: 'acme-web', number: 5 }, '12 events'),
      { emit: { kind: 'tool_call', id: 'demo-o-redirect', name: 'mcp__mainbus__propose_redirect', input: {} } },
      {
        callTool: 'proposeRedirect',
        args: {
          ticket: 5,
          message: 'The test is fine: the bug is in sumLineItems. Round each line total to the cent there, then run the test 50 times to prove it.',
          evidence: 'pnpm test src/cart/total.test.ts failed 5 times in a row with the same rounding error, and nothing has changed in the folder.'
        }
      },
      { emit: { kind: 'tool_result', id: 'demo-o-redirect', ok: true, summary: 'Proposed' } },
      say('The Implementer on #5 is re-running the same failing test. I’ve proposed one corrective message: confirm it, or edit it first.'),
      turnEnd,
      wait,
      // Anything later: a short answer each time.
      ...[1, 2, 3, 4].flatMap((): FakeStep[] => [say('Noted.'), turnEnd, wait])
    ]
  }
}

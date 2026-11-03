/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test'
import { backToBoard, createTicket, makeRepo, openTicket, shot, withArtboard } from './artboardHelpers'

/**
 * One test per wireframe artboard (docs/wireframes/): each builds the artboard's situation with FakeRuntime in a temporary
 * data home, saves a screenshot to test-results/artboards/<slug>.png for comparing with the artboard, and checks that
 * its key elements are on screen. Not pixels: docs/superpowers/plans/m7-wireframe-pass.md lists the differences found.
 */

const BOARD = { width: 1440, height: 960 }
const SCREEN = { width: 1200, height: 800 }

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Orchestrator' })

test('Board: workspaces with counts, a card in every column, the Fleet line, a start proposal and a decision in the panel', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/artboard-board-by-role.json', size: BOARD, repoName: 'web-app' }, async ({ page, tmp }) => {
    // A second workspace, opened through the bridge as the Add workspace dialog would; then back to the first.
    const second = makeRepo(tmp, 'api-service')
    await page.evaluate((p) => (globalThis as unknown as { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mainbus.invoke('workspace.open', p), second)
    await page.getByRole('button', { name: /^web-app/ }).click()
    await expect(page.getByRole('heading', { name: 'web-app', level: 2 })).toBeVisible()

    await createTicket(page, { title: 'Fix flaky checkout test' }) // #1, started: In progress
    await createTicket(page, { title: 'Rate-limit login', column: 'ready' }) // #2, Ready, with the proposal
    await createTicket(page, { title: 'Webhook retry policy' }) // #3, asks a question: Needs you
    await createTicket(page, { title: 'Remove unused flags' }) // #4, fails: Needs you
    await createTicket(page, { title: 'Health check endpoint' }) // #5, runs its lineup: Review
    await createTicket(page, { title: 'Add CSV export' }) // #6, Backlog
    await createTicket(page, { title: 'Migrate dates to Temporal' }) // #7, Backlog, held
    await createTicket(page, { title: 'Fix README links' }) // #8, Done

    // Starts, in this order: the nth Planner of the fixture does what its ticket needs.
    for (const title of ['Fix flaky checkout test', 'Webhook retry policy', 'Remove unused flags', 'Health check endpoint']) {
      await openTicket(page, title)
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(page.getByLabel(/^Message the |^Message to start/)).toBeVisible()
      await backToBoard(page)
    }
    await openTicket(page, 'Migrate dates to Temporal')
    await page.getByRole('button', { name: 'Hold…' }).click()
    await page.getByRole('menuitem', { name: 'No date' }).click()
    await expect(page.getByText('Held by you').first()).toBeVisible()
    await backToBoard(page)
    // The card's menu, opened by right-click, moves it to Done.
    await page.getByRole('button', { name: /Fix README links/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Done' }).click()

    const panel = panelOf(page)
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Start agents on everything in Ready.')
    await box.press('Enter')
    await expect(panel.getByRole('group', { name: 'Proposal: Start #2 Rate-limit login' })).toBeVisible({ timeout: 30_000 })

    // The rail: both workspaces, with a status line, and the needs-you count on the one that needs you.
    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    await expect(rail.locator('[data-rail-status]').first()).toContainText('working')
    await expect(rail.locator('[data-needs-you]').first()).toBeVisible()
    await expect(rail.locator('[data-rail-status]').nth(1)).toContainText('Idle')
    await expect(rail.getByText('Pick a local repo folder to add it.')).toBeVisible()

    // A card in every column, with the chips that lead with a symbol.
    const column = (name: string) => page.getByRole('region', { name, exact: true })
    await expect(column('Backlog').getByText('Add CSV export')).toBeVisible()
    await expect(column('Backlog').getByText('Held by you')).toBeVisible()
    await expect(column('Ready').getByText('Rate-limit login')).toBeVisible()
    await expect(column('In progress').getByText('Fix flaky checkout test')).toBeVisible()
    await expect(column('Needs you').getByText('Webhook retry policy')).toBeVisible()
    await expect(column('Needs you').getByText('Waiting on you')).toBeVisible()
    await expect(column('Needs you').getByText(/Failed in /)).toBeVisible()
    await expect(column('Review').getByText('Health check endpoint')).toBeVisible({ timeout: 30_000 })
    await expect(column('Done').getByText('Fix README links')).toBeVisible()

    // The orchestrator panel: Fleet line, the start proposal and the pending decision.
    await expect(panel.getByText(/^Fleet: \d+ working · \d+ need you · \d+ idle$/)).toBeVisible()
    await expect(panel.getByText('All workspaces · focused on web-app')).toBeVisible()
    await expect(panel.getByRole('region', { name: 'Waiting on you' })).toContainText('Exponential or fixed backoff')
    await expect(panel.getByText('PROPOSED ACTION', { exact: false })).toBeVisible()
    await expect(panel.getByLabel('Message the orchestrator')).toHaveAttribute('placeholder', 'Ask for status, create tickets, start or stop agents')
    await shot(page, 'board')
  })
})

test('Ticket detail: lineup strip, controls, thread with thinking and tool rows, live line, composer and activity', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/artboard-detail-by-role.json', size: BOARD }, async ({ page }) => {
    await createTicket(page, {
      title: 'Add CSV export',
      intent: 'Reports need a CSV export.',
      spec: 'Export the visible report as CSV.',
      criteria: ['Download button on reports', 'Quotes and commas are escaped'],
      labels: 'reports, export',
      column: 'ready'
    })
    await openTicket(page, 'Add CSV export')
    await page.getByLabel('First message (starts the lineup)').fill('Please add the CSV export.')
    await page.getByRole('button', { name: 'Send and start' }).click()
    await expect(page.getByText('Implementer: reading how reports render.')).toBeVisible()
    await page.getByLabel('Message the Implementer').fill('Use the existing CSV helper if there is one.')
    await page.getByRole('main').getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Implementer is editing src/export.ts')).toBeVisible()

    // The header, with where it goes back to and where the ticket came from.
    await expect(page.getByRole('button', { name: /← web-app board/ })).toBeVisible()
    await expect(page.getByText('Source: Local')).toBeVisible()
    // The lineup strip: Planner done, the Implementer active.
    const strip = page.getByRole('list', { name: 'Lineup' }).getByRole('listitem')
    await expect(strip).toHaveText(['Planner ✓ Handed off', 'Implementer • Working', 'Reviewer ○ Not started'], { useInnerText: true })
    // The controls line, with the role they apply to, in order.
    await expect(page.getByText('Controls apply to the Implementer')).toBeVisible()
    const names = await page.getByRole('main').getByRole('button').allInnerTexts()
    const at = ['Pause', 'Stop', 'Skip to Reviewer', 'Replace…'].map((n) => names.findIndex((t) => t.trim() === n))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    // The thread: a handoff divider, a thinking block, tool rows, the user's message and the live line.
    await expect(page.locator('[data-event="handoff"]').first()).toBeVisible()
    await expect(page.locator('[data-event="thinking"]').first()).toBeVisible()
    await expect(page.locator('[data-event="tool"]').first()).toBeVisible()
    await expect(page.locator('[data-event="user_message"]').filter({ hasText: 'Use the existing CSV helper' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Implementer is editing src/export.ts' })).toBeVisible()
    // The composer and the context pane.
    await expect(page.getByLabel('Message the Implementer')).toHaveAttribute('placeholder', 'Steer it, answer a question, add context')
    await expect(page.getByRole('region', { name: 'Acceptance criteria' })).toContainText('Quotes and commas are escaped')
    const activity = page.getByRole('region', { name: 'Activity' })
    await expect(activity.getByText('Created by you')).toBeVisible()
    await expect(activity.getByText(/Started with the web-app lineup/)).toBeVisible()
    await expect(activity.getByText('Planner handed off to the Implementer')).toBeVisible()
    await shot(page, 'ticket-detail')
  })
})

test('Orchestrator starts an agent: proposal, Override form, receipt and the card in In progress', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/orchestrator-start.json', size: SCREEN }, async ({ page }) => {
    await createTicket(page, { title: 'Add hello file', intent: 'Add hello.txt' })
    const panel = panelOf(page)
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Start the hello ticket.')
    await box.press('Enter')
    const card = panel.getByRole('group', { name: 'Proposal: Start #1 Add hello file' })
    await expect(card).toBeVisible()
    await expect(card.getByText('PROPOSED ACTION', { exact: false })).toBeVisible()
    await expect(card.getByLabel('Roles')).toContainText('web-app lineup: Planner → Implementer → Reviewer')
    for (const name of ['Confirm', 'Override', 'Reject']) await expect(card.getByRole('button', { name, exact: true })).toBeVisible()
    await shot(page, 'orchestrator-starts-proposal')

    // Override: numbered ticks, a collapsed models section, extra instructions, Cancel and Start.
    await card.getByRole('button', { name: 'Override' }).click()
    await expect(card.getByText('Lineup for this ticket (from web-app)')).toBeVisible()
    for (const name of ['1. Planner', '2. Implementer', '3. Reviewer']) await expect(card.getByRole('checkbox', { name })).toBeChecked()
    await expect(card.getByText('Untick a role to skip it for this ticket only.')).toBeVisible()
    await expect(card.getByRole('button', { name: /Models and effort per role/ })).toHaveAttribute('aria-expanded', 'false')
    await expect(card.getByLabel('Extra instructions for this agent')).toHaveAttribute('placeholder', 'Optional')
    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await shot(page, 'orchestrator-starts-override')
    await card.getByRole('button', { name: 'Start', exact: true }).click()

    // The receipt, and the card in In progress with the recently-changed outline.
    const receipt = panel.locator('[data-proposal="receipt"]')
    await expect(receipt).toContainText('✓ Add hello file is in')
    await expect(receipt.getByRole('button', { name: 'Open ticket' })).toBeVisible()
    const inProgress = page.getByRole('region', { name: 'In progress' })
    await expect(inProgress.getByText('Add hello file')).toBeVisible()
    // (The recently-changed outline marks changes the person did not make themselves, so confirming here leaves none.)
    await shot(page, 'orchestrator-starts-receipt')
  })
})

test('A decision shown in three places: board card, panel card and thread card, and a receipt once answered', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/board-answer-by-role.json', size: SCREEN }, async ({ page }) => {
    await createTicket(page, { title: 'Webhook retry policy', intent: 'Add hello.txt' })
    await openTicket(page, 'Webhook retry policy')
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('button', { name: 'Send and start' }).click()
    const thread = page.locator('[data-event="decision"]')
    await expect(thread).toContainText('Where should hello.txt go?')
    // 1. The thread card: orange, headed by who is waiting.
    await expect(thread).toContainText('◆ Planner is waiting on you')
    await expect(thread.getByLabel('Note to agent (optional)')).toHaveAttribute('placeholder', 'Anything it should know')
    await expect(thread.getByText('Recommended')).toBeVisible()
    await shot(page, 'decision-thread')
    await backToBoard(page)

    // 2. The board card in Needs you, and 3. the panel's card, with a link to the ticket.
    const needsYou = page.getByRole('region', { name: 'Needs you' })
    await expect(needsYou.getByText('Webhook retry policy')).toBeVisible()
    await expect(needsYou.getByText('◆ Waiting on you')).toBeVisible()
    await expect(needsYou.getByRole('button', { name: 'Answer', exact: true })).toBeVisible()
    const waiting = panelOf(page).getByRole('region', { name: 'Waiting on you' })
    const card = waiting.locator('[data-event="waiting-decision"]')
    await expect(card).toContainText('◆ Webhook retry policy · web-app')
    await expect(card.getByRole('button', { name: 'Open ticket for full context' })).toBeVisible()
    await shot(page, 'decision-board-and-panel')

    // Answered in the panel: the others clear, and the panel says what happened.
    await card.getByRole('radio', { name: /docs folder/ }).check()
    await card.getByRole('button', { name: 'Answer', exact: true }).click()
    await expect(needsYou.getByText('Webhook retry policy')).toHaveCount(0)
    await expect(panelOf(page).getByText(/^✓ Answered: docs folder\. Webhook retry policy is back in /)).toBeVisible()
    await shot(page, 'decision-answered')
  })
})

test('Replacing a stuck agent: the replace card, the divider with its handoff, and the timeline entry', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/replace-by-role.json', size: SCREEN }, async ({ page }) => {
    await createTicket(page, { title: 'Fix flaky test', intent: 'Fix the flaky test' })
    await openTicket(page, 'Fix flaky test')
    await page.getByLabel('First message (starts the lineup)').fill('Please fix the flaky test')
    await page.getByRole('button', { name: 'Send and start' }).click()
    await expect(page.getByText('Planner at work on the flaky test.')).toBeVisible()
    await page.getByRole('main').getByRole('button', { name: 'Replace…' }).click()

    const panel = panelOf(page)
    const card = panel.getByRole('group', { name: 'Proposal: Replace the Planner on Fix flaky test' })
    await expect(card.getByText('PROPOSED ACTION', { exact: false })).toBeVisible()
    await expect(card.getByText(/^The new Planner gets the plan, decisions so far, and a handoff of what was tried\./)).toBeVisible()
    await expect(card).not.toContainText('worktree')
    for (const name of ['Keep current', 'Override', 'Replace Planner']) await expect(card.getByRole('button', { name })).toBeVisible()
    await shot(page, 'replace-card')

    await card.getByRole('button', { name: 'Replace Planner' }).click()
    await expect(panel.locator('[data-proposal="receipt"]')).toContainText('Replaced the Planner on')
    const divider = page.locator('[data-event="replaced"]')
    await expect(divider).toContainText('Planner replaced')
    await expect(divider.getByRole('button', { name: 'View previous run' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Handoff from the previous run/ })).toHaveAttribute('aria-expanded', 'true')
    const activity = page.getByRole('region', { name: 'Activity' })
    await expect(activity.getByText('Planner replaced')).toBeVisible()
    await expect(activity.getByText('Suggested by you with Replace…, confirmed by you')).toBeVisible()
    await expect(activity.getByText('New Planner started from the plan')).toBeVisible()
    await shot(page, 'replace-thread')
  })
})

test('Creating a ticket: the New ticket dialog, then drafted tickets with ticks, Edit and the two buttons', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/orchestrator-drafting.json', size: SCREEN }, async ({ page }) => {
    await page.getByRole('button', { name: 'New ticket' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New ticket' })
    await expect(dialog.getByText('web-app')).toBeVisible()
    for (const label of ['Title', 'In your words', 'Spec', 'Acceptance criteria', 'Labels', 'Column']) {
      await expect(dialog.getByLabel(label).first()).toBeVisible()
    }
    await expect(dialog.getByLabel('Column')).toHaveValue('backlog')
    await expect(dialog.getByLabel("Ask the orchestrator to start an agent once it's in Ready")).toBeVisible()
    await expect(dialog.getByPlaceholder('What needs doing')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create ticket' })).toBeDisabled()
    await shot(page, 'creating-a-ticket-dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    const panel = panelOf(page)
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Please add a login page and a logout button.')
    await box.press('Enter')
    const card = panel.getByRole('group', { name: 'Proposal: Create 2 tickets in Backlog' })
    await expect(card).toBeVisible()
    await expect(card.getByText('PROPOSED ACTION · CREATE 2 TICKETS IN WEB-APP → BACKLOG', { exact: false })).toBeVisible()
    await expect(card.getByRole('checkbox', { name: 'Include Add a login page' })).toBeChecked()
    await expect(card.getByText('2 acceptance criteria · labels: auth')).toBeVisible()
    await expect(card.getByRole('button', { name: 'Edit Add a login page' })).toBeVisible()
    for (const name of ['Create 2 tickets', 'Put in Ready instead', 'Reject']) await expect(card.getByRole('button', { name })).toBeVisible()
    await card.getByRole('button', { name: 'Edit Add a login page' }).click()
    await expect(card.getByLabel('Title')).toHaveValue('Add a login page')
    await shot(page, 'creating-a-ticket-drafts')
  })
})

test('Empty states: an empty workspace, and a ticket nobody is working on', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/artboard-detail-by-role.json', size: SCREEN }, async ({ page }) => {
    // The empty workspace: faint columns, the heading, and both ways forward.
    await expect(page.getByRole('heading', { name: 'No tickets in web-app yet' })).toBeVisible()
    await expect(page.getByText('Write one yourself, or have the orchestrator read the repo and draft a starter set for you to review.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ask orchestrator to draft tickets' })).toBeVisible()
    await expect(page.getByText(/· just added$/)).toBeVisible()
    await shot(page, 'empty-workspace')

    // A ticket with no agent: the panel in place of the empty thread.
    await createTicket(page, { title: 'Add CSV export', column: 'ready' })
    await openTicket(page, 'Add CSV export')
    await expect(page.getByRole('heading', { name: 'Nobody is working on this yet' })).toBeVisible()
    await expect(page.getByText('Starting runs the web-app lineup: Planner → Implementer → Reviewer. You can adjust it before it begins.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Adjust before starting' })).toBeVisible()
    await expect(page.getByText('Past runs on this ticket appear in the activity timeline.')).toBeVisible()
    await expect(page.getByLabel('First message (starts the lineup)')).toHaveAttribute('placeholder', 'Optional instructions for the lineup')
    await expect(page.getByRole('button', { name: 'Send and start' })).toBeVisible()
    await shot(page, 'empty-ticket')
  })
})

test('Workspace agent lineup: the roles on the left, the open role on the right', async () => {
  await withArtboard({ fixture: 'e2e/fixtures/artboard-detail-by-role.json', size: SCREEN }, async ({ page }) => {
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const drawer = page.getByRole('dialog', { name: 'Workspace settings' })
    const roles = drawer.getByRole('tabpanel', { name: 'Change' })
    await expect(roles.getByText('Roles, in order')).toBeVisible()
    for (const name of ['Edit Planner', 'Edit Implementer', 'Edit Reviewer']) await expect(roles.getByRole('button', { name })).toBeVisible()
    await expect(roles.getByText(/· ticket shows Planning/)).toBeVisible()
    await expect(roles.getByText('Editing')).toBeVisible()
    await expect(roles.getByRole('button', { name: 'Add role' })).toBeVisible()
    await expect(roles.getByText('After the last role')).toBeVisible()
    await expect(roles.getByText('Ticket moves to Ready for review, waiting on you.')).toBeVisible()
    // The open role's form, with Model and effort collapsed.
    await expect(roles.getByLabel('Role name')).toHaveValue('Planner')
    for (const label of ['Instructions', 'Ticket phase while this role works', 'If it finds problems']) await expect(roles.getByLabel(label)).toBeVisible()
    await expect(roles.getByRole('button', { name: /Model and effort \(default: orchestrator decides\)/ })).toHaveAttribute('aria-expanded', 'false')
    await expect(roles.getByRole('button', { name: 'Remove role' })).toBeVisible()
    await expect(roles.getByRole('button', { name: 'Save lineup' })).toBeVisible()
    await shot(page, 'workspace-lineup')
  })
})

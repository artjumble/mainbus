import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8'
  })
}

/** A temp folder with a throwaway repo and a Mainbus home of its own. */
function makeRepo(): { tmp: string; home: string; repo: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  return { tmp, home: path.join(tmp, 'home'), repo }
}

async function launch(
  home: string,
  repo: string,
  open = true,
  script = 'e2e/fixtures/handoff.json'
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: `fake:${script}`, MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  if (open) await page.getByRole('button', { name: 'Add workspace' }).click()
  return { app, page }
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Workspace settings' }).click()
  const roles = page.getByRole('list', { name: 'Roles' })
  await expect(roles.getByRole('button', { name: /^Edit / }).first()).toBeVisible()
  return roles
}

/** Expects the ticket view's lineup strip to read `items`, one "Name Status" per role, in order. */
async function expectStrip(page: Page, items: string[]): Promise<void> {
  await expect(page.getByRole('list', { name: 'Lineup' }).getByRole('listitem')).toHaveText(items, { useInnerText: true })
}

async function roleNames(roles: Locator): Promise<string[]> {
  const labels = await roles.getByRole('button', { name: /^Edit / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  return labels.map((l) => l.replace(/^Edit /, ''))
}

test('a new workspace has the default lineup, and edits to it are saved', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo))
    let roles = await openSettings(page)
    expect(await roleNames(roles)).toEqual(['Planner', 'Implementer', 'Reviewer'])
    await expect(page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Phase while active')).toHaveValue('planning')
    await expect(page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Tool profile')).toHaveValue('read_only')
    await expect(page.getByRole('radio', { name: 'Ask me' })).toBeChecked()

    // Move the Reviewer up with the keyboard; focus stays on it.
    await page.getByRole('button', { name: 'Move Reviewer up' }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => roleNames(roles)).toEqual(['Planner', 'Reviewer', 'Implementer'])
    await expect(page.getByRole('button', { name: 'Move Reviewer up' })).toBeFocused()

    // Then drag it onto the Planner's row, with the real pointer.
    const handle = page.getByRole('button', { name: 'Drag Reviewer' })
    // The drawer slides in: measure only once it has stopped moving.
    let lastX: number | undefined
    await expect
      .poll(async () => {
        const x = (await handle.boundingBox())?.x
        const settled = x !== undefined && x === lastX
        lastX = x
        return settled
      })
      .toBe(true)
    const target = (await roles.getByRole('listitem').first().boundingBox())!
    const from = (await handle.boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y - 10, { steps: 5 })
    await page.mouse.move(from.x + from.width / 2, target.y + target.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => roleNames(roles)).toEqual(['Reviewer', 'Planner', 'Implementer'])

    // Rename the Implementer and add a role.
    // dnd-kit swallows clicks for 50 ms after a drop, so this click may need a second try.
    await expect(async () => {
      await roles.getByRole('button', { name: 'Edit Implementer' }).click()
      await expect(page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Name')).toHaveValue('Implementer', { timeout: 200 })
    }).toPass()
    await page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Name').fill('Builder')
    await page.getByRole('button', { name: 'Add role' }).click()
    await page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Name').fill('Doc writer')
    await page.getByRole('button', { name: 'Save lineup' }).click()
    await expect(page.getByRole('button', { name: 'Save lineup' })).toBeDisabled()
    await app.close()
    app = undefined

    // A restart reads back what was saved.
    ;({ app, page } = await launch(home, repo, false))
    roles = await openSettings(page)
    expect(await roleNames(roles)).toEqual(['Reviewer', 'Planner', 'Builder', 'Doc writer'])
    await roles.getByRole('button', { name: 'Edit Builder' }).click()
    await expect(page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Phase while active')).toHaveValue('implementing')
    await expect(page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Tool profile')).toHaveValue('edit')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("the lineup settings show why a lineup can't be saved", async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo))
    const roles = await openSettings(page)
    await roles.getByRole('button', { name: 'Edit Reviewer' }).click()
    await page.getByRole('tabpanel', { name: 'Change' }).getByLabel('Name').fill('implementer')
    await page.getByRole('button', { name: 'Save lineup' }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Two roles are called "Implementer". Give each role its own name.')
    await expect(alert).not.toContainText('Error invoking')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Start runs a ticket through Planner, Implementer and Reviewer in turn, and it reaches Review after the last', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    // Each scripted role says who it is, then hands off when it gets a message.
    ;({ app, page } = await launch(home, repo, true, 'e2e/fixtures/lineup-by-role.json'))
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Add hello file/ }).click()

    // Before the first run the strip shows the workspace lineup, none of it started.
    await expectStrip(page, ['Planner Not started', 'Implementer Not started', 'Reviewer Not started'])
    await expect(page.getByLabel('First message (starts the lineup)')).toBeVisible()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    const steps = [
      ['Planner', 'Planning', 'Planner: reading the ticket.'],
      ['Implementer', 'Implementing', 'Implementer: adding the file.'],
      ['Reviewer', 'Reviewing', 'Reviewer: checking the change.']
    ] as const
    for (const [i, [role, phase, said]] of steps.entries()) {
      await expect(page.getByText(said)).toBeVisible()
      await expect(page.getByText(phase, { exact: true })).toBeVisible()
      // The strip: earlier roles handed off, this one working and current, later ones not started.
      await expectStrip(
        page,
        steps.map(([name], j) => `${name} ${j < i ? 'Handed off' : j === i ? 'Working' : 'Not started'}`)
      )
      await expect(page.getByRole('list', { name: 'Lineup' }).locator('[aria-current="step"]')).toHaveText(new RegExp(role))
      // Between roles the ticket never shows as ready for review.
      await expect(page.getByText('Ready for review', { exact: true })).toHaveCount(0)

      // The board card's chip follows the active role.
      await page.getByRole('button', { name: /board/ }).click()
      await expect(page.getByRole('region', { name: 'In progress' }).getByText(phase, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: /Add hello file/ }).click()

      const composer = page.getByLabel(`Message the ${role}`)
      await composer.fill(`Go on, ${phase}`)
      await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
      // The composer clears once the message has gone through (its label then names the next role).
      await expect(page.getByRole('main').getByRole('textbox', { name: /^Message/ })).toHaveValue('')
    }

    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    await expectStrip(page, ['Planner Handed off', 'Implementer Handed off', 'Reviewer Handed off'])
    // The thread keeps every role's work, each tagged with its role, and a divider at each handoff.
    await expect(page.getByText('Planner: reading the ticket.')).toBeVisible()
    await expect(page.getByText('Implementer: adding the file.')).toBeVisible()
    await expect(page.getByText('Planner → Implementer', { exact: true })).toBeVisible()
    await expect(page.getByText('Implementer → Reviewer', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello file')).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('the Reviewer ticks a criterion and hands a problem back once, and the ticket still reaches Review', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    // The Reviewer ticks criterion 0 and reports a problem; resumed, each role hands off.
    ;({ app, page } = await launch(home, repo, true, 'e2e/fixtures/hand-back-by-role.json'))
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByLabel('Acceptance criteria').fill('hello.txt exists\nIt ends with a newline')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    await expect(page.getByText('Reviewer: checking the change.')).toBeVisible()
    const exists = page.getByRole('checkbox', { name: 'hello.txt exists' })
    const newline = page.getByRole('checkbox', { name: 'It ends with a newline' })
    await expect(exists).not.toBeChecked()
    await page.getByLabel('Message the Reviewer').fill('Go on')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()

    // The checklist updates live, and the thread says who checked what.
    await expect(exists).toBeChecked()
    await expect(newline).not.toBeChecked()
    await expect(page.getByText('Reviewer checked: hello.txt exists', { exact: true })).toBeVisible()

    // The hand-back divider names both roles, with the problem collapsed under it.
    const handBack = page.getByRole('group', { name: 'Reviewer handed back to Implementer' })
    await expect(handBack.getByText('Reviewer handed back to Implementer', { exact: true })).toBeVisible()
    await handBack.getByRole('button', { name: 'Show details' }).click()
    await expect(handBack.getByText('hello.txt has no trailing newline', { exact: true })).toBeVisible()

    // The Implementer resumes and hands off straight back to the Reviewer, which hands off: Review.
    await expect(page.getByText('Implementer: adding the newline.')).toBeVisible()
    await expect(page.getByText('Reviewer: looks right now.')).toBeVisible()
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    await expectStrip(page, ['Planner Handed off', 'Implementer Handed off', 'Reviewer Handed off'])
    // The Planner ran once.
    await expect(page.getByText('Planner: reading the ticket.')).toHaveCount(1)
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello file')).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Adjust before starting runs only the ticked roles, and Start again begins a new run', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo, true, 'e2e/fixtures/lineup-by-role.json'))
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Add hello file/ }).click()

    await page.getByRole('button', { name: 'Adjust before starting' }).click()
    const dialog = page.getByRole('dialog', { name: 'Adjust before starting' })
    for (const name of ['Planner', 'Implementer', 'Reviewer']) await expect(dialog.getByRole('checkbox', { name })).toBeChecked()
    await dialog.getByRole('checkbox', { name: 'Planner' }).uncheck()
    await dialog.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // Only the ticked roles are in the strip, and the Implementer goes first.
    await expect(page.getByText('Implementer: adding the file.')).toBeVisible()
    await expectStrip(page, ['Implementer Working', 'Reviewer Not started'])
    await expect(page.getByText('IMPLEMENTER', { exact: true })).toBeVisible()
    await page.getByLabel('Message the Implementer').fill('Go on')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()

    // The handoff divider names both roles, with the summary collapsed under it.
    const handoff = page.getByRole('group', { name: 'Implementer → Reviewer' })
    await expect(handoff.getByText('Implementer → Reviewer', { exact: true })).toBeVisible()
    await expect(handoff.getByText('Added hello.txt', { exact: true })).toHaveCount(0)
    await handoff.getByRole('button', { name: 'Show summary' }).click()
    await expect(handoff.getByText('Added hello.txt', { exact: true })).toBeVisible()

    await expect(page.getByText('Reviewer: checking the change.')).toBeVisible()
    await page.getByLabel('Message the Reviewer').fill('Go on')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()

    // Start again runs the whole lineup as a new run, with a divider where it begins.
    await expect(page.getByText('New run', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Start again' }).click()
    await expect(page.getByText('New run', { exact: true })).toBeVisible()
    await expectStrip(page, ['Planner Working', 'Implementer Not started', 'Reviewer Not started'])
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Pause and Resume the active role, then Skip to the next role and past the last one to Review', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    // The Planner waits; resumed, it says so. The Implementer hands off when it gets a message; the Reviewer waits.
    ;({ app, page } = await launch(home, repo, true, 'e2e/fixtures/pause-skip-by-role.json'))
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Planner: reading the ticket.')).toBeVisible()

    // Pause: the role is Paused, with a chip beside the phase, and Resume instead of Pause.
    const chip = page.locator('.mantine-Badge-label', { hasText: /^Paused$/ })
    await expect(chip).toHaveCount(0)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(chip).toBeVisible()
    await expect(page.getByText('Planning', { exact: true })).toBeVisible()
    await expectStrip(page, ['Planner Paused', 'Implementer Not started', 'Reviewer Not started'])
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
    // The board card shows it too, still In progress.
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'In progress' }).getByText('Paused', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Add hello file/ }).click()

    // Resume: the same session goes on.
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.getByText('Planner: picking up where I was.')).toBeVisible()
    await expect(chip).toHaveCount(0)
    await expectStrip(page, ['Planner Working', 'Implementer Not started', 'Reviewer Not started'])

    // Skip, confirmed: the Planner is handed off with a summary Mainbus generated, and the Implementer starts.
    await page.getByRole('button', { name: /^Skip to / }).click()
    const dialog = page.getByRole('dialog', { name: 'Skip to next role' })
    await expect(dialog.getByText('Skip the Planner? Its work so far is summarised for the Implementer.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('Implementer: adding the file.')).toBeVisible()
    await expectStrip(page, ['Planner Handed off', 'Implementer Working', 'Reviewer Not started'])
    const skipped = page.getByRole('group', { name: 'Planner skipped → Implementer · summary generated by Mainbus' })
    await expect(skipped.getByText('Planner skipped → Implementer · summary generated by Mainbus', { exact: true })).toBeVisible()
    await skipped.getByRole('button', { name: 'Show summary' }).click()
    await expect(skipped.getByText('A summary the fake runtime wrote.', { exact: true })).toBeVisible()

    // The Implementer hands off as usual; skipping the Reviewer, the last role, sends the ticket to Review.
    await page.getByLabel('Message the Implementer').fill('Go on')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Reviewer: checking the change.')).toBeVisible()
    await page.getByRole('button', { name: /^Skip to / }).click()
    await expect(dialog.getByText('Skip the Reviewer? Its work so far is summarised and the ticket goes to Review.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    await expectStrip(page, ['Planner Handed off', 'Implementer Handed off', 'Reviewer Handed off'])
    await expect(page.getByText('Reviewer skipped · summary generated by Mainbus', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello file')).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

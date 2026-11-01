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
  if (open) await page.getByRole('button', { name: 'Open a repo folder' }).click()
  return { app, page }
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Workspace settings' }).click()
  const roles = page.getByRole('list', { name: 'Roles' })
  await expect(roles.getByRole('button', { name: /^Edit / }).first()).toBeVisible()
  return roles
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
    await expect(page.getByLabel('Phase while active')).toHaveValue('planning')
    await expect(page.getByLabel('Tool profile')).toHaveValue('read_only')
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
      await expect(page.getByLabel('Name')).toHaveValue('Implementer', { timeout: 200 })
    }).toPass()
    await page.getByLabel('Name').fill('Builder')
    await page.getByRole('button', { name: 'Add role' }).click()
    await page.getByLabel('Name').fill('Doc writer')
    await page.getByRole('button', { name: 'Save lineup' }).click()
    await expect(page.getByRole('button', { name: 'Save lineup' })).toBeDisabled()
    await app.close()
    app = undefined

    // A restart reads back what was saved.
    ;({ app, page } = await launch(home, repo, false))
    roles = await openSettings(page)
    expect(await roleNames(roles)).toEqual(['Reviewer', 'Planner', 'Builder', 'Doc writer'])
    await roles.getByRole('button', { name: 'Edit Builder' }).click()
    await expect(page.getByLabel('Phase while active')).toHaveValue('implementing')
    await expect(page.getByLabel('Tool profile')).toHaveValue('edit')
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
    await page.getByLabel('Name').fill('implementer')
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
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    const composer = page.getByLabel('Message the Implementer')
    for (const [phase, said] of [
      ['Planning', 'Planner: reading the ticket.'],
      ['Implementing', 'Implementer: adding the file.'],
      ['Reviewing', 'Reviewer: checking the change.']
    ] as const) {
      await expect(page.getByText(said)).toBeVisible()
      await expect(page.getByText(phase, { exact: true })).toBeVisible()
      // Between roles the ticket never shows as ready for review.
      await expect(page.getByText('Ready for review', { exact: true })).toHaveCount(0)
      await composer.fill(`Go on, ${phase}`)
      await page.getByRole('button', { name: 'Send' }).click()
      // The composer clears once the message has gone through.
      await expect(composer).toHaveValue('')
    }

    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    // The thread keeps every role's work.
    await expect(page.getByText('Planner: reading the ticket.')).toBeVisible()
    await expect(page.getByText('Implementer: adding the file.')).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello file')).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

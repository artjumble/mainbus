import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { MainbusApi } from '../src/shared/api'

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

async function launch(home: string, repo: string, script: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: `fake:${script}`, MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Add workspace' }).click()
  return { app, page }
}

// A 1×1 PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Pastes an image file onto `target`, as Ctrl+V with a screenshot on the clipboard does. */
async function pasteImage(target: Locator, name: string): Promise<void> {
  await target.evaluate(
    (el, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], name, { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    { name, base64: PNG_BASE64 }
  )
}

test('a pasted screenshot reaches every role without a card, one attached mid-run is announced, and both stay at Done', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo, 'e2e/fixtures/attachments-by-role.json'))

    // 1. A ticket created with a pasted screenshot.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Fix the login page')
    const words = page.getByLabel('In your words')
    await words.fill('It looks like this')
    await pasteImage(words, 'image.png')
    const dialog = page.getByRole('dialog', { name: 'New ticket' })
    await expect(dialog.getByRole('img', { name: 'image.png' })).toBeVisible()
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden()

    await page.getByRole('button', { name: /Fix the login page/ }).click()
    const attachments = page.getByRole('region', { name: 'Attachments' })
    await expect(attachments.getByRole('img', { name: 'image.png' })).toBeVisible()
    await expect(attachments.getByRole('img', { name: 'image.png' })).toHaveAttribute('src', /^data:image\/png;base64,/)

    // 2. Started, the agent reads the image from the path in its prompt, with no permission card.
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Planner: I looked at the screenshot.')).toBeVisible()
    const thread = () =>
      page.evaluate(async () => {
        const { mainbus } = window as unknown as { mainbus: MainbusApi }
        const { tickets } = await mainbus.invoke('board.get')
        return mainbus.invoke('thread.get', tickets[0]!.id)
      })
    let now = await thread()
    expect(now.decisions).toEqual([])
    expect(now.events.filter((e) => e.event.kind === 'tool_result').map((e) => e.event)).toEqual([expect.objectContaining({ ok: true })])

    // 3. A second image pasted while the agent works is attached, and the agent is told where it is.
    await pasteImage(page.locator('body'), 'second.png')
    await expect(attachments.getByRole('img', { name: 'second.png' })).toBeVisible()
    await expect(page.getByText(/The user attached second\.png: .*second\.png/)).toBeVisible()
    await expect(page.getByText('Planner: I looked at the second image too.')).toBeVisible()
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    now = await thread()
    expect(now.decisions).toEqual([])
    expect(now.events.filter((e) => e.event.kind === 'tool_result').map((e) => e.event)).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true })
    ])

    // 4. Moved to Done, its folder goes but the images stay.
    await page.getByRole('button', { name: /board/ }).click()
    await page.getByRole('button', { name: /Fix the login page/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Done' }).click()
    const done = page.getByRole('region', { name: 'Done' })
    // Done is a narrow strip: its cards show while it is hovered.
    await done.hover()
    await expect(done.getByText('Fix the login page')).toBeVisible()
    await done.getByRole('button', { name: /Fix the login page/ }).click()
    await expect(attachments.getByRole('img', { name: 'image.png' })).toBeVisible()
    await expect(attachments.getByRole('img', { name: 'second.png' })).toBeVisible()

    // Never in the repo: they live in Mainbus's data folder.
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
    expect(git(repo, 'log', '--all', '--name-only', '--format=').trim()).toBe('README.md')
    const stored = fs.readdirSync(path.join(home, 'attachments', 'repo', '1'))
    expect(stored.map((f) => f.replace(/^[0-9a-f-]{36}-/, '')).sort()).toEqual(['image.png', 'second.png'])
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

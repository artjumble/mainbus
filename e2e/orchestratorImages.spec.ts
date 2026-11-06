import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator } from '@playwright/test'

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

/** Drops image files onto `target`, as dragging them from Explorer does. */
async function dropImages(target: Locator, names: string[]): Promise<void> {
  await target.evaluate(
    (el, { names, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      for (const name of names) data.items.add(new File([bytes], name, { type: 'image/png' }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    },
    { names, base64: PNG_BASE64 }
  )
}

/** A stored file's name without the id before it. */
const named = (file: string) => file.replace(/^[0-9a-f-]{36}-/, '')

test('a screenshot pasted into the orchestrator panel reaches the orchestrator, which creates a ticket with it attached', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-screenshot.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })

    // 1. A screenshot pasted with "make a ticket for this bug": a thumbnail above the box until it is sent.
    await box.fill('make a ticket for this bug')
    await pasteImage(box, 'bug.png')
    const toSend = panel.getByRole('group', { name: 'Images to send' })
    await expect(toSend.getByRole('img', { name: 'bug.png' })).toBeVisible()
    await box.press('Enter')
    await expect(toSend).toHaveCount(0)

    // 2. The scripted orchestrator received the image in its turn, with its name, and created a ticket with images.
    await expect(panel.getByText('I see 1 image (image/png).')).toBeVisible()
    const receipt = panel.locator('[data-event="tickets_created"]')
    await expect(receipt).toHaveText("Created #1 in repo's Backlog, with 1 image attached")

    // 4. The panel shows the sent screenshot in the user's message; a click enlarges it.
    const message = panel.locator('[data-event="user_message"]')
    await expect(message.getByText('make a ticket for this bug')).toBeVisible()
    const sent = message.getByRole('img', { name: 'bug.png' })
    await expect(sent).toBeVisible()
    await expect(sent).toHaveAttribute('src', /^data:image\/png;base64,/)
    await message.getByRole('button', { name: 'Preview bug.png' }).click()
    const preview = page.getByRole('dialog', { name: 'bug.png' })
    await expect(preview.getByRole('img', { name: 'bug.png' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(preview).toBeHidden()

    // 3. The ticket is in Backlog with the screenshot as an attachment.
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await backlog.getByRole('button', { name: /Fix the overlapping header/ }).click()
    const attachments = page.getByRole('region', { name: 'Attachments' })
    await expect(attachments.getByRole('img', { name: 'bug.png' })).toBeVisible()
    await expect(attachments.getByRole('img', { name: 'bug.png' })).toHaveAttribute('src', /^data:image\/png;base64,/)

    // Both copies live in Mainbus's data folder, never in the repo: the one sent, kept with the thread, and the ticket's.
    expect(fs.readdirSync(path.join(home, 'orchestrator', 'images')).map(named)).toEqual(['bug.png'])
    expect(fs.readdirSync(path.join(home, 'attachments', 'repo', '1')).map(named)).toEqual(['bug.png'])
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')

    // Two more screenshots, images only, dropped into the box: the orchestrator drafts a ticket with both, and the
    // user unticks one before creating it.
    await page.getByRole('button', { name: /board/ }).click()
    await dropImages(box, ['menu.png', 'footer.png'])
    await expect(toSend.getByRole('img', { name: 'footer.png' })).toBeVisible()
    await panel.getByRole('button', { name: 'Send' }).click()
    await expect(panel.getByText('I see 2 images (image/png, image/png).')).toBeVisible()
    const card = panel.getByRole('group', { name: 'Draft 1' })
    await expect(card.getByRole('img', { name: 'menu.png' })).toBeVisible()
    await expect(card.getByRole('img', { name: 'footer.png' })).toBeVisible()
    await card.getByRole('checkbox', { name: 'Attach menu.png' }).uncheck()
    await panel.getByRole('button', { name: 'Create 1 ticket' }).click()
    await expect(panel.getByText(/Created #2 in Backlog, with 1 image attached/)).toBeVisible()
    expect(fs.readdirSync(path.join(home, 'attachments', 'repo', '2')).map(named)).toEqual(['footer.png'])
    // Nothing is left where the images waited for their tickets.
    expect(fs.readdirSync(path.join(home, 'attachments', 'repo', '.incoming'))).toEqual([])
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})

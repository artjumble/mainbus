import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { addWorkspace } from './addWorkspace'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], { cwd, windowsHide: true, stdio: 'pipe' })
}

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/cap-by-role.json', MAINBUS_TEST_REPO: repo }
  })
  return { app, page: await app.firstWindow() }
}

/** Every field label with an info button in the dialog: on one line, not cut off, and the button a 44 px target. */
async function expectOneLineLabels(page: Page, dialogName: string): Promise<number> {
  const dialog = page.getByRole('dialog', { name: dialogName })
  const rows = await dialog.locator('label').evaluateAll((labels) =>
    labels
      .filter((l) => l.querySelector('button[aria-label^="About "]'))
      .map((l) => {
        const button = l.querySelector('button') as HTMLElement
        const text = button.previousElementSibling as HTMLElement
        const lineHeight = parseFloat(getComputedStyle(text).lineHeight)
        const after = getComputedStyle(button, '::after')
        return {
          name: text.textContent ?? '',
          height: text.getBoundingClientRect().height,
          lineHeight,
          clipped: text.scrollWidth > text.clientWidth,
          target: [parseFloat(after.width), parseFloat(after.height)]
        }
      })
  )
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) {
    expect(r.height, `${r.name} is one line`).toBeLessThan(r.lineHeight * 1.5)
    expect(r.clipped, `${r.name} is not cut off`).toBe(false)
    expect(r.target[0], `${r.name} info target width`).toBeGreaterThanOrEqual(44)
    expect(r.target[1], `${r.name} info target height`).toBeGreaterThanOrEqual(44)
  }
  return rows.length
}

test('settings labels stay on one line; descriptions sit behind a (?) button', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    let page: Page
    ;({ app, page } = await launch(home, repo))
    await addWorkspace(page)

    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Workspace settings' })
    await expect(dialog.getByRole('textbox', { name: /Agents running at once/ })).toBeVisible()
    // Visually hidden (a 1 px box): read by screen readers as the input's description, not shown.
    const box = await dialog.getByText('Lowering it stops no running agent.').boundingBox()
    expect(box?.width ?? 0).toBeLessThanOrEqual(1)
    expect(await expectOneLineLabels(page, 'Workspace settings')).toBeGreaterThanOrEqual(5)

    const info = dialog.getByRole('button', { name: 'About Unattended: tickets at once' })
    await info.focus()
    await expect(page.getByRole('tooltip')).toContainText('Lowering it stops no ticket.')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toBeHidden()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Mainbus settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Mainbus settings' })).toBeVisible()
    await expectOneLineLabels(page, 'Mainbus settings')
  } finally {
    await app?.close().catch(() => undefined)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

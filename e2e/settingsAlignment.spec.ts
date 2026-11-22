import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { addWorkspace } from './addWorkspace'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], { cwd, windowsHide: true, stdio: 'pipe' })
}

// Workspace settings: the Base branch, Short label and Color fields share a left edge and a right edge, and each Save
// button is as wide as the other and level with its input (#201). jsdom has no layout, so this is checked here.
test('Workspace settings: the fields and their Save buttons line up', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: path.join(tmp, 'home'), MAINBUS_RUNTIME: 'fake:e2e/fixtures/handoff.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await addWorkspace(page)

    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Workspace settings' })
    const base = dialog.getByRole('combobox', { name: /Base branch/ })
    const label = dialog.getByRole('textbox', { name: /Short label/ })
    const color = dialog.getByRole('combobox', { name: /Color/ })
    await expect(label).toBeVisible()
    await expect(base).toBeEnabled()

    // Read everything in one go: the dialog may still be easing in between two separate reads.
    const read = (): Promise<Record<string, { l: number; r: number; y: number; w: number }>> =>
      dialog.evaluate((el) => {
        const rect = (e: Element | null | undefined): { l: number; r: number; y: number; w: number } => {
          const b = e!.getBoundingClientRect()
          return { l: b.left, r: b.right, y: b.top + b.height / 2, w: b.width }
        }
        const field = (name: RegExp): HTMLInputElement =>
          Array.from(el.querySelectorAll<HTMLInputElement>('input')).find((i) => i.labels?.[0] && name.test(i.labels[0].textContent ?? ''))!
        const out: Record<string, { l: number; r: number; y: number; w: number }> = {}
        for (const [key, name, button] of [
          ['base', /Base branch/, 'Save base branch'],
          ['label', /Short label/, 'Save label'],
          ['color', /Color/, '']
        ] as const) {
          const input = field(name)
          // The input's visible box: its wrapper, which holds the left section and the chevron.
          out[key] = rect(input.closest('.mantine-InputWrapper-root')!.querySelector('.mantine-Input-wrapper'))
          if (button) {
            const b = Array.from(el.querySelectorAll('button')).find((x) => x.textContent?.trim() === button)
            out[`${key}Save`] = rect(b)
          }
        }
        return out
      })

    let last = ''
    await expect
      .poll(
        async () => {
          const now = JSON.stringify(await read())
          const settled = now === last
          last = now
          return settled
        },
        { intervals: [100], timeout: 5000 }
      )
      .toBe(true)
    await expect(color).toBeVisible()

    const r = await read()
    expect(Math.abs(r.base.l - r.label.l), 'left edges').toBeLessThan(1)
    expect(Math.abs(r.base.l - r.color.l), 'color left edge').toBeLessThan(1)
    expect(Math.abs(r.base.r - r.label.r), 'right edges').toBeLessThan(1)
    expect(Math.abs(r.base.r - r.color.r), 'color right edge').toBeLessThan(1)
    expect(Math.abs(r.baseSave.w - r.labelSave.w), 'Save widths').toBeLessThan(1)
    expect(Math.abs(r.baseSave.l - r.labelSave.l), 'Save left edges').toBeLessThan(1)
    expect(Math.abs(r.baseSave.y - r.base.y), 'Save base branch is level with its input').toBeLessThan(2)
    expect(Math.abs(r.labelSave.y - r.label.y), 'Save label is level with its input').toBeLessThan(2)
  } finally {
    await app?.close().catch(() => undefined)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

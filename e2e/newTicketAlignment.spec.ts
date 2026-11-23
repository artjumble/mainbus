import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { addWorkspace } from './addWorkspace'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

// The New ticket dialog's Change/Investigate radios and its Ready checkbox must sit level with their labels
// (the alignment fix from #56). This is the only check of it; the themed artboards run in a separate script.
test("the New ticket dialog's radios and Ready checkbox sit level with their labels", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | null = null
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

    await page.getByRole('button', { name: 'New ticket' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New ticket' })
    await expect(dialog.getByLabel('Title')).toBeVisible()
    // Wait for the dialog to stop easing in, so that every read sees its final position.
    let last = ''
    await expect
      .poll(
        async () => {
          const now = JSON.stringify(await dialog.boundingBox())
          const settled = now === last
          last = now
          return settled
        },
        { intervals: [100], timeout: 5000 }
      )
      .toBe(true)

    // Both rects are read in one go, since the dialog may still be easing in between two separate reads.
    const rects = (name: string): Promise<{ input: DOMRect; label: DOMRect }> =>
      dialog.getByLabel(name).first().evaluate((el) => {
        const input = el as HTMLInputElement
        return { input: input.getBoundingClientRect(), label: input.labels![0].getBoundingClientRect() }
      })
    const centre = (r: DOMRect): number => r.y + r.height / 2
    for (const name of ['Agents', 'Me', 'Change', 'Investigate', "Ask the orchestrator to start an agent once it's in Ready"]) {
      const { input, label } = await rects(name)
      expect(Math.abs(centre(input) - centre(label)), name).toBeLessThan(2)
    }
    // Each radio group (Owner, Kind) has two radios, level with each other.
    for (const group of ['Owner', 'Kind']) {
      const tops = await dialog
        .getByRole('radiogroup', { name: group })
        .evaluate((el) => Array.from(el.querySelectorAll<HTMLInputElement>('input[type=radio]')).map((r) => r.getBoundingClientRect().y))
      expect(tops, group).toHaveLength(2)
      expect(Math.abs(tops[0] - tops[1]), group).toBeLessThan(1)
    }
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, 'out', 'cli', 'mainbus.cjs')
// The electron package's main export is the path to its binary: the same binary Mainbus.exe is.
const electronBinary = createRequire(import.meta.url)('electron') as unknown as string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['MAINBUS_AGENT']
  return env
}

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...cleanEnv(),
      MAINBUS_HOME: home,
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/ask-then-handoff.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  return { app, page: await app.firstWindow() }
}

test('the CLI bundle is self-contained and never loads node:sqlite, Electron or React', () => {
  const required = new Set([...fs.readFileSync(bundle, 'utf8').matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1]!))
  for (const name of required) {
    // ajv's code generator mentions its own modules inside template strings; those are never loaded.
    if (name.startsWith('ajv')) continue
    expect(name, `${bundle} requires ${name}`).toMatch(/^node:(?!sqlite)/)
  }
})

test('agents file tickets through the CLI and the MCP server, and the board shows them at once', async () => {
  let tmp: string | null = null
  let session: { app: ElectronApplication; page: Page } | null = null
  let client: Client | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-intake-'))
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    const cli = (args: string[], input?: string) =>
      spawnSync(process.execPath, [bundle, ...args], {
        cwd: repo,
        env: { ...cleanEnv(), MAINBUS_HOME: home },
        input,
        encoding: 'utf8',
        windowsHide: true
      })

    // Before the app runs, the CLI fails fast with exit 3.
    const early = cli(['ticket', 'list'])
    expect(early.status).toBe(3)
    expect(early.stderr).toContain(`Mainbus isn't running (data home: ${home})`)

    session = await launch(home, repo)
    const { page } = session
    await page.getByRole('button', { name: 'Open a repo folder' }).click()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()

    // The CLI, with the ticket as JSON on stdin.
    const created = cli(
      ['ticket', 'create', '--json', '-'],
      JSON.stringify({ title: 'Flaky login test', intent: 'It fails one run in ten.', agent: 'cli-agent', labels: ['ci'] })
    )
    expect(created.stderr).toBe('')
    expect(created.status).toBe(0)
    expect(created.stdout).toBe('#1 Flaky login test\n')

    const backlog = page.getByRole('region', { name: 'Backlog' })
    await expect(backlog.getByText('Flaky login test')).toBeVisible()
    await expect(backlog.getByText('from cli-agent (reported)')).toBeVisible()

    // The MCP server over stdio, on the Electron binary in Node mode: no Node install involved.
    client = new Client({ name: 'e2e-agent', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: electronBinary,
        args: [bundle, 'mcp'],
        cwd: repo,
        env: { ...cleanEnv(), MAINBUS_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
        stderr: 'pipe'
      })
    )
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['create_ticket', 'get_ticket', 'list_tickets'])
    const result = await client.callTool({ name: 'create_ticket', arguments: { title: 'Parser drops tabs', intent: 'Keep tabs.' } })
    expect(result.isError).toBeFalsy()
    await expect(backlog.getByText('Parser drops tabs')).toBeVisible()
    await expect(backlog.getByText('from e2e-agent (reported)')).toBeVisible()

    const listed = JSON.parse(cli(['ticket', 'list', '--json']).stdout) as { number: number; source: { agent: string } }[]
    expect(listed.map((t) => [t.number, t.source.agent])).toEqual([
      [1, 'cli-agent'],
      [2, 'e2e-agent']
    ])

    // The ticket view keeps the agent's words apart from the user's.
    await backlog.getByText('Parser drops tabs').click()
    const fromAgent = page.getByRole('region', { name: 'From an agent' })
    await expect(fromAgent.getByText('Keep tabs.')).toBeVisible()
    await expect(fromAgent.getByText('from e2e-agent (reported)')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Your words' }).getByText("You haven't added your own words yet.")).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()

    // The settings drawer shows the dev setup lines for this home.
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const connect = page.getByRole('region', { name: 'Connect agents' })
    await expect(connect.getByText(`--scope user mainbus-dev -- node ${bundle} mcp`, { exact: false })).toBeVisible()
    await expect(connect.getByText(`MAINBUS_HOME=${home}`, { exact: false })).toBeVisible()
  } finally {
    await client?.close().catch(() => {})
    await session?.app.close().catch(() => {})
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
})

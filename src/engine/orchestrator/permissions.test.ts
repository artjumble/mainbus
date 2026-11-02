import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runGit } from '../git/git'
import { makeRepo } from '../intake/testBoard'
import { ORCHESTRATOR_DENIED, orchestratorVerdict } from './permissions'

let tmp: string
let CWD: string
let REPO: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-orch-perm-'))
  CWD = path.join(tmp, 'home', 'orchestrator')
  await fs.mkdir(CWD, { recursive: true })
  REPO = await makeRepo(path.join(tmp, 'repo'))
  await write('.gitignore', '.env\nsecrets/\n')
  await write('.env', 'API_KEY=FAKE')
  await write('src/index.ts', 'export {}\n')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function write(rel: string, text: string, root = REPO): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}

const verdict = (tool: string, input: Record<string, unknown>) => orchestratorVerdict(tool, input, { cwd: CWD, repo: REPO })

async function deniedFor(tool: string, input: Record<string, unknown>): Promise<string> {
  const v = await verdict(tool, input)
  if (v.allow) throw new Error(`${tool} ${JSON.stringify(input)} was allowed`)
  return v.message
}

describe('orchestratorVerdict', () => {
  test('allows reads in the repo and its own folder, and the Mainbus read tools', async () => {
    const allowed: [string, Record<string, unknown>][] = [
      ['Read', { file_path: path.join(REPO, 'src', 'index.ts') }],
      ['Read', { file_path: 'notes.md' }],
      ['Grep', { pattern: 'TODO', path: path.join(REPO, 'src') }],
      ['Grep', { pattern: 'TODO' }],
      ['Glob', { pattern: '**/*.ts', path: REPO }],
      ['Glob', { pattern: '*.md' }],
      ['mcp__mainbus__list_workspaces', {}],
      ['mcp__mainbus__list_tickets', { column: 'ready' }],
      ['mcp__mainbus__get_ticket', { number: 1 }],
      ['mcp__mainbus__get_run_status', { number: 1 }],
      ['mcp__mainbus__get_recent_events', { number: 1 }],
      ['mcp__mainbus__list_pending_decisions', {}]
    ]
    for (const [tool, input] of allowed) expect(await verdict(tool, input), `${tool} ${JSON.stringify(input)}`).toEqual({ allow: true })
  })

  test.each([
    ['Read', () => ({ file_path: path.join(REPO, '.env') })],
    ['Read', () => ({ file_path: 'C:\\Users\\x\\.ssh\\id_rsa' })],
    ['Read', () => ({ file_path: 'C:\\Users\\x\\.claude\\.credentials.json' })],
    ['Grep', () => ({ pattern: 'KEY', path: path.join(REPO, '.env') })],
    ['Grep', () => ({ pattern: 'KEY', path: REPO, glob: '.env*' })],
    ['Glob', () => ({ pattern: '**/.env', path: REPO })]
  ])('denies the credential file %s names', async (tool, input) => {
    expect(await deniedFor(tool, input())).toMatch(/^Reads a credentials file/)
  })

  test('denies reads outside its folder and the repo', async () => {
    expect(await deniedFor('Read', { file_path: path.join(tmp, 'other', 'README.md') })).toContain(ORCHESTRATOR_DENIED)
  })

  test.each([
    ['Write', { file_path: 'C:\\code\\repo\\x.ts', content: '' }],
    ['Edit', { file_path: 'C:\\code\\repo\\x.ts', old_string: 'a', new_string: 'b' }],
    ['Bash', { command: 'ls' }],
    ['PowerShell', { command: 'ls' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['WebSearch', { query: 'x' }],
    ['Task', { prompt: 'x' }],
    ['Agent', { prompt: 'x' }],
    ['AskUserQuestion', { questions: [] }],
    ['mcp__mainbus__handoff', { summary: 'x' }],
    ['mcp__other__tool', {}]
  ])('denies %s without a card', async (tool, input) => {
    expect(await verdict(tool, input)).toEqual({ allow: false, message: ORCHESTRATOR_DENIED })
  })
})

describe('a Grep that searches a folder', () => {
  test('is allowed over a repo whose only credential file is gitignored', async () => {
    expect(await verdict('Grep', { pattern: 'API_KEY|.', path: REPO, output_mode: 'content' })).toEqual({ allow: true })
  })

  test('is denied over a repo with a credential file ripgrep would search', async () => {
    await write('.npmrc', '//registry.npmjs.org/:_authToken=FAKE_TOKEN_123\n')
    for (const mode of ['content', 'files_with_matches', 'count']) {
      expect(await deniedFor('Grep', { pattern: 'authToken', path: REPO, output_mode: mode })).toContain(
        'This search would read a credentials file: .npmrc.'
      )
    }
    // A tracked one counts too, and so does one deeper down.
    await runGit(['add', '.npmrc'], REPO)
    expect(await deniedFor('Grep', { pattern: 'x', path: REPO })).toContain('.npmrc')
    await write('config/deploy.pem', 'KEY')
    expect(await deniedFor('Grep', { pattern: 'x', path: path.join(REPO, 'config') })).toContain('deploy.pem')
  })

  test('is allowed when its glob leaves the credential files out, and denied when it might not', async () => {
    await write('.npmrc', 'token')
    await write('certs/server.key', 'KEY')
    const grep = (glob: string) => verdict('Grep', { pattern: 'x', path: REPO, glob })
    for (const glob of ['*.ts', '**/*.ts', 'src/**', '*.{ts,tsx}', '*.md, *.ts']) {
      expect(await grep(glob), glob).toEqual({ allow: true })
    }
    for (const glob of ['*', '**', '.*', '*rc', '*.{ts,npmrc}', '!*.md', 'certs/*', '*.KEY', 'serv?r.[kx]ey', '*.ts *']) {
      expect((await grep(glob)).allow, glob).toBe(false)
    }
  })

  test('is allowed in a subfolder without credential files', async () => {
    await write('.npmrc', 'token')
    expect(await verdict('Grep', { pattern: 'x', path: path.join(REPO, 'src') })).toEqual({ allow: true })
    expect(await verdict('Grep', { pattern: 'x', path: 'src' })).toEqual({ allow: true })
  })

  test('is denied in a gitignored folder that holds one, since ripgrep searches a folder it is given', async () => {
    await write('secrets/.env', 'API_KEY=FAKE')
    expect(await deniedFor('Grep', { pattern: 'x', path: path.join(REPO, 'secrets') })).toContain('.env')
    // From the repo root, ripgrep skips the ignored folder.
    expect(await verdict('Grep', { pattern: 'x', path: REPO })).toEqual({ allow: true })
  })

  test('is denied over an untracked nested repository that holds one', async () => {
    const nested = path.join(REPO, 'vendor', 'lib')
    await fs.mkdir(nested, { recursive: true })
    await runGit(['init', '-b', 'main'], nested)
    await write('.npmrc', 'token', nested)
    expect(await deniedFor('Grep', { pattern: 'x', path: REPO })).toContain('vendor/lib/.npmrc')
  })

  test('outside a git repository, checks every file: its own folder with a .env is denied', async () => {
    expect(await verdict('Grep', { pattern: 'x' })).toEqual({ allow: true })
    await write('.env', 'API_KEY=FAKE', CWD)
    expect(await deniedFor('Grep', { pattern: 'x' })).toContain('.env')
    expect(await verdict('Grep', { pattern: 'x', glob: '*.md' })).toEqual({ allow: true })
  })
})

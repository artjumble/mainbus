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
let HOME: string
let TICKETS: string
let WT: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-orch-perm-'))
  HOME = path.join(tmp, 'home')
  CWD = path.join(HOME, 'orchestrator')
  TICKETS = path.join(HOME, 'work', 'ws')
  WT = path.join(TICKETS, '1-fix')
  await fs.mkdir(CWD, { recursive: true })
  REPO = await makeRepo(path.join(tmp, 'repo'))
  await write('.gitignore', '.env\nsecrets/\n')
  await write('.env', 'API_KEY=FAKE')
  await write('src/index.ts', 'export {}\n')
  await runGit(['add', '-A'], REPO)
  await runGit(['commit', '-m', 'files'], REPO)
  await runGit(['worktree', 'add', '-b', 't1', WT], REPO)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function write(rel: string, text: string, root = REPO): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}

const verdict = (tool: string, input: Record<string, unknown>) => orchestratorVerdict(tool, input, { cwd: CWD, readable: [REPO, TICKETS] })

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
      ['mcp__mainbus__list_pending_decisions', {}],
      // Proposing only stores a proposal for the user to decide.
      ['mcp__mainbus__propose_create_tickets', { tickets: [{ title: 'Add login' }] }],
      // Creating only puts tickets in a Backlog, where nothing runs.
      ['mcp__mainbus__create_tickets', { workspace: 'repo', tickets: [{ title: 'Add login' }] }]
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

describe('ticket folders', () => {
  test('allows Read, Glob and Grep in a ticket worktree, one made later too', async () => {
    await write('src/a.ts', 'export {}\n', WT)
    const later = path.join(TICKETS, '2-new')
    await fs.mkdir(later, { recursive: true })
    for (const dir of [WT, later]) {
      expect(await verdict('Read', { file_path: path.join(dir, 'src', 'a.ts') })).toEqual({ allow: true })
      expect(await verdict('Glob', { pattern: '**/*.ts', path: dir })).toEqual({ allow: true })
      expect(await verdict('Grep', { pattern: 'x', path: dir })).toEqual({ allow: true })
    }
  })

  test('refuses credential files in a worktree', async () => {
    await write('.env', 'API_KEY=FAKE', WT)
    expect(await deniedFor('Read', { file_path: path.join(WT, '.env') })).toMatch(/^Reads a credentials file/)
    await write('.npmrc', 'token', WT)
    expect(await deniedFor('Grep', { pattern: 'x', path: WT })).toContain('.npmrc')
    // From the parent folder every file is checked, so the gitignored .env is caught.
    await fs.rm(path.join(WT, '.npmrc'))
    expect(await deniedFor('Grep', { pattern: 'x', path: TICKETS })).toContain('.env')
  })

  test.each([
    ['another workspace', () => path.join(HOME, 'work', 'other', '1-x', 'a.ts')],
    ['a folder sharing the prefix', () => path.join(HOME, 'work', 'ws-2', 'a.ts')],
    ['a scratch folder', () => path.join(HOME, 'scratch', 'ws', '1-fix', 'a.txt')],
    ['the database', () => path.join(HOME, 'mainbus.db')],
    ['the backups', () => path.join(HOME, 'backups', 'x')]
  ])('refuses %s', async (_name, file) => {
    expect(await deniedFor('Read', { file_path: file() })).toContain(ORCHESTRATOR_DENIED)
  })

  test.each(['Write', 'Edit', 'Bash', 'PowerShell'])('still refuses %s with a path in a worktree', async (tool) => {
    const input = { file_path: path.join(WT, 'a.ts'), command: `ls ${WT}`, content: '', old_string: 'a', new_string: 'b' }
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

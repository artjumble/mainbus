import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import { runCommand, type CommandOptions, type CommandRunner } from './command'
import { FakeGh } from './fakeGh'
import { runGit } from './git'
import { PR_COMMAND_TIMEOUT_MS, prBody, PullRequestPublisher, type PublishInput } from './pullRequests'

let tmp: string
let repo: string
let origin: string
let gh: FakeGh
let calls: { file: string; args: string[]; opts: CommandOptions }[]
let runner: CommandRunner

const BRANCH = 'mainbus/3-add-login'

// Real pushes to a local origin: slow on a busy machine.
vi.setConfig({ testTimeout: 60_000 })

async function git(args: string[], cwd = repo): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

async function commit(file: string, text: string): Promise<void> {
  await fs.writeFile(path.join(repo, file), text)
  await git(['add', file])
  await git(['commit', '-m', `edit ${file}`])
}

function ticket(over: Partial<Ticket> = {}): PublishInput['ticket'] {
  return {
    id: 't1',
    workspaceId: 'w1',
    number: 3,
    kind: 'change',
    title: 'Add login',
    intent: [
      { text: 'Let people log in', at: '2026-10-30T12:00:00.000Z' },
      { text: 'Filed for you', at: '2026-10-30T12:00:00.000Z', source: { kind: 'agent', agent: 'bot', cwd: '/x' } }
    ],
    spec: '',
    criteria: [
      { position: 0, text: 'form renders', checked: false },
      { position: 1, text: 'bad password rejected', checked: true }
    ],
    labels: [],
    manualColumn: 'ready',
    branch: BRANCH,
    worktreePath: repo,
    pr: null,
    prError: null,
    createdAt: '2026-10-30T12:00:00.000Z',
    updatedAt: '2026-10-30T12:00:00.000Z',
    ...over
  } as PublishInput['ticket']
}

function publisher(run: CommandRunner = runner, timeoutMs?: number): PullRequestPublisher {
  return new PullRequestPublisher(run, timeoutMs)
}

async function remoteHead(branch = BRANCH): Promise<string> {
  return (await git(['rev-parse', branch], origin)).trim()
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-pr-'))
  repo = path.join(tmp, 'repo')
  origin = path.join(tmp, 'origin.git')
  await fs.mkdir(repo)
  await git(['init', '-b', 'main'])
  await commit('README.md', 'hello')
  await git(['init', '--bare', '-b', 'main', origin], tmp)
  await git(['remote', 'add', 'origin', origin])
  await git(['push', 'origin', 'main'])
  await git(['checkout', '-b', BRANCH])
  await commit('login.ts', 'export {}')
  gh = new FakeGh()
  calls = []
  const recorded: CommandRunner = (file, args, opts) => {
    calls.push({ file, args, opts })
    return runCommand(file, args, opts)
  }
  runner = gh.runner(recorded)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('PullRequestPublisher', () => {
  it('pushes the branch to origin and opens a ready PR against the base branch', async () => {
    const result = await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: 'Added the form.' })

    expect(result).toEqual({ ok: true, pr: { url: 'https://github.com/example/repo/pull/1', number: 1 }, opened: true })
    expect(await remoteHead()).toBe((await git(['rev-parse', 'HEAD'])).trim())
    expect(gh.prs).toHaveLength(1)
    expect(gh.prs[0]).toMatchObject({ base: 'main', head: BRANCH, title: 'Add login', draft: false })
    expect(gh.prs[0].body).toBe(prBody(ticket(), 'Added the form.'))
  })

  it('pushes only the ticket branch, never with force, without prompts and with a timeout', async () => {
    await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })

    const pushes = calls.filter((c) => c.file === 'git' && c.args.includes('push'))
    expect(pushes.map((c) => c.args)).toEqual([['push', '-u', 'origin', BRANCH]])
    for (const c of calls) {
      expect(c.args.join(' ')).not.toMatch(/--force|-f\b|\+refs|--mirror|--all/)
      expect(c.opts.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' })
      expect(c.opts.timeoutMs).toBe(PR_COMMAND_TIMEOUT_MS)
    }
    expect(gh.calls.find((a) => a[1] === 'create')).not.toContain('--draft')
  })

  it('builds the body from the user words, the handoff summary, the criteria and the ticket number', () => {
    expect(prBody(ticket(), 'Added the form.')).toBe(
      [
        '## In your words',
        'Let people log in',
        '## Handoff',
        'Added the form.',
        '## Acceptance criteria',
        '- [ ] form renders\n- [x] bad password rejected',
        '---',
        'Mainbus ticket #3'
      ].join('\n\n') + '\n'
    )
  })

  it('titles an Investigate ticket\'s PR "Investigation #<n>: <title>" and names its report file in the body', async () => {
    const investigation = ticket({ kind: 'investigate', title: 'Why is login slow', criteria: [], reportFile: 'docs/investigations/2026-11-06-3-why.md' })
    const result = await publisher().publish({ ticket: investigation, baseBranch: 'main', handoffSummary: null })
    expect(result).toMatchObject({ ok: true, opened: true })
    expect(gh.prs[0]).toMatchObject({ title: 'Investigation #3: Why is login slow', draft: false })
    expect(gh.prs[0].body).toBe(
      ['## In your words', 'Let people log in', '## Report', 'Saved as `docs/investigations/2026-11-06-3-why.md`.', '---', 'Mainbus ticket #3'].join('\n\n') +
        '\n'
    )
  })

  it('only pushes when the ticket already has a PR, so the same PR is updated', async () => {
    const first = await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })
    if (!first.ok) throw new Error(first.reason)
    await commit('login.ts', 'export const x = 1')

    const second = await publisher().publish({ ticket: ticket({ pr: first.pr }), baseBranch: 'main', handoffSummary: 'More' })

    expect(second).toEqual({ ok: true, pr: first.pr, opened: false })
    expect(gh.prs).toHaveLength(1)
    expect(gh.calls.filter((a) => a[0] === 'pr')).toHaveLength(1)
    expect(await remoteHead()).toBe((await git(['rev-parse', 'HEAD'])).trim())
  })

  it('adopts a PR that already exists for the branch', async () => {
    await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })

    // The ticket doesn't know about it (say, the user opened it by hand).
    const again = await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })

    expect(again).toEqual({ ok: true, pr: { url: 'https://github.com/example/repo/pull/1', number: 1 }, opened: true })
    expect(gh.prs).toHaveLength(1)
  })

  it('fails when there is no origin remote, without pushing', async () => {
    await git(['remote', 'remove', 'origin'])
    const result = await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })
    expect(result).toEqual({ ok: false, reason: 'the repository has no origin remote' })
    expect(calls.some((c) => c.args.includes('push'))).toBe(false)
  })

  it('fails when gh is missing or signed out, before pushing', async () => {
    gh.state = 'missing'
    expect(await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })).toEqual({
      ok: false,
      reason: 'the GitHub CLI (gh) is not installed'
    })
    gh.state = 'signed_out'
    const signedOut = await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })
    expect(signedOut).toEqual({ ok: false, reason: 'the GitHub CLI (gh) is not signed in; run `gh auth login`' })
    expect(calls.some((c) => c.args.includes('push'))).toBe(false)
  })

  it('reports a rejected push and never forces it', async () => {
    await publisher().publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })
    // The agent rewrote history: the branch no longer contains what origin has.
    await git(['reset', '--hard', 'main'])
    await commit('other.ts', 'export {}')
    const before = await remoteHead()

    const result = await publisher().publish({
      ticket: ticket({ pr: { url: 'https://github.com/example/repo/pull/1', number: 1 } }),
      baseBranch: 'main',
      handoffSummary: null
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/^git push failed: .*rejected/)
    expect(await remoteHead()).toBe(before)
  })

  it('reports a timeout', async () => {
    const slow: CommandRunner = async (file, args, opts) =>
      file === 'git' && args[0] === 'push' ? { code: -1, stdout: '', stderr: '', timedOut: true } : runner(file, args, opts)
    const result = await publisher(slow).publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })
    expect(result).toEqual({ ok: false, reason: 'git push timed out after 2 minutes' })
  })

  it('reports gh errors, keeping credentials out of the reason', async () => {
    const failing: CommandRunner = async (file, args, opts) =>
      file === 'gh' && args[1] === 'create'
        ? { code: 1, stdout: '', stderr: 'could not reach https://user:secret@github.com/o/r\n', timedOut: false }
        : runner(file, args, opts)
    const result = await publisher(failing).publish({ ticket: ticket(), baseBranch: 'main', handoffSummary: null })
    expect(result).toEqual({ ok: false, reason: 'gh pr create failed: could not reach https://github.com/o/r' })
  })

  it('checks gh without passing on its output', async () => {
    expect(await publisher().checkGh(repo)).toEqual({ ok: true })
    gh.state = 'signed_out'
    expect(await publisher().checkGh(repo)).toEqual({ ok: false, reason: 'the GitHub CLI (gh) is not signed in; run `gh auth login`' })
    gh.state = 'missing'
    expect(await publisher().checkGh(repo)).toEqual({ ok: false, reason: 'the GitHub CLI (gh) is not installed' })
  })
})

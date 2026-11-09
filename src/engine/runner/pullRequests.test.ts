import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runCommand } from '../git/command'
import { FakeGh } from '../git/fakeGh'
import { runGit } from '../git/git'
import { PullRequestPublisher } from '../git/pullRequests'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome } from '../home'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { defaultLineup } from '../store/lineups'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

const BRANCH = 'mainbus/1-rate-limit-login'
const PR = { url: 'https://github.com/example/repo/pull/1', number: 1 }
const keepAlive: FakeStep[] = [{ waitForSend: true }]
/** Real pushes to a local origin: slow on a busy machine, so the waits and tests get room. */
const WAIT = { timeout: 20_000, interval: 50 }
vi.setConfig({ testTimeout: 60_000 })

let tmp: string
let repoPath: string
let origin: string
let closeDb: () => void
let repos: Repos
let worktrees: WorktreeManager
let ticket: Ticket
let runners: TicketRunner[]
let gh: FakeGh
let publishes: number
/** Holds every publish until opened, to show the handoff doesn't wait for it. */
let gate: Promise<void>
let openGate: () => void

async function git(args: string[], cwd = repoPath): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-runner-pr-'))
  repoPath = path.join(tmp, 'repo')
  origin = path.join(tmp, 'origin.git')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])
  // A local bare repository stands in for the remote: nothing here reaches a real one.
  await git(['init', '--bare', '-b', 'main', origin], tmp)
  await git(['remote', 'add', 'origin', origin])
  await git(['push', 'origin', 'main'])

  const paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  repos = createRepos(testDb.db, () => FIXED_NOW)
  worktrees = new WorktreeManager(runGit, paths, repos.cleanups)
  const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
  // Most tests here are about what one role does; the lineup tests set their own roles.
  await implementerOnly(repos.lineups, ws.id)
  await repos.workspaces.setOpenPrOnReview(ws.id, true)
  ticket = await repos.tickets.create({
    workspaceId: ws.id,
    title: 'Rate-limit login',
    intent: 'Limit login attempts to five a minute',
    spec: '',
    criteria: ['Six attempts are refused'],
    labels: [],
    column: 'ready'
  })
  runners = []
  gh = new FakeGh()
  publishes = 0
  gate = Promise.resolve()
  openGate = () => {}
})

afterEach(async () => {
  for (const runner of runners) await runner.stop(ticket.id).catch(() => {})
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

function makeRunner(runtime: FakeRuntime, unattended = false): TicketRunner {
  const publisher = new PullRequestPublisher(gh.runner(runCommand))
  const runner = new TicketRunner({
    repos,
    worktrees,
    runtime,
    now: () => FIXED_NOW,
    emit: () => {},
    unattended: () => unattended,
    pullRequests: {
      publish: async (input) => {
        publishes++
        await gate
        return publisher.publish(input)
      }
    }
  })
  runners.push(runner)
  return runner
}

/** Starts a run and hands it off; returns what the agent was told. */
async function handOff(runner: TicketRunner, runtime: FakeRuntime, summary = 'Added the limiter'): Promise<string> {
  await runner.start(ticket.id)
  return runtime.specs[runtime.specs.length - 1].roleTools.handoff({ summary, notesForNext: '' })
}

async function thread(): Promise<ThreadEvent[]> {
  const run = await repos.runs.latest(ticket.id)
  return run ? (await repos.runs.events(run.id)).map((e) => e.event) : []
}

async function remoteBranch(): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], origin)
  return r.code === 0 ? r.stdout.trim() : null
}

/** Waits until the ticket has a PR or a PR failure. */
async function waitForOutcome(): Promise<Ticket> {
  return eventually(async () => {
    const t = await repos.tickets.get(ticket.id)
    expect(t.pr ?? t.prError).not.toBeNull()
    return t
  }, WAIT)
}

describe('TicketRunner opening pull requests', () => {
  it('moves the ticket to Review at once, then pushes the branch and opens a ready PR', async () => {
    gate = new Promise((resolve) => (openGate = resolve))
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)

    expect(await handOff(runner, runtime)).toBe('Handed off. Your part is done; end your turn now.')
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review' })
    await eventually(() => expect(publishes).toBe(1))
    expect(await remoteBranch()).toBeNull()

    openGate()
    const t = await waitForOutcome()

    expect(t).toMatchObject({ pr: PR, prError: null })
    expect(await remoteBranch()).toBe((await git(['rev-parse', 'HEAD'], t.worktreePath as string)).trim())
    expect(gh.prs).toEqual([expect.objectContaining({ base: 'main', head: BRANCH, title: 'Rate-limit login', draft: false })])
    expect(gh.prs[0].body).toContain('Limit login attempts to five a minute')
    expect(gh.prs[0].body).toContain('Added the limiter')
    expect(gh.prs[0].body).toContain('- [ ] Six attempts are refused')
    expect(gh.prs[0].body).toContain('Mainbus ticket #1')
    expect(await thread()).toContainEqual({ kind: 'pull_request', branch: BRANCH, ...PR, opened: true })
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review', agentStatus: 'handed_off' })
  })

  it('through a three-role lineup, pushes and opens the PR once, after the last role hands off', async () => {
    await repos.lineups.save(ticket.workspaceId, defaultLineup())
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)

    for (const [i, role] of ['Planner', 'Implementer', 'Reviewer'].entries()) {
      const spec = await eventually(() => {
        expect(runtime.specs[i]).toBeDefined()
        return runtime.specs[i]!
      }, WAIT)
      await eventually(async () => expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'working' }))
      expect(spec.appendSystemPrompt).toContain(`## Your role: ${role}\n`)
      // Nothing is pushed while a role is still to come.
      expect(publishes).toBe(0)
      expect(await remoteBranch()).toBeNull()
      expect(await spec.roleTools.handoff({ summary: `${role} is done`, notesForNext: '' })).toBe(
        'Handed off. Your part is done; end your turn now.'
      )
    }

    const t = await waitForOutcome()
    expect(t).toMatchObject({ pr: PR, prError: null })
    expect(publishes).toBe(1)
    expect(gh.prs).toHaveLength(1)
    // The PR describes the last role's handoff.
    expect(gh.prs[0].body).toContain('Reviewer is done')
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review', agentStatus: 'handed_off' })
  })

  it('with the setting off, pushes nothing, and Retry is refused', async () => {
    await repos.workspaces.setOpenPrOnReview(ticket.workspaceId, false)
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await handOff(runner, runtime)

    await expect(runner.openPr(ticket.id)).rejects.toThrow('Turn on "Open a PR when a ticket reaches Review"')
    // The step queued by the handoff ran before the Retry above.
    expect(publishes).toBe(0)
    expect(await remoteBranch()).toBeNull()
    expect((await repos.tickets.get(ticket.id)).pr).toBeNull()
  })

  it('a second handoff after the ticket is sent back pushes to the same PR', async () => {
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await handOff(runner, runtime)
    const first = await waitForOutcome()
    expect(first.pr).toEqual(PR)

    // Start again: the agent commits more work and hands off again.
    await runner.start(ticket.id)
    const wt = first.worktreePath as string
    await fs.writeFile(path.join(wt, 'limiter.ts'), 'export {}\n')
    await git(['add', '.'], wt)
    await git(['commit', '-m', 'limiter'], wt)
    await runtime.specs[1].roleTools.handoff({ summary: 'Round two', notesForNext: '' })

    await eventually(async () => expect((await thread()).some((e) => e.kind === 'pull_request')).toBe(true), WAIT)
    expect(await thread()).toContainEqual({ kind: 'pull_request', branch: BRANCH, ...PR, opened: false })
    expect(gh.prs).toHaveLength(1)
    expect(gh.calls.filter((a) => a[0] === 'pr')).toHaveLength(1)
    expect(await remoteBranch()).toBe((await git(['rev-parse', 'HEAD'], wt)).trim())
    expect((await repos.tickets.get(ticket.id)).pr).toEqual(PR)
  })

  it('a failure leaves the ticket in Review with the reason, and Retry works once the cause is fixed', async () => {
    await git(['remote', 'remove', 'origin'])
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await handOff(runner, runtime)

    expect((await waitForOutcome()).prError).toBe('the repository has no origin remote')
    expect(await thread()).toContainEqual({ kind: 'notice', text: "Couldn't open a PR: the repository has no origin remote" })
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review', agentStatus: 'handed_off' })

    await git(['remote', 'add', 'origin', origin])
    gh.state = 'signed_out'
    await runner.openPr(ticket.id)
    expect((await repos.tickets.get(ticket.id)).prError).toBe('the GitHub CLI (gh) is not signed in; run `gh auth login`')

    gh.state = 'ok'
    await runner.openPr(ticket.id)
    expect(await repos.tickets.get(ticket.id)).toMatchObject({ pr: PR, prError: null })
    expect(await remoteBranch()).not.toBeNull()
  })

  it('a new handoff clears a failure from an earlier round', async () => {
    await git(['remote', 'remove', 'origin'])
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await handOff(runner, runtime)
    await waitForOutcome()

    await repos.workspaces.setOpenPrOnReview(ticket.workspaceId, false)
    await runner.start(ticket.id)
    await runtime.specs[1].roleTools.handoff({ summary: 'Round two', notesForNext: '' })
    await eventually(async () => expect((await repos.tickets.get(ticket.id)).prError).toBeNull(), WAIT)
  })

  it('never pushes a ticket that is not in Review, or is Done', async () => {
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await expect(runner.openPr(ticket.id)).rejects.toThrow('Only a ticket in Review can be pushed')
    await runner.start(ticket.id)
    await expect(runner.openPr(ticket.id)).rejects.toThrow('Only a ticket in Review can be pushed')

    await runtime.specs[0].roleTools.handoff({ summary: 'Added the limiter', notesForNext: '' })
    await waitForOutcome()
    expect(await runner.moveToDone(ticket.id)).toBe('done')

    await expect(runner.openPr(ticket.id)).rejects.toThrow('Only a ticket in Review can be pushed')
    expect(publishes).toBe(1)
  })

  it('in unattended mode, a PR failure leaves the ticket in Review, not failed', async () => {
    await git(['remote', 'remove', 'origin'])
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime, true)
    await handOff(runner, runtime)

    expect((await waitForOutcome()).prError).toBe('the repository has no origin remote')
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review', agentStatus: 'handed_off' })
    expect(await repos.decisions.pending(ticket.id)).toEqual([])
  })

  it("the agent's own git push still asks the user, in unattended mode too", async () => {
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime, true)
    await runner.start(ticket.id)
    const request = {
      toolName: 'Bash',
      input: { command: `git push origin ${BRANCH}` },
      toolUseId: 'tool-1',
      signal: new AbortController().signal
    }
    void runtime.specs[0].onPermission(request)
    await eventually(async () => expect(await repos.decisions.pending(ticket.id)).toHaveLength(1))
    expect(await remoteBranch()).toBeNull()
  })
})

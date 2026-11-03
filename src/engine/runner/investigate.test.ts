import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome } from '../home'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { createRepos, type Repos } from '../store'
import { defaultInvestigateLineup } from '../store/lineups'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { TicketRunner } from './ticketRunner'

const keepAlive: FakeStep[] = [{ waitForSend: true }]
const REPORT = '# Findings\n\nThe cause is X.'

let tmp: string
let repoPath: string
let closeDb: () => void
let repos: Repos
let worktrees: WorktreeManager
let workspaceId: string
let changeTicket: Ticket
let investigation: Ticket
let runners: TicketRunner[]
let publish: ReturnType<typeof vi.fn>

async function git(args: string[], cwd = repoPath): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-investigate-'))
  repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])

  const paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  repos = createRepos(testDb.db, () => FIXED_NOW)
  worktrees = new WorktreeManager(runGit, paths, repos.cleanups)
  const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
  workspaceId = ws.id
  await implementerOnly(repos.lineups, ws.id)
  await repos.workspaces.setOpenPrOnReview(ws.id, true)
  const draft = {
    workspaceId: ws.id,
    title: 'Why is login slow',
    intent: 'Look into it',
    spec: '',
    criteria: [],
    labels: [],
    column: 'ready' as const
  }
  changeTicket = await repos.tickets.create(draft)
  investigation = await repos.tickets.create({ ...draft, kind: 'investigate' })
  runners = []
  publish = vi.fn(async () => ({ number: 1, url: 'https://example.test/pull/1', opened: true }))
})

afterEach(async () => {
  for (const runner of runners) {
    await runner.stop(changeTicket.id).catch(() => {})
    await runner.stop(investigation.id).catch(() => {})
  }
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

function makeRunner(runtime: FakeRuntime): TicketRunner {
  const runner = new TicketRunner({
    repos,
    worktrees,
    runtime,
    now: () => FIXED_NOW,
    emit: () => {},
    unattended: () => false,
    pullRequests: { publish: publish as never }
  })
  runners.push(runner)
  return runner
}

async function thread(ticketId: string): Promise<ThreadEvent[]> {
  const run = await repos.runs.latest(ticketId)
  return run ? (await repos.runs.events(run.id)).map((e) => e.event) : []
}

async function startedInvestigation(script: FakeStep[] = keepAlive) {
  const runtime = new FakeRuntime(script)
  const runner = makeRunner(runtime)
  await runner.start(investigation.id)
  return { runtime, runner, spec: runtime.specs[0]! }
}

describe('Investigate tickets', () => {
  it("run their kind's lineup: a read-only Investigator that is told to submit a report and never commit", async () => {
    const change = new FakeRuntime(keepAlive)
    await makeRunner(change).start(changeTicket.id)
    expect(change.specs[0]).toMatchObject({ role: 'Implementer', toolProfile: 'edit', endsWithReport: false })
    expect(change.specs[0]!.appendSystemPrompt).toContain('mcp__mainbus__handoff')
    expect(change.specs[0]!.appendSystemPrompt).not.toContain('Investigate ticket')

    const { spec } = await startedInvestigation()
    expect(spec).toMatchObject({ role: 'Investigator', toolProfile: 'read_only', endsWithReport: true })
    expect(spec.appendSystemPrompt).toContain('## Your role: Investigator\n')
    expect(spec.appendSystemPrompt).toContain('mcp__mainbus__submit_report(markdown)')
    expect(spec.appendSystemPrompt).not.toContain('mcp__mainbus__handoff')
    expect(spec.appendSystemPrompt).toContain('never commit')
  })

  it('submit_report saves the report, records it and puts the ticket in Review without pushing or opening a PR', async () => {
    const { runner, spec } = await startedInvestigation()
    expect(await spec.roleTools.submitReport({ markdown: REPORT })).toMatch(/^Report submitted/)

    expect((await repos.tickets.get(investigation.id)).report).toBe(REPORT)
    expect((await thread(investigation.id)).at(-1)).toEqual({ kind: 'report', markdown: REPORT })
    expect(await runner.stateOf(investigation.id)).toMatchObject({ column: 'review', phase: 'ready_for_review' })
    expect((await repos.runs.latest(investigation.id))!.endReason).toBe('handoff')
    await new Promise((r) => setTimeout(r, 100))
    expect(publish).not.toHaveBeenCalled()
    await expect(runner.openPr(investigation.id)).rejects.toThrow(/never push or open a pull request/)
    expect(publish).not.toHaveBeenCalled()
  })

  it('refuses an empty report, and the run stays open', async () => {
    const { spec } = await startedInvestigation()
    expect(await spec.roleTools.submitReport({ markdown: '  \n ' })).toMatch(/^Not submitted: the report is empty/)
    expect((await repos.runs.latest(investigation.id))!.endReason).toBeNull()
    expect((await repos.tickets.get(investigation.id)).report).toBeNull()
  })

  it('refuses submit_report on a Change ticket', async () => {
    const runtime = new FakeRuntime(keepAlive)
    await makeRunner(runtime).start(changeTicket.id)
    expect(await runtime.specs[0]!.roleTools.submitReport({ markdown: REPORT })).toMatch(/only for Investigate tickets/)
    expect((await repos.runs.latest(changeTicket.id))!.endReason).toBeNull()
    expect((await repos.tickets.get(changeTicket.id)).report).toBeNull()
  })

  it('refuses handoff from the last role, with the run left open', async () => {
    const { spec } = await startedInvestigation()
    expect(await spec.roleTools.handoff({ summary: 's', notesForNext: '' })).toMatch(/ends with a report.*submit_report/)
    expect((await repos.runs.latest(investigation.id))!.endReason).toBeNull()
  })

  it('needs no commit: a dirty worktree blocks neither submit_report nor a handoff to the next role', async () => {
    const [investigator] = defaultInvestigateLineup()
    await repos.lineups.save(
      workspaceId,
      [
        { ...investigator!, id: 'first', name: 'Scout' },
        { ...investigator!, id: 'second', name: 'Writer' }
      ],
      'investigate'
    )
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await runner.start(investigation.id)
    const scout = runtime.specs[0]!
    expect(scout).toMatchObject({ role: 'Scout', endsWithReport: false })
    expect(scout.appendSystemPrompt).toContain('mcp__mainbus__handoff')
    expect(scout.appendSystemPrompt).not.toContain('Commit all work')
    expect(await scout.roleTools.submitReport({ markdown: REPORT })).toMatch(/only the last role/)

    await fs.writeFile(path.join(scout.cwd, 'scratch.txt'), 'uncommitted\n')
    expect(await scout.roleTools.handoff({ summary: 'looked', notesForNext: '' })).toMatch(/^Handed off/)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(2))
    const writer = runtime.specs[1]!
    expect(writer).toMatchObject({ role: 'Writer', endsWithReport: true })
    await vi.waitFor(async () => expect((await runner.stateOf(investigation.id)).agentStatus).toBe('working'))
    expect(await writer.roleTools.submitReport({ markdown: REPORT })).toMatch(/^Report submitted/)
    expect(await runner.stateOf(investigation.id)).toMatchObject({ column: 'review', phase: 'ready_for_review' })
    expect(publish).not.toHaveBeenCalled()
  })

  it('nudges the last role to submit its report, not to commit', async () => {
    await startedInvestigation([{ emit: { kind: 'turn_end', ok: true } }, ...keepAlive])
    await vi.waitFor(async () => {
      const nudge = (await thread(investigation.id)).find((e) => e.kind === 'nudge')
      expect(nudge).toMatchObject({ text: expect.stringContaining('mcp__mainbus__submit_report') })
      expect(nudge).toMatchObject({ text: expect.not.stringContaining('commit') })
    })
  })
})

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runCommand } from '../git/command'
import { runGit } from '../git/git'
import type { PublishInput } from '../git/pullRequests'
import { ReportFileSaver, reportDate } from '../git/reportFiles'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome } from '../home'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { createRepos, type Repos } from '../store'
import { defaultInvestigateLineup } from '../store/lineups'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { TicketRunner, type RunnerDeps } from './ticketRunner'

// The report's tests commit in a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

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
let clock: Date

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
  // The repo's own identity: the one the report's commit is made with.
  await git(['config', 'user.name', 'Report Author'])
  await git(['config', 'user.email', 'author@example.com'])
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
  clock = FIXED_NOW
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

function makeRunner(runtime: FakeRuntime, reportFiles: RunnerDeps['reportFiles'] = new ReportFileSaver(runCommand)): TicketRunner {
  const runner = new TicketRunner({
    repos,
    worktrees,
    runtime,
    now: () => clock,
    emit: () => {},
    unattended: () => false,
    pullRequests: { publish: publish as never },
    ...(reportFiles ? { reportFiles } : {})
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

  it('submit_report saves the report, records it and puts the ticket in Review; with PRs off nothing is pushed', async () => {
    const { runner, spec } = await startedInvestigation()
    expect(await spec.roleTools.submitReport({ markdown: REPORT })).toMatch(/^Report submitted/)

    expect((await repos.tickets.get(investigation.id)).report).toBe(REPORT)
    expect((await thread(investigation.id)).find((e) => e.kind === 'report')).toEqual({ kind: 'report', markdown: REPORT })
    expect(await runner.stateOf(investigation.id)).toMatchObject({ column: 'review', phase: 'ready_for_review' })
    expect((await repos.runs.latest(investigation.id))!.endReason).toBe('handoff')
    await vi.waitFor(async () => expect((await repos.tickets.get(investigation.id)).reportCommit).not.toBeNull(), { timeout: 15_000 })
    await new Promise((r) => setTimeout(r, 100))
    expect(publish).not.toHaveBeenCalled()
    await expect(runner.openPr(investigation.id)).rejects.toThrow(/Open a PR when a ticket reaches Review/)
    expect(publish).not.toHaveBeenCalled()
  })

  describe('the report as a file in the repo', () => {
    const date = reportDate(FIXED_NOW)
    const file = `docs/investigations/${date}-2-why-is-login-slow.md`

    async function saved(): Promise<Ticket> {
      await vi.waitFor(async () => {
        const t = await repos.tickets.get(investigation.id)
        expect(t.reportCommit ?? t.reportFileError).not.toBeNull()
      }, { timeout: 15_000 })
      return repos.tickets.get(investigation.id)
    }

    async function submitted(markdown = REPORT, reportFiles?: RunnerDeps['reportFiles'], before?: (cwd: string) => Promise<void>) {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime, reportFiles)
      await runner.start(investigation.id)
      const spec = runtime.specs.at(-1)!
      await before?.(spec.cwd)
      expect(await spec.roleTools.submitReport({ markdown })).toMatch(/^Report submitted/)
      return { runtime, runner, spec, ticket: await saved() }
    }

    it('is written with a header and the exact report, and committed alone on the branch as "Investigation #<n>: <title>"', async () => {
      await repos.tickets.appendIntent(investigation.id, 'And check the cache too')
      // An untracked file in the folder is left alone, not swept into the report's commit.
      const { spec, ticket } = await submitted(REPORT, undefined, (cwd) => fs.writeFile(path.join(cwd, 'stray.txt'), 'not mine\n'))
      expect(ticket).toMatchObject({ reportFile: file, reportCommit: expect.stringMatching(/^[0-9a-f]{40}$/), reportFileError: null })
      // The agent never wrote it: it stayed read-only.
      expect(spec.toolProfile).toBe('read_only')
      expect((await git(['status', '--porcelain'], spec.cwd)).trim()).toBe('?? stray.txt')

      const written = await fs.readFile(path.join(spec.cwd, ...file.split('/')), 'utf8')
      expect(written).toBe(
        [
          '> **Investigation #2:** Why is login slow',
          `> **Date:** ${date} · **Status:** report, recommends but doesn't authorise changes`,
          "> **The question (the user's words):** Look into it",
          '> ',
          '> And check the cache too',
          '',
          REPORT,
          ''
        ].join('\n')
      )
      const branch = ticket.branch!
      expect(await git(['log', '-1', '--format=%H%n%s%n%an <%ae>', branch])).toBe(
        `${ticket.reportCommit}\nInvestigation #2: Why is login slow\nReport Author <author@example.com>\n`
      )
      expect((await git(['show', '--name-only', '--format=', branch])).trim()).toBe(file)
      expect(await git(['show', `${branch}:${file}`])).toBe(written)
      // Committed on the ticket's branch only.
      expect((await git(['log', '--format=%s', 'main'])).trim()).toBe('initial')

      const events = await thread(investigation.id)
      const at = events.findIndex((e) => e.kind === 'report')
      expect(events.slice(at)).toEqual([
        { kind: 'report', markdown: REPORT },
        { kind: 'report_file', path: file, commit: ticket.reportCommit, branch }
      ])
    })

    it('tells the Investigator where it is saved and that it is public if the repo is, and the agent stays read-only', async () => {
      const { spec } = await startedInvestigation()
      expect(spec.toolProfile).toBe('read_only')
      expect(spec.appendSystemPrompt).toContain('saves your report as a markdown file in the repository, at docs/investigations/')
      expect(spec.appendSystemPrompt).toContain('Write it to stand alone')
      expect(spec.appendSystemPrompt).toContain('if the repository is public, so is the report')
      expect(spec.appendSystemPrompt).toContain('never commit')
    })

    it('is not mentioned to the Investigator with the setting off', async () => {
      await repos.workspaces.setReportSettings(workspaceId, { saveReports: false })
      const { spec } = await startedInvestigation()
      expect(spec.appendSystemPrompt).not.toContain('saves your report as a markdown file')
    })

    it('is not saved with the setting off', async () => {
      await repos.workspaces.setReportSettings(workspaceId, { saveReports: false })
      const { runner, spec } = await startedInvestigation()
      expect(await spec.roleTools.submitReport({ markdown: REPORT })).toMatch(/^Report submitted/)
      await new Promise((r) => setTimeout(r, 200))
      expect(await repos.tickets.get(investigation.id)).toMatchObject({ report: REPORT, reportFile: null, reportCommit: null, reportFileError: null })
      await expect(fs.stat(path.join(spec.cwd, 'docs'))).rejects.toThrow()
      expect((await git(['log', '--format=%s', (await repos.tickets.get(investigation.id)).branch!])).trim()).toBe('initial')
      await expect(runner.saveReport(investigation.id)).rejects.toThrow(/Save investigation reports in the repo/)
    })

    it('goes in a custom folder', async () => {
      await repos.workspaces.setReportSettings(workspaceId, { reportsFolder: 'notes\\research' })
      const { spec, ticket } = await submitted()
      expect(ticket.reportFile).toBe(`notes/research/${date}-2-why-is-login-slow.md`)
      await expect(fs.readFile(path.join(spec.cwd, 'notes', 'research', `${date}-2-why-is-login-slow.md`), 'utf8')).resolves.toContain(REPORT)
    })

    it('refuses a folder outside the repo, and the saver refuses a path that leaves it', async () => {
      await expect(repos.workspaces.setReportSettings(workspaceId, { reportsFolder: '../outside' })).rejects.toThrow(/stay inside the repository/)
      expect((await repos.workspaces.get(workspaceId))!.reportsFolder).toBe('docs/investigations')
      const saver = new ReportFileSaver(runCommand)
      const result = await saver.save({ worktreePath: repoPath, relPath: '../outside.md', content: 'x', message: 'm' })
      expect(result).toEqual({ ok: false, reason: '../outside.md is outside the repository' })
      await expect(fs.stat(path.join(tmp, 'outside.md'))).rejects.toThrow()
    })

    it('a resubmitted report (Start again) overwrites the same file in a new commit', async () => {
      const first = await submitted('# First\n')
      // Start again, another day: the file keeps its name.
      clock = new Date(FIXED_NOW.getTime() + 3 * 86_400_000)
      await first.runner.start(investigation.id)
      await vi.waitFor(() => expect(first.runtime.specs).toHaveLength(2))
      const spec = first.runtime.specs[1]!
      expect(await spec.roleTools.submitReport({ markdown: '# Second\n' })).toMatch(/^Report submitted/)
      await vi.waitFor(async () => expect((await repos.tickets.get(investigation.id)).reportCommit).not.toBe(first.ticket.reportCommit), {
        timeout: 15_000
      })

      const ticket = await repos.tickets.get(investigation.id)
      expect(ticket.reportFile).toBe(file)
      expect(await fs.readdir(path.join(spec.cwd, 'docs', 'investigations'))).toEqual([`${date}-2-why-is-login-slow.md`])
      const log = (await git(['log', '--format=%H %s', ticket.branch!])).trim().split('\n')
      expect(log).toEqual([
        `${ticket.reportCommit} Investigation #2: Why is login slow`,
        `${first.ticket.reportCommit} Investigation #2: Why is login slow`,
        expect.stringMatching(/ initial$/)
      ])
      expect(await git(['show', `${ticket.branch}:${file}`])).toMatch(/\n\n# Second\n$/)
    })

    it('a write or commit failure keeps the report, shows a notice, and "Save report to repo" retries it', async () => {
      const real = new ReportFileSaver(runCommand)
      const save = vi.fn(real.save.bind(real)).mockResolvedValueOnce({ ok: false, reason: 'the file could not be written: ENOSPC: no space left on device' })
      await repos.workspaces.setOpenPrOnReview(workspaceId, true)
      const { runner, ticket } = await submitted(REPORT, { save })

      expect(ticket).toMatchObject({
        report: REPORT,
        reportFile: file,
        reportCommit: null,
        reportFileError: 'the file could not be written: ENOSPC: no space left on device'
      })
      expect(await runner.stateOf(investigation.id)).toMatchObject({ column: 'review' })
      expect((await thread(investigation.id)).at(-1)).toEqual({
        kind: 'notice',
        text: "Couldn't save the report to the repo: the file could not be written: ENOSPC: no space left on device"
      })
      // Nothing to push until the report is in a commit.
      expect(publish).not.toHaveBeenCalled()
      await expect(runner.openPr(investigation.id)).rejects.toThrow(/isn't saved in the repo yet/)

      await runner.saveReport(investigation.id)
      expect(await repos.tickets.get(investigation.id)).toMatchObject({ reportFile: file, reportCommit: expect.stringMatching(/^[0-9a-f]{40}$/), reportFileError: null })
      expect((await thread(investigation.id)).some((e) => e.kind === 'report_file')).toBe(true)
      // Saved, it is pushed as after a first-time save.
      expect(publish).toHaveBeenCalledTimes(1)
    })

    it('a real git failure (a commit hook that refuses) is the reason shown', async () => {
      const hooks = path.join(tmp, 'hooks')
      await fs.mkdir(hooks)
      await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "refused by the hook" >&2\nexit 1\n', { mode: 0o755 })
      await git(['config', 'core.hooksPath', hooks.replace(/\\/g, '/')])
      const { ticket } = await submitted()
      expect(ticket.reportCommit).toBeNull()
      expect(ticket.reportFileError).toMatch(/^git commit failed: .*refused by the hook/)
      expect(ticket.report).toBe(REPORT)
    })

    // With PRs off nothing is pushed: see the first test.
    it('with PRs on, pushes the branch and opens a PR once the report is committed', async () => {
      await repos.workspaces.setOpenPrOnReview(workspaceId, true)
      const { ticket } = await submitted()
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1), { timeout: 15_000 })
      const input = publish.mock.calls[0]![0] as PublishInput
      expect(input.ticket).toMatchObject({ id: investigation.id, kind: 'investigate', branch: ticket.branch, reportFile: file, reportCommit: ticket.reportCommit })
      expect(input.baseBranch).toBe('main')
    })
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

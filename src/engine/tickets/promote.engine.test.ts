import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, FAKE_SUMMARY, scriptFromFile, type FakeStep, type FakeSummary } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

const REPORT = '# Findings\n\nThe cause is **X**.'
const INVESTIGATOR: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'investigator' } },
  { callTool: 'submitReport', args: { markdown: REPORT } },
  { emit: { kind: 'turn_end', ok: true } }
]
const ORCHESTRATOR: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }]
/** The spec's line naming the investigation's report file in the repo. */
const fileLine = (t: { reportFile: string | null; branch: string | null }) =>
  `\n\nThe investigation's report is saved in the repo as \`${t.reportFile}\` on the branch \`${t.branch}\`.`

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-promote-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const USAGE = { kind: 'usage', inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, models: {}, durationMs: 40 } as const

async function setup(summary?: FakeSummary, promoteSummaryTimeoutMs?: number, orchestrator: FakeStep[] = ORCHESTRATOR) {
  const runtime = new FakeRuntime(scriptFromFile({ Investigator: INVESTIGATOR }), {
    orchestrator,
    summaryUsage: USAGE,
    ...(summary !== undefined ? { summary } : {})
  })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, ...(promoteSummaryTimeoutMs !== undefined ? { promoteSummaryTimeoutMs } : {}) })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  const board = async () => (await engine.invoke('board.get')).tickets
  const find = async (id: string) => (await board()).find((t) => t.id === id)!
  const investigate = async (title = 'Why is login slow') => {
    const t = await engine.invoke('ticket.create', { title, intent: 'Find out why login is slow', spec: '', criteria: [], labels: ['perf'], column: 'ready', kind: 'investigate' })
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect((await find(t.id)).state.column).toBe('review'))
    // Mainbus commits the report's file just after.
    await vi.waitFor(async () => expect((await find(t.id)).reportCommit).not.toBeNull(), { timeout: 15_000 })
    return find(t.id)
  }
  await engine.invoke('orchestrator.send', 'Look at the investigation')
  await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  const tools = runtime.orchestratorSpecs[0]!.tools
  const proposals = async () => (await engine.invoke('orchestrator.get')).proposals
  return { engine, runtime, board, find, investigate, tools, proposals }
}

describe('ticket.draftPromotion', () => {
  test('drafts the spec from the report through the summary call, and starts from the ticket title', async () => {
    const s = await setup()
    const t = await s.investigate()
    expect(await s.engine.invoke('ticket.draftPromotion', t.id)).toEqual({ title: 'Why is login slow', spec: FAKE_SUMMARY + fileLine(t), drafted: true })
    expect(s.runtime.summaries).toHaveLength(1)
    expect(s.runtime.summaries[0]!.prompt).toContain(REPORT)
    expect(s.runtime.summaries[0]!.cwd.startsWith(paths.scratch)).toBe(true)
  })

  test.each<[string, FakeSummary, number | undefined]>([
    ['fails', { fail: 'boom' }, undefined],
    ['hangs', { hang: true }, 50],
    ['is empty', '  ', undefined]
  ])('falls back to the report when the call %s', async (_name, summary, timeout) => {
    const s = await setup(summary, timeout)
    const t = await s.investigate()
    expect(await s.engine.invoke('ticket.draftPromotion', t.id)).toEqual({
      title: 'Why is login slow',
      spec: `## From the investigation\n\n${REPORT}${fileLine(t)}`,
      drafted: false
    })
  })
})

describe('usage', () => {
  test("the promote draft's usage is recorded on the ticket's latest run, as a Mainbus call", async () => {
    const s = await setup()
    const t = await s.investigate()
    await s.engine.invoke('ticket.draftPromotion', t.id)
    await vi.waitFor(async () => {
      const { events } = await s.engine.invoke('thread.get', t.id)
      expect(events.filter((e) => e.event.kind === 'usage' && e.event.call === 'promote')).toHaveLength(1)
    })
  })

  test("orchestrator.usage adds up the orchestrator's turns, and is null before any", async () => {
    const s = await setup(undefined, undefined, [{ emit: { kind: 'session', sessionId: 's' } }, { emit: USAGE }, { emit: { kind: 'turn_end', ok: true } }, { waitForSend: true }])
    await vi.waitFor(async () => expect(await s.engine.invoke('orchestrator.usage')).toMatchObject({ inputTokens: 7, turns: 1 }))
  })
})

describe('ticket.promote', () => {
  test('creates a Change ticket in Ready with the same intent and the report, and moves the original to Done', async () => {
    const s = await setup()
    const t = await s.investigate()
    const created = await s.engine.invoke('ticket.promote', t.id, { title: 'Speed up login', spec: 'Cache the lookup.' })

    expect(t.reportFile).toMatch(/^docs\/investigations\/\d{4}-\d{2}-\d{2}-1-why-is-login-slow\.md$/)
    expect(created).toMatchObject({
      kind: 'change',
      title: 'Speed up login',
      spec: `Cache the lookup.${fileLine(t)}`,
      report: REPORT,
      promotedFrom: t.id,
      manualColumn: 'ready',
      labels: ['perf']
    })
    expect(created.intent).toEqual(t.intent)
    const after = await s.board()
    const newOne = after.find((x) => x.id === created.id)!
    expect(newOne.state.column).toBe('ready')
    const original = after.find((x) => x.id === t.id)!
    expect(original.state.column).toBe('done')
    expect(original.worktreePath).toBeNull()
    expect(original.report).toBe(REPORT)
    expect(original.promotedFrom).toBeNull()
  })

  test('refuses a Change ticket, a ticket without a report, one in Backlog, and a second promotion', async () => {
    const s = await setup()
    const change = await s.engine.invoke('ticket.create', { title: 'C', intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' })
    const fields = { title: 'T', spec: 'S' }
    await expect(s.engine.invoke('ticket.promote', change.id, fields)).rejects.toThrow(/Change ticket; only an Investigate/)
    await expect(s.engine.invoke('ticket.draftPromotion', change.id)).rejects.toThrow(/Change ticket/)

    const backlog = await s.engine.invoke('ticket.create', { title: 'B', intent: 'x', spec: '', criteria: [], labels: [], column: 'backlog', kind: 'investigate' })
    await expect(s.engine.invoke('ticket.promote', backlog.id, fields)).rejects.toThrow(/has no report yet/)

    const t = await s.investigate()
    await expect(s.engine.invoke('ticket.promote', t.id, { title: '  ', spec: 'S' })).rejects.toThrow()
    const first = await s.engine.invoke('ticket.promote', t.id, fields)
    await expect(s.engine.invoke('ticket.promote', t.id, fields)).rejects.toThrow(`was already promoted to #${first.number}`)
    expect((await s.board()).filter((x) => x.promotedFrom === t.id)).toHaveLength(1)
  })

  test('works from Done, and not twice at once', async () => {
    const s = await setup()
    const t = await s.investigate()
    await s.engine.invoke('ticket.move', t.id, 'done')
    const both = await Promise.allSettled([
      s.engine.invoke('ticket.promote', t.id, { title: 'A', spec: '' }),
      s.engine.invoke('ticket.promote', t.id, { title: 'B', spec: '' })
    ])
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await s.board()).filter((x) => x.promotedFrom === t.id)).toHaveLength(1)
  })

  test('refuses an investigation whose folder has uncommitted changes, creating nothing', async () => {
    const s = await setup()
    const t = await s.investigate()
    await fs.writeFile(path.join(t.worktreePath!, 'scratch.txt'), 'unsaved')
    await expect(s.engine.invoke('ticket.promote', t.id, { title: 'T', spec: 'S' })).rejects.toThrow(/uncommitted changes.*nothing was promoted/)
    const after = await s.board()
    expect(after).toHaveLength(1)
    expect(after[0]!.state.column).toBe('review')
    await expect(fs.stat(path.join(t.worktreePath!, 'scratch.txt'))).resolves.toBeDefined()
  })
})

describe('propose_promote', () => {
  test('drafts the spec when none is given; confirming promotes like the button', async () => {
    const s = await setup()
    const t = await s.investigate()
    expect(await s.tools.proposePromote({ ticket: t.number })).toMatch(/Proposed/)
    const [p] = await s.proposals()
    const spec = FAKE_SUMMARY + fileLine(t)
    expect(p).toMatchObject({ kind: 'promote', status: 'pending', payload: { ticketId: t.id, title: 'Why is login slow', spec, specSource: 'summary' } })

    const done = await s.engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'confirmed' })
    const created = (await s.board()).find((x) => x.promotedFrom === t.id)!
    // Named once, not twice: the drafted spec already has it.
    expect(created).toMatchObject({ kind: 'change', title: 'Why is login slow', spec, report: REPORT })
    expect(created.state.column).toBe('ready')
    expect((await s.find(t.id)).state.column).toBe('done')
    expect(done.result).toMatchObject({ ticketId: created.id, number: created.number, fromTicketId: t.id, fromNumber: t.number })
  })

  test('keeps a spec it is given, and the user can override the title and spec', async () => {
    const s = await setup()
    const t = await s.investigate()
    await s.tools.proposePromote({ ticket: t.number, title: 'Speed up login', spec: 'Cache the lookup.' })
    const [p] = await s.proposals()
    expect(p!.payload).toMatchObject({ title: 'Speed up login', spec: 'Cache the lookup.', specSource: 'orchestrator' })
    expect(s.runtime.summaries).toHaveLength(0)
    await s.engine.invoke('proposal.confirm', p!.id, { title: 'Cache logins', spec: 'Edited spec.' })
    // Whatever spec is confirmed names the report's file.
    expect((await s.board()).find((x) => x.promotedFrom === t.id)).toMatchObject({ title: 'Cache logins', spec: `Edited spec.${fileLine(t)}` })
  })

  test('falls back to the report when the summary fails', async () => {
    const s = await setup({ fail: 'boom' })
    const t = await s.investigate()
    await s.tools.proposePromote({ ticket: t.number })
    const [p] = await s.proposals()
    expect(p!.payload).toMatchObject({ spec: `## From the investigation\n\n${REPORT}${fileLine(t)}`, specSource: 'report' })
  })

  test('is refused for a Change ticket, one without a report and an unknown ticket', async () => {
    const s = await setup()
    const change = await s.engine.invoke('ticket.create', { title: 'C', intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' })
    const backlog = await s.engine.invoke('ticket.create', { title: 'B', intent: 'x', spec: '', criteria: [], labels: [], column: 'backlog', kind: 'investigate' })
    expect(await s.tools.proposePromote({ ticket: change.number })).toMatch(/^Invalid proposal: .*Change ticket; only an Investigate/)
    expect(await s.tools.proposePromote({ ticket: backlog.number })).toMatch(/^Invalid proposal: .*has no report yet/)
    expect(await s.tools.proposePromote({ ticket: 99 })).toMatch(/^Invalid proposal: ticket: there is no ticket #99/)
    expect(await s.proposals()).toEqual([])
  })

  test('a duplicate pending proposal is the existing one, and a second confirm after a button promote fails cleanly', async () => {
    const s = await setup()
    const t = await s.investigate()
    await s.tools.proposePromote({ ticket: t.number })
    await s.tools.proposePromote({ ticket: t.number })
    const all = await s.proposals()
    expect(all).toHaveLength(1)

    await s.engine.invoke('ticket.promote', t.id, { title: 'By button', spec: 'S' })
    const failed = await s.engine.invoke('proposal.confirm', all[0]!.id)
    expect(failed).toMatchObject({ status: 'failed' })
    expect((await s.board()).filter((x) => x.promotedFrom === t.id)).toHaveLength(1)
  })
})

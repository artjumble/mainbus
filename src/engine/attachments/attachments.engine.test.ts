import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TICKET } from '../../shared/attachments'
import { runGit } from '../git/git'
import { attachmentFoldersFor, resolveHome, scratchPathFor, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { ATTACHMENTS_HEADING } from '../roles/prompt'
import { FakeRuntime, scriptFromFile, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { eventually } from '../testWait'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

/** An image's leading bytes and a little more: enough for the type check, and different each time `n` is. */
function png(n = 0): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n])
}
const text = (s: string) => new TextEncoder().encode(s)

/** The path a role's prompt gives for the attachment named `name`. */
const pathInPrompt = (name: string) => `field="attachment">${name.replace('.', '\\.')}</ticket-data>: ([^\\n]+)`

// Reads the image its prompt lists, waits for a message, reads the image that message names, and hands off.
const IMPLEMENTER: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'impl' } },
  { readFile: { fromPrompt: pathInPrompt('shot.png') } },
  { waitForSend: true },
  { readFile: { fromMessage: 'The user attached [^:]+: (.+)$' } },
  { callTool: 'handoff', args: { summary: 'Looked at both', notesForNext: '' } },
  { emit: { kind: 'turn_end', ok: true } }
]
const INVESTIGATOR: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'inv' } },
  { callTool: 'submitReport', args: { markdown: '# Found it' } },
  { emit: { kind: 'turn_end', ok: true } }
]
const ORCHESTRATOR: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'orch' } }, { waitForSend: true }]

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-attach-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function setup() {
  const runtime = new FakeRuntime(scriptFromFile({ Implementer: IMPLEMENTER, Investigator: INVESTIGATOR }), { orchestrator: ORCHESTRATOR })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  const ws = await engine.invoke('workspace.open', repoPath)
  // Only the Implementer, so the ticket goes to Review when it hands off.
  const implementer = (await engine.invoke('lineup.get')).find((r) => r.name === 'Implementer')!
  const { workspaceId: _w, lineup: _l, position: _p, ...input } = implementer
  await engine.invoke('lineup.save', [{ ...input, handBackTo: null }])
  const create = (title = 'Fix the login page', column: 'backlog' | 'ready' = 'ready') =>
    engine.invoke('ticket.create', { title, intent: 'Look at the screenshot', spec: '', criteria: [], labels: [], column })
  const ticket = async (id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!
  return { engine, runtime, ws, create, ticket }
}

describe('add, list and remove', () => {
  test("stores the file in Mainbus's data folder, never in the repo, and shows it on the board and as a data URL", async () => {
    const { engine, ws, create, ticket } = await setup()
    const t = await create()
    const added = await engine.invoke('attachment.add', t.id, 'shot.png', png())
    expect(added).toMatchObject({ ticketId: t.id, filename: 'shot.png', mime: 'image/png', size: 13 })
    expect(added).not.toHaveProperty('path')
    expect(added.sha256).toMatch(/^[0-9a-f]{64}$/)

    const file = path.join(attachmentFoldersFor(paths, ws.slug), String(t.number), `${added.id}-shot.png`)
    expect(await fs.readFile(file)).toEqual(Buffer.from(png()))
    expect(file.startsWith(paths.attachments)).toBe(true)
    expect((await runGit(['status', '--porcelain'], repoPath)).stdout).toBe('')

    expect(await engine.invoke('attachment.list', t.id)).toEqual([added])
    expect((await ticket(t.id)).attachments).toEqual([added])
    expect(await engine.invoke('attachment.data', added.id)).toBe(`data:image/png;base64,${Buffer.from(png()).toString('base64')}`)

    // Two of the same name stay apart.
    const again = await engine.invoke('attachment.add', t.id, 'SHOT.png', png(1))
    expect(again.filename).toBe('SHOT-2.png')

    await engine.invoke('attachment.remove', added.id)
    expect(existsSync(file)).toBe(false)
    expect((await engine.invoke('attachment.list', t.id)).map((a) => a.filename)).toEqual(['SHOT-2.png'])
    await expect(engine.invoke('attachment.data', added.id)).rejects.toThrow(/Unknown attachment/)
    // Removing it again is nothing.
    await engine.invoke('attachment.remove', added.id)
  })

  test('refuses SVG, a renamed non-image, more than 10 MB and a 21st image, each with a plain reason', async () => {
    const { engine, create } = await setup()
    const t = await create()
    await expect(engine.invoke('attachment.add', t.id, 'logo.svg', text('<svg><script>alert(1)</script></svg>'))).rejects.toThrow(/can carry script/)
    await expect(engine.invoke('attachment.add', t.id, 'notes.png', text('not an image'))).rejects.toThrow('notes.png is not a PNG, JPEG, GIF or WebP image.')
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1)
    big.set(png())
    await expect(engine.invoke('attachment.add', t.id, 'big.png', big)).rejects.toThrow(/at most 10 MB/)
    await expect(engine.invoke('attachment.add', t.id, 'x.png', 'not bytes' as unknown as Uint8Array)).rejects.toThrow(/bytes of an image/)
    expect(await engine.invoke('attachment.list', t.id)).toEqual([])

    // Added at once, the 21st is still refused.
    const all = await Promise.allSettled(
      Array.from({ length: ATTACHMENTS_PER_TICKET + 1 }, (_, i) => engine.invoke('attachment.add', t.id, `s${i}.png`, png(i)))
    )
    expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(ATTACHMENTS_PER_TICKET)
    const refused = all.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refused.reason)).toMatch(/at most 20 attachments/)
  })

  test('the New ticket dialog saves its images with the ticket, and a refused one creates nothing', async () => {
    const { engine, ticket } = await setup()
    const base = { title: 'With images', intent: 'See the pictures', spec: '', criteria: [], labels: [], column: 'backlog' as const }
    await expect(
      engine.invoke('ticket.create', { ...base, attachments: [{ name: 'ok.png', bytes: png() }, { name: 'bad.svg', bytes: text('<svg/>') }] })
    ).rejects.toThrow(/can carry script/)
    expect((await engine.invoke('board.get')).tickets).toEqual([])

    const t = await engine.invoke('ticket.create', { ...base, attachments: [{ name: 'a.png', bytes: png(1) }, { name: 'b.png', bytes: png(2) }] })
    expect((await ticket(t.id)).attachments.map((a) => a.filename)).toEqual(['a.png', 'b.png'])
    expect((await ticket(t.id)).intent[0]!.text).toBe('See the pictures')
  })
})

describe('agents', () => {
  test('a role finds the images in its scratch folder and prompt, reads them without a card, and hears of one added mid-run', async () => {
    const { engine, runtime, create, ticket } = await setup()
    const t = await create()
    await engine.invoke('attachment.add', t.id, 'shot.png', png())
    await engine.invoke('agent.start', t.id)
    await runtime.started(1)
    expect(runtime.specs).toHaveLength(1)

    const spec = runtime.specs[0]!
    const copy = path.join(spec.tempDir, 'attachments', 'shot.png')
    expect(spec.tempDir).toBe(scratchPathFor(paths, (await ticket(t.id)).worktreePath!))
    expect(spec.additionalDirectories).toContain(spec.tempDir)
    expect(await fs.readFile(copy)).toEqual(Buffer.from(png()))
    expect(spec.appendSystemPrompt).toContain(ATTACHMENTS_HEADING)
    expect(spec.appendSystemPrompt).toContain(`<ticket-data field="attachment">shot.png</ticket-data>: ${copy}`)
    expect(spec.appendSystemPrompt).toMatch(/Open them with the Read tool/)

    // The scripted agent read it from the path in its prompt, with no permission card.
    const reads = async () => (await engine.invoke('thread.get', t.id)).events.filter((e) => e.event.kind === 'tool_result')
    await eventually(async () => expect(await reads()).toHaveLength(1))
    expect((await reads())[0]!.event).toMatchObject({ ok: true })

    // An image added mid-run is copied over and announced through the agent's input queue, not by interrupting it.
    await engine.invoke('attachment.add', t.id, 'second.png', png(2))
    const second = path.join(spec.tempDir, 'attachments', 'second.png')
    await eventually(() => expect(runtime.sent).toContain(`The user attached second.png: ${second}`))
    expect(await fs.readFile(second)).toEqual(Buffer.from(png(2)))
    expect(runtime.interrupted).toEqual([])
    await eventually(async () => expect((await ticket(t.id)).state.column).toBe('review'))
    const thread = await engine.invoke('thread.get', t.id)
    expect(thread.decisions).toEqual([])
    expect(thread.events.filter((e) => e.event.kind === 'tool_result').map((e) => e.event)).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true })
    ])
    expect(thread.events.some((e) => e.event.kind === 'notice' && e.event.text === `The user attached second.png: ${second}`)).toBe(true)

    // A removal is announced too (here no agent is live, so only the copy goes), and kept at Done.
    const [first] = await engine.invoke('attachment.list', t.id)
    await engine.invoke('attachment.remove', first!.id)
    expect(existsSync(copy)).toBe(false)
    expect(await engine.invoke('ticket.move', t.id, 'done')).toBe('moved')
    expect((await ticket(t.id)).worktreePath).toBeNull()
    const kept = await engine.invoke('attachment.list', t.id)
    expect(kept.map((a) => a.filename)).toEqual(['second.png'])
    expect(await engine.invoke('attachment.data', kept[0]!.id)).toMatch(/^data:image\/png;base64,/)
  })

  test('a removal while the agent works is announced the same way', async () => {
    const { engine, runtime, create } = await setup()
    const t = await create()
    const a = await engine.invoke('attachment.add', t.id, 'shot.png', png())
    await engine.invoke('agent.start', t.id)
    await eventually(async () => expect((await engine.invoke('thread.get', t.id)).events.some((e) => e.event.kind === 'tool_result')).toBe(true))
    await engine.invoke('attachment.remove', a.id)
    await eventually(() => expect(runtime.sent).toContain('The user removed the attachment shot.png; its copy is gone from your scratch folder.'))
    expect(existsSync(path.join(runtime.specs[0]!.tempDir, 'attachments', 'shot.png'))).toBe(false)
    expect(runtime.interrupted).toEqual([])
  })
})

describe('lifetime', () => {
  test('Promote copies them to the new Change ticket', async () => {
    const { engine, ticket } = await setup()
    const t = await engine.invoke('ticket.create', { title: 'Why', intent: 'Find out', spec: '', criteria: [], labels: [], column: 'ready', kind: 'investigate' })
    await engine.invoke('attachment.add', t.id, 'shot.png', png(7))
    await engine.invoke('agent.start', t.id)
    await eventually(async () => expect((await ticket(t.id)).state.column).toBe('review'))
    const created = await engine.invoke('ticket.promote', t.id, { title: 'Fix it', spec: 'Do it' })
    const [copy] = await engine.invoke('attachment.list', created.id)
    expect(copy).toMatchObject({ ticketId: created.id, filename: 'shot.png', size: 13 })
    expect(await engine.invoke('attachment.data', copy!.id)).toBe(`data:image/png;base64,${Buffer.from(png(7)).toString('base64')}`)
    // The original keeps its own.
    expect((await engine.invoke('attachment.list', t.id)).map((a) => a.filename)).toEqual(['shot.png'])
  })

  test('they go when the workspace is removed', async () => {
    const { engine, ws, create } = await setup()
    const t = await create('Backlog one', 'backlog')
    const a = await engine.invoke('attachment.add', t.id, 'shot.png', png())
    const folder = attachmentFoldersFor(paths, ws.slug)
    expect(existsSync(folder)).toBe(true)
    await engine.invoke('workspace.remove', ws.id)
    expect(existsSync(folder)).toBe(false)
    // Opened again, the workspace and its tickets come back, but not the images.
    await engine.invoke('workspace.open', repoPath)
    expect(await engine.invoke('attachment.list', t.id)).toEqual([])
    await expect(engine.invoke('attachment.data', a.id)).rejects.toThrow(/Unknown attachment/)
  })
})

describe('the orchestrator', () => {
  test('get_ticket lists them with their paths, and it can read them but nothing else in the data folder', async () => {
    const { engine, runtime, ws, create } = await setup()
    const t = await create()
    const a = await engine.invoke('attachment.add', t.id, 'shot.png', png())
    await engine.invoke('orchestrator.send', 'What is on #1?')
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const spec = runtime.orchestratorSpecs[0]!
    const file = path.join(attachmentFoldersFor(paths, ws.slug), String(t.number), `${a.id}-shot.png`)

    const text = await spec.tools.getTicket({ number: t.number })
    expect(text).toContain(`## Attachments\nThe user attached these images`)
    expect(text).toContain(`<ticket-data field="attachment">shot.png</ticket-data>: ${file}`)
    expect(spec.additionalDirectories).toContain(attachmentFoldersFor(paths, ws.slug))
    expect(spec.appendSystemPrompt).toContain(attachmentFoldersFor(paths, ws.slug))

    const read = (file_path: string) =>
      spec.onPermission({ toolName: 'Read', input: { file_path }, toolUseId: 'r', signal: new AbortController().signal })
    expect(await read(file)).toEqual({ allow: true })
    for (const elsewhere of [paths.db, path.join(paths.backups, 'mainbus.db'), path.join(paths.scratch, 'x', 'y', 'a.png'), path.join(paths.root, 'fake-sessions.json')]) {
      expect(await read(elsewhere)).toMatchObject({ allow: false })
    }
    // The same credential checks as anywhere it reads.
    expect(await read(path.join(attachmentFoldersFor(paths, ws.slug), '.env'))).toMatchObject({ allow: false })
  })
})

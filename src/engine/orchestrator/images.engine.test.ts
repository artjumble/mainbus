import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateTicketsPayload } from '../../shared/proposals'
import { runGit } from '../git/git'
import { attachmentFoldersFor, resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { orchestratorImagesFolder } from './images'
import { eventually } from '../testWait'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

/** An image's leading bytes and a little more: enough for the type check, and different each time `n` is. */
function png(n = 0): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n])
}
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const base64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

let tmp: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-orchestrator-images-'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function makeEngine(runtime: FakeRuntime): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', await makeRepo(path.join(tmp, `repo-${engines.length}`)))
  return engine
}

const turnEnd: FakeStep = { emit: { kind: 'turn_end', ok: true } }
/** A session that answers every message with an empty turn. */
const IDLE_TURNS: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'sess-1' } }, turnEnd, ...Array.from({ length: 4 }, () => [{ waitForSend: true }, turnEnd] as FakeStep[]).flat()]

async function idle(engine: Engine): Promise<void> {
  await eventually(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
}

async function userEvents(engine: Engine) {
  return (await engine.invoke('orchestrator.get')).events.map((e) => e.event).filter((e) => e.kind === 'user_message')
}

const imageFiles = async () => fs.readdir(orchestratorImagesFolder(paths.root)).catch(() => [] as string[])

describe('orchestrator.send with images', () => {
  test('stores the images, records them on the message, and gives them to the session as image blocks with their names and paths', async () => {
    const runtime = new FakeRuntime([], { orchestrator: IDLE_TURNS })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'This is broken', [
      { name: 'bug.png', bytes: png() },
      { name: 'C:\\Users\\me\\photo.JPG', bytes: jpeg }
    ])
    await idle(engine)

    const [message] = await userEvents(engine)
    expect(message).toEqual({
      kind: 'user_message',
      text: 'This is broken',
      images: [
        { id: expect.any(String), filename: 'bug.png' },
        // Only the last part of the name, with its type's extension in lower case.
        { id: expect.any(String), filename: 'photo.jpg' }
      ]
    })
    const [bug, photo] = message!.kind === 'user_message' ? message!.images! : []
    const bugPath = path.join(paths.root, 'orchestrator', 'images', `${bug!.id}-bug.png`)
    const photoPath = path.join(paths.root, 'orchestrator', 'images', `${photo!.id}-photo.jpg`)
    expect(await fs.readFile(bugPath)).toEqual(Buffer.from(png()))
    expect(await fs.readFile(photoPath)).toEqual(Buffer.from(jpeg))

    // Seen in this turn, without a tool call: image blocks with the prompt.
    const spec = runtime.orchestratorSpecs[0]!
    expect(spec.promptImages).toEqual([
      { mime: 'image/png', base64: base64(png()) },
      { mime: 'image/jpeg', base64: base64(jpeg) }
    ])
    // The user's words, then each image's name and full path to open again with Read.
    expect(spec.prompt).toContain('This is broken\n\n[Mainbus] The user sent these 2 images with the message')
    expect(spec.prompt).toContain(`- bug.png: ${bugPath}\n- photo.jpg: ${photoPath}`)
    // Inside its own folder, so Read needs no permission.
    expect(path.relative(spec.cwd, bugPath).startsWith('..')).toBe(false)

    expect(await engine.invoke('orchestrator.image', bug!.id)).toBe(`data:image/png;base64,${base64(png())}`)
    await expect(engine.invoke('orchestrator.image', 'nope')).rejects.toThrow('Unknown image')
  })

  test('a later message sends its images through the live session; a message can be images only', async () => {
    const runtime = new FakeRuntime([], { orchestrator: IDLE_TURNS })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Hello')
    await idle(engine)
    expect(runtime.orchestratorSpecs[0]!.promptImages).toBeUndefined()

    await engine.invoke('orchestrator.send', '', [{ name: 'pasted-image.png', bytes: png() }])
    await eventually(() => expect(runtime.sent).toHaveLength(1))
    await idle(engine)
    expect(runtime.sentImages[0]).toEqual([{ mime: 'image/png', base64: base64(png()) }])
    expect(runtime.sent[0]).toMatch(/\n\n\[Mainbus\] The user sent this image with the message.*\n- pasted-image\.png: /)
    expect((await userEvents(engine)).at(-1)).toMatchObject({ text: '', images: [{ filename: 'pasted-image.png' }] })

    // Another paste with the same name gets a name of its own, so the orchestrator can tell them apart.
    await engine.invoke('orchestrator.send', 'And this', [{ name: 'Pasted-Image.png', bytes: png(1) }])
    await idle(engine)
    expect((await userEvents(engine)).at(-1)).toMatchObject({ images: [{ filename: 'Pasted-Image-2.png' }] })
    expect(runtime.sentImages[1]).toHaveLength(1)
  })

  test('refuses what a ticket attachment would, more than 5, and an empty message, storing nothing', async () => {
    const runtime = new FakeRuntime([], { orchestrator: IDLE_TURNS })
    const engine = await makeEngine(runtime)
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    await expect(engine.invoke('orchestrator.send', 'Look', [{ name: 'logo.svg', bytes: svg }])).rejects.toThrow(
      "logo.svg is an SVG or other markup file: it can carry script, so it can't be attached."
    )
    await expect(engine.invoke('orchestrator.send', 'Look', [{ name: 'notes.png', bytes: new TextEncoder().encode('hello') }])).rejects.toThrow(
      'notes.png is not a PNG, JPEG, GIF or WebP image.'
    )
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(png())
    await expect(engine.invoke('orchestrator.send', 'Look', [{ name: 'huge.png', bytes: big }])).rejects.toThrow('huge.png is 10 MB; an attachment can be at most 10 MB.')
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}.png`, bytes: png(i) }))
    await expect(engine.invoke('orchestrator.send', 'Look', six)).rejects.toThrow('A message can have at most 5 images; remove one first.')
    await expect(engine.invoke('orchestrator.send', '  ', [])).rejects.toThrow('Type a message first')

    expect(await imageFiles()).toEqual([])
    expect(runtime.orchestratorSpecs).toHaveLength(0)
    expect(await userEvents(engine)).toEqual([])

    // Five is fine.
    await engine.invoke('orchestrator.send', 'Look', six.slice(0, 5))
    await idle(engine)
    expect(await imageFiles()).toHaveLength(5)
  })

  test('the images stay with the thread across a restart', async () => {
    const engine = await makeEngine(new FakeRuntime([], { orchestrator: IDLE_TURNS }))
    await engine.invoke('orchestrator.send', 'Keep this', [{ name: 'keep.png', bytes: png() }])
    await idle(engine)
    const [message] = await userEvents(engine)
    await engine.dispose()

    const again = await createEngine({ paths, migrationsDir, runtime: new FakeRuntime([]), git: runGit, exec })
    engines.push(again)
    const id = message!.kind === 'user_message' ? message!.images![0]!.id : ''
    expect(await userEvents(again)).toEqual([message])
    expect(await again.invoke('orchestrator.image', id)).toBe(`data:image/png;base64,${base64(png())}`)
  })

  test('after a failed resume, the digest names the earlier images with their paths, and only this message carries images', async () => {
    const first = await makeEngine(new FakeRuntime([], { orchestrator: IDLE_TURNS }))
    await first.invoke('orchestrator.send', 'The login page is off', [{ name: 'login.png', bytes: png() }])
    await idle(first)
    const [earlier] = await userEvents(first)
    await first.dispose()

    const runtime = new FakeRuntime([], { rejectResume: true, orchestrator: [turnEnd] })
    const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
    engines.push(engine)
    await engine.invoke('orchestrator.send', 'And now this', [{ name: 'now.png', bytes: png(1) }])
    await idle(engine)

    const login = earlier!.kind === 'user_message' ? earlier!.images![0]! : null
    const fresh = runtime.orchestratorSpecs[1]!
    expect(fresh.resumeSessionId).toBeUndefined()
    expect(fresh.prompt).toContain(`User: [Sent with an image: login.png at ${path.join(orchestratorImagesFolder(paths.root), `${login!.id}-login.png`)}] The login page is off`)
    expect(fresh.promptImages).toEqual([{ mime: 'image/png', base64: base64(png(1)) }])
  })
})

describe('images on the tickets the orchestrator creates', () => {
  // The turn stays open (no turn_end) while the test calls the tools, as the agent would mid-turn.
  async function setup(steps: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }]) {
    const runtime = new FakeRuntime([], { orchestrator: steps })
    const engine = await makeEngine(runtime)
    const ws = (await engine.invoke('workspace.list'))[0]!
    return { runtime, engine, ws }
  }
  const tools = async (runtime: FakeRuntime) => {
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    return runtime.orchestratorSpecs[0]!.tools
  }
  const board = async (engine: Engine) => (await engine.invoke('board.get')).tickets
  const incoming = (slug: string) => fs.readdir(path.join(attachmentFoldersFor(paths, slug), '.incoming')).catch(() => [] as string[])

  test('create_tickets attaches the named images from the request to each ticket, and the receipt counts them', async () => {
    const { runtime, engine, ws } = await setup()
    await engine.invoke('orchestrator.send', 'Two bugs, see the screenshots', [
      { name: 'menu.png', bytes: png(1) },
      { name: 'footer.png', bytes: png(2) }
    ])
    const t = await tools(runtime)

    const answer = await t.createTickets({
      workspace: ws.name,
      tickets: [
        { title: 'Fix the menu', images: ['menu.png'] },
        { title: 'Fix the footer', images: ['FOOTER.png', 'menu.png', 'footer.png'] }
      ]
    })
    expect(answer).toBe(`Created #1 "Fix the menu" and #2 "Fix the footer" in ${ws.name}'s Backlog, with 3 images attached. Tell the user which workspace they went into.`)

    const [menu, footer] = await board(engine)
    expect(menu!.attachments.map((a) => a.filename)).toEqual(['menu.png'])
    // Named twice, attached once.
    expect(footer!.attachments.map((a) => a.filename).sort()).toEqual(['footer.png', 'menu.png'])
    const files = await engine.invoke('attachment.list', footer!.id)
    const footerPng = files.find((a) => a.filename === 'footer.png')!
    expect(await engine.invoke('attachment.data', footerPng.id)).toBe(`data:image/png;base64,${base64(png(2))}`)
    const folder = path.join(attachmentFoldersFor(paths, ws.slug), String(footer!.number))
    expect((await fs.readdir(folder)).sort()).toEqual(files.map((a) => `${a.id}-${a.filename}`).sort())
    expect(await incoming(ws.slug)).toEqual([])

    expect((await engine.invoke('orchestrator.get')).events.at(-1)?.event).toMatchObject({ kind: 'tickets_created', images: 3 })
  })

  test("an image from outside the request's messages is refused, and creates nothing; request_messages_back reaches it", async () => {
    const { runtime, engine, ws } = await setup([{ emit: { kind: 'session', sessionId: 'sess-1' } }, turnEnd, { waitForSend: true }, { waitForSend: true }])
    await engine.invoke('orchestrator.send', 'Here is the bug', [{ name: 'bug.png', bytes: png() }])
    const t = await tools(runtime)
    await idle(engine)
    await engine.invoke('orchestrator.send', 'Make a ticket for it')
    await eventually(() => expect(runtime.sent).toHaveLength(1))

    const refused = await t.createTickets({ workspace: ws.name, tickets: [{ title: 'Fix the bug', images: ['bug.png'] }] })
    expect(refused).toBe("Invalid: tickets.0.images: bug.png is not an image the user sent in the request's messages (they sent none). Nothing was created; fix it and try again.")
    const proposed = await t.proposeCreateTickets({ tickets: [{ title: 'Fix the bug', images: ['other.png'] }], request_messages_back: 1 })
    expect(proposed).toMatch(/^Invalid proposal: tickets\.0\.images: other\.png is not an image the user sent in the request's messages \(those are bug\.png\)/)
    expect(await board(engine)).toEqual([])

    expect(await t.createTickets({ workspace: ws.name, tickets: [{ title: 'Fix the bug', images: ['bug.png'] }], request_messages_back: 1 })).toMatch(/with 1 image attached/)
    expect((await board(engine))[0]!.attachments.map((a) => a.filename)).toEqual(['bug.png'])
  })

  test('an image that can no longer be read creates no tickets at all, and leaves no files behind', async () => {
    const { runtime, engine, ws } = await setup()
    await engine.invoke('orchestrator.send', 'Two screenshots', [
      { name: 'one.png', bytes: png(1) },
      { name: 'two.png', bytes: png(2) }
    ])
    const t = await tools(runtime)
    const [message] = await userEvents(engine)
    const two = message!.kind === 'user_message' ? message!.images![1]! : null
    // Something changed the file on disk: it is no longer the image that was sent.
    await fs.writeFile(path.join(orchestratorImagesFolder(paths.root), `${two!.id}-two.png`), 'not an image')

    const answer = await t.createTickets({ workspace: ws.name, tickets: [{ title: 'First', images: ['one.png'] }, { title: 'Second', images: ['two.png'] }] })
    expect(answer).toBe("Couldn't create the tickets: An image the user sent can't be attached: two.png is no longer the image that was sent. Nothing was created.")
    expect(await board(engine)).toEqual([])
    expect(await incoming(ws.slug)).toEqual([])
  })

  test('a draft names its images on the card; Override can untick some; confirming attaches the rest', async () => {
    const { runtime, engine } = await setup()
    await engine.invoke('orchestrator.send', 'Draft a ticket with these', [
      { name: 'a.png', bytes: png(1) },
      { name: 'b.png', bytes: png(2) }
    ])
    const t = await tools(runtime)
    expect(await t.proposeCreateTickets({ tickets: [{ title: 'With images', images: ['a.png', 'b.png'] }] })).toMatch(/^Proposed /)

    const [proposal] = (await engine.invoke('orchestrator.get')).proposals
    const payload = proposal!.payload as CreateTicketsPayload
    const [a, b] = payload.tickets[0]!.images!
    expect(payload.tickets[0]!.images).toEqual([
      { id: expect.any(String), filename: 'a.png' },
      { id: expect.any(String), filename: 'b.png' }
    ])

    // Only the proposal's own images can be kept.
    await expect(
      engine.invoke('proposal.confirm', proposal!.id, { tickets: [{ title: 'With images', spec: '', criteria: [], labels: [], images: ['someone-else'] }], column: 'backlog' })
    ).rejects.toThrow("tickets.0.images: someone-else is not one of the proposal's images")

    const done = await engine.invoke('proposal.confirm', proposal!.id, {
      tickets: [{ title: 'With images', spec: '', criteria: [], labels: [], images: [b!.id] }],
      column: 'backlog'
    })
    expect(done.status).toBe('overridden')
    expect(done.result).toMatchObject({ images: 1 })
    expect(a).toBeDefined()
    const [ticket] = await board(engine)
    expect(ticket!.attachments.map((x) => x.filename)).toEqual(['b.png'])
  })

  test('confirming a draft as proposed attaches all its images; a draft without them attaches none', async () => {
    const { runtime, engine } = await setup()
    await engine.invoke('orchestrator.send', 'Two tickets', [{ name: 'shot.png', bytes: png() }])
    const t = await tools(runtime)
    await t.proposeCreateTickets({ tickets: [{ title: 'Uses it', images: ['shot.png'] }, { title: 'Does not' }] })
    const [proposal] = (await engine.invoke('orchestrator.get')).proposals
    const done = await engine.invoke('proposal.confirm', proposal!.id)
    expect(done.status).toBe('confirmed')
    expect(done.result).toMatchObject({ images: 1 })
    const [uses, not] = await board(engine)
    expect(uses!.attachments.map((x) => x.filename)).toEqual(['shot.png'])
    expect(not!.attachments).toEqual([])
  })
})

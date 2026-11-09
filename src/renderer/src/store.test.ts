import type { EngineEvent } from '../../shared/api'
import { invoke, onEngineEvent } from './api'
import { asOwnChange, resetOwnChanges } from './board/ownChanges'
import { startSync, useMainbus } from './store'
import { makeTicket, workspace } from './test-utils'

vi.mock('./api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()
const summary = { ...workspace, active: false, needsYou: 0, working: 0, waiting: 0, idle: 0 }

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
})

test('checkSetup keeps a failed check and loads nothing else', async () => {
  mockInvoke.mockResolvedValueOnce({ ok: false, reason: 'not_found', detail: 'no claude' })
  await useMainbus.getState().checkSetup()
  expect(useMainbus.getState().setup).toEqual({ ok: false, reason: 'not_found', detail: 'no claude' })
  expect(mockInvoke).toHaveBeenCalledTimes(1)
})

test('checkSetup loads the workspace and its board once Claude is ready', async () => {
  const ticket = makeTicket()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return { ok: true, path: 'claude', version: '2.1.0' }
    if (command === 'workspace.get') return workspace
    if (command === 'workspace.summaries') return [summary]
    if (command === 'board.get') return { tickets: [ticket] }
    if (command === 'unattended.get') return { on: true, status: { kind: 'working', ticketNumber: 3 } }
    if (command === 'usage.get') return { kind: 'ok' }
    throw new Error(`unexpected ${command}`)
  })
  await useMainbus.getState().checkSetup()
  const s = useMainbus.getState()
  expect(s.setup?.ok).toBe(true)
  expect(s.workspace).toEqual(workspace)
  expect(s.workspaceLoaded).toBe(true)
  expect(s.tickets).toEqual([ticket])
  expect(s.workspaces).toEqual([summary])
  expect(s.unattended).toEqual({ on: true, status: { kind: 'working', ticketNumber: 3 } })
})

test('openWorkspace stores the workspace and loads its board', async () => {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'workspace.open') return workspace
    if (command === 'workspace.summaries') return [summary]
    if (command === 'board.get') return { tickets: [] }
    throw new Error(`unexpected ${command}`)
  })
  await useMainbus.getState().openWorkspace('C:\\repos\\mainbus')
  expect(mockInvoke).toHaveBeenCalledWith('workspace.open', 'C:\\repos\\mainbus')
  expect(useMainbus.getState().workspace).toEqual(workspace)
})

test('openTicket and closeTicket set currentTicketId', () => {
  useMainbus.getState().openTicket('t9')
  expect(useMainbus.getState().currentTicketId).toBe('t9')
  useMainbus.getState().closeTicket()
  expect(useMainbus.getState().currentTicketId).toBeNull()
})

test('a refresh asked for while one is running waits for it, then reads the board again', async () => {
  const first = makeTicket({ title: 'old' })
  const second = makeTicket({ title: 'new' })
  let release: (v: unknown) => void = () => {}
  mockInvoke
    .mockImplementationOnce(() => new Promise((r) => (release = r)))
    .mockResolvedValueOnce({ tickets: [second] })
  const slow = useMainbus.getState().refreshBoard()
  const queued = useMainbus.getState().refreshBoard()
  release({ tickets: [first] })
  await Promise.all([slow, queued])
  expect(mockInvoke).toHaveBeenCalledTimes(2)
  expect(useMainbus.getState().tickets).toEqual([second])
})

const focused = { id: 'w1', name: 'repo', repoPath: '/r', baseBranch: 'main', slug: 'repo', openPrOnReview: false, saveReports: true, reportsFolder: 'docs/investigations', setupCommand: '', setupTimeoutMinutes: 15, testCommands: [] }

test('startSync refreshes the board on board.changed and stops after unsubscribe', async () => {
  let listener: (e: EngineEvent) => void = () => {}
  const unsubscribe = vi.fn()
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return unsubscribe
  })
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return { ok: false, reason: 'not_logged_in', detail: '' }
    if (command === 'workspace.summaries') return []
    if (command === 'board.get') return { tickets: [makeTicket({ title: 'fresh' })] }
    throw new Error(`unexpected ${command}`)
  })
  const stop = startSync(vi.fn())
  await vi.waitFor(() => expect(useMainbus.getState().setup).not.toBeNull())
  useMainbus.setState({ workspace: focused })

  listener({ type: 'board.changed', workspaceId: 'w1' })
  await vi.waitFor(() => expect(useMainbus.getState().tickets[0]?.title).toBe('fresh'))

  stop()
  expect(unsubscribe).toHaveBeenCalled()
})

test('startSync keeps the unattended state from unattended.changed, and setUnattended asks the engine', async () => {
  let listener: (e: EngineEvent) => void = () => {}
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return () => {}
  })
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return { ok: false, reason: 'not_logged_in', detail: '' }
    if (command === 'unattended.set') return { on: true, status: { kind: 'starting' } }
    throw new Error(`unexpected ${command}`)
  })
  const stop = startSync(vi.fn())
  useMainbus.setState({ workspace: focused })
  // Another workspace's mode is not the board's business.
  listener({ type: 'unattended.changed', workspaceId: 'w2', state: { on: true, status: { kind: 'idle' } } })
  expect(useMainbus.getState().unattended).not.toEqual({ on: true, status: { kind: 'idle' } })
  listener({ type: 'unattended.changed', workspaceId: 'w1', state: { on: true, status: { kind: 'working', ticketNumber: 2 } } })
  expect(useMainbus.getState().unattended).toEqual({ on: true, status: { kind: 'working', ticketNumber: 2 } })

  await useMainbus.getState().setUnattended(true)
  expect(mockInvoke).toHaveBeenCalledWith('unattended.set', true)
  // The reply could overtake later events, so only the events change the state.
  expect(useMainbus.getState().unattended.status).toEqual({ kind: 'working', ticketNumber: 2 })
  stop()
})

test('20 board.changed events during one refresh cost at most two board.get calls', async () => {
  let listener: (e: EngineEvent) => void = () => {}
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return () => {}
  })
  const releases: ((v: unknown) => void)[] = []
  mockInvoke.mockImplementation((command: string) => {
    if (command === 'setup.check') return Promise.resolve({ ok: false, reason: 'not_found', detail: '' })
    if (command === 'workspace.summaries') return Promise.resolve([])
    return new Promise((r) => releases.push(r)) // board.get stays pending until released
  })
  startSync(vi.fn())
  await vi.waitFor(() => expect(useMainbus.getState().setup).not.toBeNull())
  useMainbus.setState({ workspace: focused })

  for (let i = 0; i < 20; i++) listener({ type: 'board.changed', workspaceId: 'w1' })
  await vi.waitFor(() => expect(releases).toHaveLength(1))
  releases[0]({ tickets: [] })
  await vi.waitFor(() => expect(releases).toHaveLength(2)) // the single trailing refresh
  releases[1]({ tickets: [] })
  await new Promise((r) => setTimeout(r, 20))
  expect(mockInvoke.mock.calls.filter(([c]) => c === 'board.get')).toHaveLength(2)
})

test('a refresh failure is reported once until a refresh succeeds again', async () => {
  let listener: (e: EngineEvent) => void = () => {}
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return () => {}
  })
  let boardFails = true
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return { ok: false, reason: 'not_found', detail: '' }
    if (command === 'workspace.summaries') return []
    if (boardFails) throw new Error('board down')
    return { tickets: [] }
  })
  const onError = vi.fn()
  startSync(onError)
  await vi.waitFor(() => expect(useMainbus.getState().setup).not.toBeNull())
  useMainbus.setState({ workspace: focused })
  const fire = async (): Promise<void> => {
    listener({ type: 'board.changed', workspaceId: 'w1' })
    // Longer than the sync's throttle window, so each event gets its own refresh.
    await new Promise((r) => setTimeout(r, 250))
  }

  await fire()
  await fire()
  expect(onError).toHaveBeenCalledTimes(1)
  boardFails = false
  await fire()
  boardFails = true
  await fire()
  expect(onError).toHaveBeenCalledTimes(2)
})

test('a failing first load is kept as loadError, and load() clears it when it works', async () => {
  mockInvoke.mockRejectedValueOnce(new Error("Error invoking remote method 'engine:invoke': Error: boom"))
  await useMainbus.getState().load()
  expect(useMainbus.getState().loadError).toBe('boom')
  mockInvoke.mockResolvedValueOnce({ ok: false, reason: 'not_found', detail: '' })
  await useMainbus.getState().load()
  expect(useMainbus.getState().loadError).toBeNull()
  expect(useMainbus.getState().setup).toMatchObject({ ok: false })
})

test('a refresh that finds the same board keeps the stored tickets, and an unchanged ticket keeps its identity', async () => {
  const a = makeTicket({ title: 'a' })
  const b = makeTicket({ title: 'b' })
  mockInvoke.mockResolvedValueOnce({ tickets: [a, b] })
  await useMainbus.getState().refreshBoard()
  const stored = useMainbus.getState().tickets
  const subscriber = vi.fn()
  const off = useMainbus.subscribe(subscriber)

  // Same content, brand-new objects (as every IPC read delivers): no state change at all.
  mockInvoke.mockResolvedValueOnce({ tickets: structuredClone([a, b]) })
  await useMainbus.getState().refreshBoard()
  expect(subscriber).not.toHaveBeenCalled()
  expect(useMainbus.getState().tickets).toBe(stored)

  // One ticket changes: only that one is a new object.
  mockInvoke.mockResolvedValueOnce({ tickets: structuredClone([a, { ...b, title: 'b2' }]) })
  await useMainbus.getState().refreshBoard()
  const next = useMainbus.getState().tickets
  expect(next[0]).toBe(stored[0])
  expect(next[1]).not.toBe(stored[1])
  expect(next[1]?.title).toBe('b2')
  off()
})

describe('recently changed tickets', () => {
  const read = async (...tickets: ReturnType<typeof makeTicket>[]): Promise<void> => {
    mockInvoke.mockResolvedValueOnce({ tickets: structuredClone(tickets) })
    await useMainbus.getState().refreshBoard()
  }
  const working = (t: ReturnType<typeof makeTicket>): ReturnType<typeof makeTicket> => ({
    ...t,
    state: { ...t.state, column: 'in_progress', phase: 'implementing', agentStatus: 'working' }
  })

  beforeEach(() => resetOwnChanges())

  test.each([
    ['column', (t: ReturnType<typeof makeTicket>) => ({ ...t, state: { ...t.state, column: 'ready' as const } })],
    ['phase', (t: ReturnType<typeof makeTicket>) => ({ ...t, state: { ...t.state, phase: 'reviewing' as const } })],
    ['agent status', (t: ReturnType<typeof makeTicket>) => ({ ...t, state: { ...t.state, agentStatus: 'failed' as const } })]
  ])('a changed %s is marked, and nothing else is', async (_what, change) => {
    const a = makeTicket({}, { column: 'backlog' })
    const b = makeTicket({}, { column: 'backlog' })
    await read(a, b)
    expect(useMainbus.getState().recentlyChanged).toEqual({})
    await read(change(a), b)
    expect(Object.keys(useMainbus.getState().recentlyChanged)).toEqual([a.id])
  })

  test('a change that is only to the title or summary is not marked', async () => {
    const a = makeTicket({}, { column: 'backlog' })
    await read(a)
    await read({ ...a, title: 'New title', state: { ...a.state, summary: 'hello' } })
    expect(useMainbus.getState().recentlyChanged).toEqual({})
  })

  test("the person's own change is not marked, during the command and just after", async () => {
    const a = makeTicket({}, { column: 'backlog' })
    await read(a)
    await asOwnChange(a.id, () => read(working(a)))
    expect(useMainbus.getState().recentlyChanged).toEqual({})
    await read({ ...working(a), state: { ...working(a).state, phase: 'reviewing' } })
    expect(useMainbus.getState().recentlyChanged).toEqual({})
  })

  test('a new ticket, the first load and a workspace switch are not marked', async () => {
    const a = makeTicket({}, { column: 'backlog' })
    await read(a)
    expect(useMainbus.getState().recentlyChanged).toEqual({})
    await read(a, makeTicket({}, { column: 'ready' }))
    expect(useMainbus.getState().recentlyChanged).toEqual({})

    useMainbus.setState({ recentlyChanged: { [a.id]: Date.now() } })
    mockInvoke.mockImplementation(async (command: string) =>
      command === 'workspace.get' ? { ...workspace, id: 'other' } : command === 'board.get' ? { tickets: [working(a)] } : { on: false, status: { kind: 'off' } }
    )
    await useMainbus.getState().reloadFocused()
    expect(useMainbus.getState().recentlyChanged).toEqual({})
  })

  test('entries older than the outline are dropped on the next change', async () => {
    const a = makeTicket({}, { column: 'backlog' })
    const b = makeTicket({}, { column: 'backlog' })
    await read(a, b)
    useMainbus.setState({ recentlyChanged: { [a.id]: Date.now() - 10_000 } })
    await read(a, working(b))
    expect(Object.keys(useMainbus.getState().recentlyChanged)).toEqual([b.id])
  })
})

test('1,000 board.changed events in a tight loop cost a handful of board.get calls and no React warning', async () => {
  let listener: (e: EngineEvent) => void = () => {}
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return () => {}
  })
  const ticket = makeTicket()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return { ok: false, reason: 'not_found', detail: '' }
    if (command === 'workspace.summaries') return []
    return { tickets: [structuredClone(ticket)] }
  })
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
  const stop = startSync(vi.fn())
  await vi.waitFor(() => expect(useMainbus.getState().setup).not.toBeNull())
  useMainbus.setState({ workspace: focused })

  for (let i = 0; i < 1000; i++) listener({ type: 'board.changed', workspaceId: 'w1' })
  await new Promise((r) => setTimeout(r, 400))

  expect(mockInvoke.mock.calls.filter(([c]) => c === 'board.get').length).toBeLessThanOrEqual(4)
  expect(warn).not.toHaveBeenCalled()
  warn.mockRestore()
  stop()
})

test('stopping the sync cancels a refresh that was waiting out the throttle window', async () => {
  let listener: (e: EngineEvent) => void = () => {}
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return () => {}
  })
  mockInvoke.mockImplementation(async (command: string) =>
    command === 'setup.check'
      ? { ok: false, reason: 'not_found', detail: '' }
      : command === 'workspace.summaries'
        ? []
        : { tickets: [] }
  )
  const stop = startSync(vi.fn())
  await vi.waitFor(() => expect(useMainbus.getState().setup).not.toBeNull())
  useMainbus.setState({ workspace: focused })
  listener({ type: 'board.changed', workspaceId: 'w1' }) // leads
  listener({ type: 'board.changed', workspaceId: 'w1' }) // waits
  stop()
  await new Promise((r) => setTimeout(r, 300))
  expect(mockInvoke.mock.calls.filter(([c]) => c === 'board.get')).toHaveLength(1)
})

test('the rail counts load at launch, and follow board.changed and decision.changed of any workspace', async () => {
  let listener: (e: EngineEvent) => void = () => {}
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    listener = l
    return () => {}
  })
  let needsYou = 0
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'setup.check') return { ok: true, path: 'claude', version: '2.1.0' }
    if (command === 'workspace.get') return workspace
    if (command === 'workspace.summaries') return [{ ...workspace, active: false, needsYou }]
    if (command === 'board.get') return { tickets: [] }
    if (command === 'unattended.get') return { on: false, status: { kind: 'off' } }
    if (command === 'usage.get') return { kind: 'ok' }
    throw new Error(`unexpected ${command}`)
  })
  const stop = startSync(vi.fn())
  await vi.waitFor(() => expect(useMainbus.getState().workspaces).toHaveLength(1))
  expect(useMainbus.getState().workspaces[0]?.needsYou).toBe(0)

  needsYou = 2
  // Not the focused workspace: the board is left alone, the rail still counts it.
  listener({ type: 'board.changed', workspaceId: 'other' })
  await vi.waitFor(() => expect(useMainbus.getState().workspaces[0]?.needsYou).toBe(2))
  expect(mockInvoke.mock.calls.filter(([c]) => c === 'board.get')).toHaveLength(1)
  stop()
})

test('focusWorkspace focuses it, closes an open ticket and shows its board', async () => {
  const other = { ...workspace, id: 'w9', name: 'other' }
  let focusedNow = workspace
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.focus') {
      focusedNow = other
      return other
    }
    if (command === 'workspace.get') return focusedNow
    if (command === 'board.get') return { tickets: [] }
    if (command === 'unattended.get') return { on: false, status: { kind: 'off' } }
    throw new Error(`unexpected ${command} ${String(args)}`)
  })
  useMainbus.setState({ workspace, currentTicketId: 't1' })
  await useMainbus.getState().focusWorkspace('w9')
  expect(mockInvoke).toHaveBeenCalledWith('workspace.focus', 'w9')
  expect(useMainbus.getState().workspace?.id).toBe('w9')
  expect(useMainbus.getState().currentTicketId).toBeNull()
})

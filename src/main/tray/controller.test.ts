import { beforeEach, describe, expect, test } from 'vitest'
import type { AppNavigation, BoardTicket, EngineEvent } from '../../shared/api'
import type { WhenClosed, Workspace } from '../../shared/domain'
import { TrayController, type MenuEntry } from './controller'
import { ticket } from './fixtures'
import { recordingNotifier, recordTrayView } from './recording'

const ws = (id: string): Workspace => ({ id, name: `repo-${id}`, repoPath: `/r/${id}`, baseBranch: 'main', slug: id, openPrOnReview: false, saveReports: true, reportsFolder: 'docs/investigations' })

class Fixture {
  boards = new Map<string, BoardTicket[]>([['w1', []]])
  whenClosed: WhenClosed = 'tray'
  listener: ((e: EngineEvent) => void) | null = null
  timers: (() => void)[] = []
  dot = false
  tooltip = ''
  menu: MenuEntry[] = []
  clickTray: () => void = () => {}
  visible = true
  focused = true
  calls: string[] = []
  badge: [string | null, string] = [null, '']
  navigations: AppNavigation[] = []
  noticeShown = false
  quits = 0
  toasts = recordingNotifier()
  controller: TrayController

  constructor() {
    const view = recordTrayView({
      setDot: (d) => (this.dot = d),
      setToolTip: (t) => (this.tooltip = t),
      setMenu: (m) => (this.menu = m),
      onClick: (cb) => (this.clickTray = cb),
      destroy: () => this.calls.push('destroy')
    })
    this.controller = new TrayController({
      source: {
        invoke: ((command: string, ...args: string[]) => {
          if (command === 'workspace.list') return [...this.boards.keys()].map(ws)
          if (command === 'board.get') return { tickets: this.boards.get(args[0]!) ?? [] }
          if (command === 'settings.get') return { maxAgents: 3, whenClosed: this.whenClosed }
          throw new Error(`unexpected ${command}`)
        }) as never,
        on: (l) => {
          this.listener = l
          return () => (this.listener = null)
        }
      },
      view: view.view,
      window: {
        isVisible: () => this.visible,
        isFocused: () => this.focused,
        show: () => {
          this.visible = true
          this.focused = true
          this.calls.push('show')
        },
        hide: () => {
          this.visible = false
          this.focused = false
          this.calls.push('hide')
        },
        setBadge: (text, description) => (this.badge = [text, description]),
        navigate: (n) => this.navigations.push(n)
      },
      notifier: this.toasts.notifier,
      prefs: { noticeShown: () => this.noticeShown, markNoticeShown: () => (this.noticeShown = true) },
      quit: () => this.quits++,
      timer: (fn) => {
        this.timers.push(fn)
        return () => {}
      }
    })
  }

  /** Runs the timers that are due, the way the clock would. */
  async tick(): Promise<void> {
    const due = this.timers.splice(0)
    for (const fn of due) fn()
    await this.controller.refresh()
  }

  async change(workspaceId: string, tickets: BoardTicket[]): Promise<void> {
    this.boards.set(workspaceId, tickets)
    this.listener?.({ type: 'board.changed', workspaceId })
    await this.tick()
    await this.tick()
  }

  item(label: string): MenuEntry {
    return this.menu.find((m) => m?.label === label) ?? null
  }
}

let f: Fixture
beforeEach(async () => {
  f = new Fixture()
})

async function started(tickets: BoardTicket[]): Promise<void> {
  f.boards.set('w1', tickets)
  await f.controller.start()
}

describe('the icon, tooltip and badge', () => {
  test('follow the working and needs-you counts across workspaces, and clear at zero', async () => {
    f.boards.set('w2', [ticket('t9', 'needs_you', 'waiting_on_you', { workspaceId: 'w2' })])
    await started([ticket('t1', 'in_progress', 'working'), ticket('t2', 'in_progress', 'working')])
    expect(f.tooltip).toBe('Mainbus: 2 working, 1 needs you')
    expect(f.dot).toBe(true)
    expect(f.badge).toEqual(['1', '1 ticket needs you'])

    await f.change('w2', [])
    expect(f.tooltip).toBe('Mainbus: 2 working')
    expect(f.dot).toBe(false)
    expect(f.badge).toEqual([null, ''])
  })

  test('reading is throttled: many events make one read after the interval', async () => {
    await started([])
    for (let i = 0; i < 5; i++) f.listener?.({ type: 'board.changed', workspaceId: 'w1' })
    expect(f.timers).toHaveLength(1)
  })
})

describe('closing the window', () => {
  test('hides it while an agent is open, and says so the first time only', async () => {
    await started([ticket('t1', 'in_progress', 'working')])
    await f.controller.handleClose()
    expect(f.calls).toContain('hide')
    expect(f.quits).toBe(0)
    expect(f.toasts.hook.notifications()).toEqual([{ title: 'Mainbus is still running', body: 'Agents keep working. Quit from the tray icon.' }])

    f.visible = true
    await f.controller.handleClose()
    expect(f.toasts.hook.notifications()).toHaveLength(1)
    expect(f.noticeShown).toBe(true)
  })

  test('a queued agent, or one waiting on the user, keeps it running too', async () => {
    await started([ticket('t1', 'in_progress', 'queued')])
    await f.controller.handleClose()
    expect(f.quits).toBe(0)
    await f.change('w1', [ticket('t1', 'needs_you', 'waiting_on_you')])
    await f.controller.handleClose()
    expect(f.quits).toBe(0)
  })

  test('quits when no agent is open', async () => {
    await started([ticket('t1', 'review', 'handed_off'), ticket('t2', 'done')])
    await f.controller.handleClose()
    expect(f.quits).toBe(1)
    expect(f.calls).not.toContain('hide')
    expect(f.toasts.hook.notifications()).toEqual([])
  })

  test('quits with agents open when the setting is Always quit', async () => {
    f.whenClosed = 'quit'
    await started([ticket('t1', 'in_progress', 'working')])
    await f.controller.handleClose()
    expect(f.quits).toBe(1)
    expect(f.calls).not.toContain('hide')
  })

  test('counts agents in every workspace', async () => {
    f.boards.set('w2', [ticket('t5', 'in_progress', 'working', { workspaceId: 'w2' })])
    await started([])
    await f.controller.handleClose()
    expect(f.quits).toBe(0)
  })
})

describe('the tray', () => {
  test('a left click shows the window', async () => {
    await started([])
    f.visible = false
    f.clickTray()
    expect(f.calls).toEqual(['show'])
  })

  test('the menu opens Mainbus, counts what needs you, and quits', async () => {
    await started([ticket('t1', 'needs_you', 'waiting_on_you'), ticket('t2', 'needs_you', 'waiting_on_you')])
    expect(f.menu.map((m) => m && [m.label, m.enabled])).toEqual([
      ['Open Mainbus', true],
      ['2 need you', true],
      null,
      ['Quit', true]
    ])
    f.item('Open Mainbus')?.action()
    expect(f.calls).toEqual(['show'])
    f.item('Quit')?.action()
    expect(f.quits).toBe(1)
  })

  test('the needs-you entry opens that board, in the first workspace that has something; disabled when nothing needs you', async () => {
    f.boards.set('w2', [ticket('t7', 'needs_you', 'waiting_on_you', { workspaceId: 'w2' })])
    await started([ticket('t1', 'in_progress', 'working')])
    f.item('1 needs you')?.action()
    expect(f.calls).toEqual(['show'])
    expect(f.navigations).toEqual([{ to: 'needsYou', workspaceId: 'w2' }])

    await f.change('w2', [])
    expect(f.item('Nothing needs you')).toMatchObject({ enabled: false })
  })
})

describe('toasts', () => {
  async function fire(): Promise<void> {
    await f.tick()
  }

  test('a ticket reaching Needs you while the window is hidden gets one toast; clicking opens the ticket', async () => {
    await started([ticket('t1', 'in_progress', 'working', { number: 12, title: 'Add tray' })])
    f.visible = false
    await f.change('w1', [ticket('t1', 'needs_you', 'waiting_on_you', { number: 12, title: 'Add tray', summary: 'Which icon?' })])
    await fire()
    expect(f.toasts.hook.notifications()).toEqual([{ title: '#12 needs you', body: 'Add tray - Which icon?' }])

    f.toasts.hook.clickNotification(0)
    expect(f.calls).toEqual(['show'])
    expect(f.navigations).toEqual([{ to: 'ticket', workspaceId: 'w1', ticketId: 't1' }])
  })

  test('arrivals together are one batched toast, and its click opens the Needs you board', async () => {
    await started([ticket('t1', 'in_progress', 'working'), ticket('t2', 'in_progress', 'working'), ticket('t3', 'in_progress', 'working')])
    f.focused = false
    await f.change('w1', [ticket('t1', 'needs_you'), ticket('t2', 'needs_you'), ticket('t3', 'review')])
    await fire()
    expect(f.toasts.hook.notifications()).toHaveLength(1)
    expect(f.toasts.hook.notifications()[0]!.title).toBe('3 tickets need you')
    f.toasts.hook.clickNotification(0)
    expect(f.navigations).toEqual([{ to: 'needsYou', workspaceId: 'w1' }])
  })

  test('no toast while the window is visible and focused, and none for tickets already there at launch', async () => {
    await started([ticket('t1', 'needs_you')])
    await fire()
    expect(f.toasts.hook.notifications()).toEqual([])
    await f.change('w1', [ticket('t1', 'needs_you'), ticket('t2', 'review')])
    await fire()
    expect(f.toasts.hook.notifications()).toEqual([])
  })

  test('with several workspaces, the toast names the workspace', async () => {
    f.boards.set('w2', [ticket('t8', 'in_progress', 'working', { workspaceId: 'w2' })])
    await started([])
    f.visible = false
    await f.change('w2', [ticket('t8', 'review', null, { workspaceId: 'w2', number: 8, title: 'Other' })])
    await fire()
    expect(f.toasts.hook.notifications()).toEqual([{ title: '#8 is ready for review', body: 'repo-w2: Other' }])
  })
})

test('dispose stops following the engine and destroys the tray icon', async () => {
  await started([])
  f.controller.dispose()
  expect(f.listener).toBeNull()
  expect(f.calls).toContain('destroy')
})

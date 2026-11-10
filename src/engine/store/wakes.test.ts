import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createWakeRepo, type WakeRepo } from './wakes'
import { FIXED_NOW, openTestDb } from './testDb'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let wakes: WakeRepo
let wsId: string
let clock: Date
const now = () => clock
const at = (seconds: number): Date => new Date(FIXED_NOW.getTime() + seconds * 1000)

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  clock = FIXED_NOW
  wsId = (await createWorkspaceRepo(db, now).create('/r', 'main', 'r', 'r')).id
  wakes = createWakeRepo(db, now)
})
afterEach(() => cleanup())

describe('reviewedSince', () => {
  const only = async () => (await wakes.pending())[0]!

  it('is true for a review row that was presented and acknowledged since then', async () => {
    await wakes.add(wsId, 'done_review', 't-1')
    await wakes.markPresented([(await only()).id])
    clock = at(60)
    await wakes.ack([(await only()).id])
    expect(await wakes.reviewedSince('done_review', 't-1', at(0).toISOString())).toBe(true)
    expect(await wakes.reviewedSince('done_review', 't-1', at(61).toISOString())).toBe(false)
    expect(await wakes.reviewedSince('done_review', 't-2', at(0).toISOString())).toBe(false)
    expect(await wakes.reviewedSince('failure', 't-1', at(0).toISOString())).toBe(false)
  })

  it('is false for a row dropped as gone (acknowledged without being presented) or still waiting', async () => {
    await wakes.add(wsId, 'done_review', 't-1')
    expect(await wakes.reviewedSince('done_review', 't-1', at(0).toISOString())).toBe(false)
    await wakes.ack([(await only()).id])
    expect(await wakes.reviewedSince('done_review', 't-1', at(0).toISOString())).toBe(false)
  })
})

describe('the wake queue', () => {
  it('adds a row per kind and ref, oldest first', async () => {
    expect(await wakes.add(wsId, 'failure', 'run-1')).toBe(true)
    clock = at(1)
    expect(await wakes.add(wsId, 'stuck', 'ep-1')).toBe(true)
    expect(await wakes.add(wsId, 'stuck', 'run-1')).toBe(true)
    expect((await wakes.pending()).map((w) => [w.kind, w.ref])).toEqual([
      ['failure', 'run-1'],
      ['stuck', 'ep-1'],
      ['stuck', 'run-1']
    ])
  })

  it('ignores a repeat while the earlier row is unacknowledged, and takes it again after the acknowledgement', async () => {
    expect(await wakes.add(wsId, 'failure', 'run-1')).toBe(true)
    expect(await wakes.add(wsId, 'failure', 'run-1')).toBe(false)
    expect(await wakes.pending()).toHaveLength(1)
    await wakes.ack((await wakes.pending()).map((w) => w.id))
    expect(await wakes.pending()).toEqual([])
    expect(await wakes.add(wsId, 'failure', 'run-1')).toBe(true)
    expect(await wakes.pending()).toHaveLength(1)
  })

  it('marks rows as presented, again on a second presentation, and keeps them pending until acknowledged', async () => {
    await wakes.add(wsId, 'failure', 'run-1')
    await wakes.add(wsId, 'resurfaced', 'd-1')
    const [a, b] = await wakes.pending()
    expect(a!.presentedAt).toBeNull()
    clock = at(10)
    await wakes.markPresented([a!.id])
    expect(await wakes.presentedSince(null)).toEqual([{ kind: 'failure', ref: 'run-1' }])
    expect((await wakes.pending()).map((w) => w.presentedAt)).toEqual([at(10).toISOString(), null])
    expect(await wakes.presentedSince(at(11).toISOString())).toEqual([])
    clock = at(20)
    await wakes.markPresented([a!.id, b!.id])
    expect((await wakes.pending()).map((w) => w.presentedAt)).toEqual([at(20).toISOString(), at(20).toISOString()])
    expect(await wakes.presentedSince(at(11).toISOString())).toHaveLength(2)
  })

  it('acknowledges only the rows named, once', async () => {
    await wakes.add(wsId, 'failure', 'run-1')
    await wakes.add(wsId, 'failure', 'run-2')
    const [a] = await wakes.pending()
    await wakes.ack([a!.id])
    clock = at(5)
    await wakes.ack([a!.id])
    expect((await wakes.pending()).map((w) => w.ref)).toEqual(['run-2'])
    await wakes.ack([])
  })
})

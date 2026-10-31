import { describe, expect, test } from 'vitest'
import { InputQueue } from './inputQueue'

describe('InputQueue', () => {
  test('delivers values pushed before and after iteration starts, in order', async () => {
    const q = new InputQueue<number>()
    q.push(1)
    q.push(2)
    const it = q[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 1, done: false })
    const third = it.next()
    q.push(3)
    expect(await third).toEqual({ value: 2, done: false })
    expect(await it.next()).toEqual({ value: 3, done: false })
  })

  test('ends iteration after end()', async () => {
    const q = new InputQueue<string>()
    q.push('a')
    const seen: string[] = []
    const consume = (async () => {
      for await (const v of q) seen.push(v)
    })()
    q.end()
    await consume
    expect(seen).toEqual(['a'])
  })

  test('ignores values pushed after end() and wakes a waiting consumer', async () => {
    const q = new InputQueue<string>()
    const it = q[Symbol.asyncIterator]()
    const waiting = it.next()
    q.end()
    expect(await waiting).toEqual({ value: undefined, done: true })
    q.push('late')
    expect(await it.next()).toEqual({ value: undefined, done: true })
  })
})

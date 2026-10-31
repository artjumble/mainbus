import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '../../shared/events'
import { Normalizer } from './normalize'

function fixture(name: string): unknown[] {
  const file = resolve(import.meta.dirname, '../../../test/fixtures/sdk', `${name}.jsonl`)
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

function replay(name: string, n = new Normalizer()): AgentEvent[] {
  return fixture(name).flatMap((m) => n.push(m))
}

function ofKind<K extends AgentEvent['kind']>(events: AgentEvent[], kind: K) {
  return events.filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind)
}

describe('Normalizer', () => {
  test('e1-simple: one session, a message, one rate_limit and a successful turn_end', () => {
    const events = replay('e1-simple')
    expect(ofKind(events, 'session')).toHaveLength(1)
    expect(ofKind(events, 'message').length).toBeGreaterThanOrEqual(1)
    expect(ofKind(events, 'rate_limit')).toHaveLength(1)
    expect(ofKind(events, 'turn_end')).toEqual([{ kind: 'turn_end', ok: true }])
  })

  test('e1-simple: rate_limit carries the unified windows', () => {
    const [rl] = ofKind(replay('e1-simple'), 'rate_limit')
    expect(rl.status).toBe('allowed')
    expect(rl.windows.five_hour.utilization).toBe(0.04)
    expect(rl.windows.five_hour).toEqual({ utilization: 0.04, resetsAt: 1793418600, status: 'allowed' })
    expect(rl.windows.seven_day.utilization).toBe(0.07)
  })

  test('e2-interrupt: two turns, each with a system/init, emit session only once', () => {
    const msgs = fixture('e2-interrupt')
    const inits = msgs.filter((m) => (m as { subtype?: string }).subtype === 'init')
    expect(inits).toHaveLength(2)
    const events = replay('e2-interrupt')
    expect(ofKind(events, 'session')).toHaveLength(1)
    expect(ofKind(events, 'turn_end')).toHaveLength(2)
  })

  test('e2-interrupt-active: error_during_execution after expectInterrupt is interrupted', () => {
    const n = new Normalizer()
    n.expectInterrupt()
    const ends = ofKind(replay('e2-interrupt-active', n), 'turn_end')
    expect(ends[0]).toEqual({ kind: 'turn_end', ok: false, interrupted: true })
    expect(ends[1]).toEqual({ kind: 'turn_end', ok: true })
  })

  test('e2-interrupt-active: without expectInterrupt it is an error', () => {
    const ends = ofKind(replay('e2-interrupt-active'), 'turn_end')
    expect(ends[0]).toMatchObject({ kind: 'turn_end', ok: false, error: expect.stringContaining('ede_diagnostic') })
    expect(ends[0]).not.toHaveProperty('interrupted')
  })

  test('expectInterrupt applies to the next result only', () => {
    const n = new Normalizer()
    n.expectInterrupt()
    n.push({ type: 'result', subtype: 'success', result: 'x' })
    expect(n.push({ type: 'result', subtype: 'error_during_execution', result: '' })).toEqual([
      { kind: 'turn_end', ok: false, error: 'error_during_execution' }
    ])
  })

  test('a failed result without expectInterrupt reports the fixture errors[] text', () => {
    const failed = fixture('e2-interrupt-active').find(
      (m) => (m as { subtype?: string }).subtype === 'error_during_execution'
    ) as { errors: string[] }
    expect(failed.errors[0]).toBeTruthy()
    const [ev] = new Normalizer().push(failed)
    expect(ev).toMatchObject({ kind: 'turn_end', ok: false })
    expect((ev as { error: string }).error).toContain(failed.errors[0])
  })

  test('turn_end error prefers result text, then errors[], then the subtype', () => {
    const run = (m: object) => new Normalizer().push({ type: 'result', subtype: 'error_max_turns', ...m })
    expect(run({ result: 'Too many turns', errors: ['e'] })).toEqual([
      { kind: 'turn_end', ok: false, error: 'Too many turns' }
    ])
    expect(run({ result: '', errors: ['a', 'b'] })).toEqual([{ kind: 'turn_end', ok: false, error: 'a\nb' }])
    expect(run({ errors: [] })).toEqual([{ kind: 'turn_end', ok: false, error: 'error_max_turns' }])
  })

  test('a success result with is_error is a failed turn carrying the API error text', () => {
    const run = (m: object) => new Normalizer().push({ type: 'result', subtype: 'success', is_error: true, ...m })
    expect(run({ result: 'API Error: usage limit reached' })).toEqual([
      { kind: 'turn_end', ok: false, error: 'API Error: usage limit reached' }
    ])
    expect(run({ result: '', errors: ['overloaded', 'after retries'] })).toEqual([
      { kind: 'turn_end', ok: false, error: 'overloaded\nafter retries' }
    ])
    expect(run({ result: '' })).toEqual([{ kind: 'turn_end', ok: false, error: 'success' }])
    expect(new Normalizer().push({ type: 'result', subtype: 'success', is_error: false, result: 'x' })).toEqual([
      { kind: 'turn_end', ok: true }
    ])
  })

  test('e2-interrupt-active: tool_result ok follows is_error', () => {
    const results = ofKind(replay('e2-interrupt-active'), 'tool_result')
    expect(results.map((r) => r.ok)).toEqual([true, false])
    const calls = ofKind(replay('e2-interrupt-active'), 'tool_call')
    expect(results[0].id).toBe(calls[0].id)
  })

  test('e4-ask-handoff: role tool calls and one vcs_changed', () => {
    const events = replay('e4-ask-handoff')
    const names = ofKind(events, 'tool_call').map((e) => e.name)
    expect(names).toContain('mcp__mainbus__ask_user')
    expect(names).toContain('mcp__mainbus__handoff')
    expect(ofKind(events, 'vcs_changed')).toHaveLength(1)
    expect(ofKind(events, 'session')).toHaveLength(1)
  })

  test('tool_result summary: string content is used, truncated to 200 characters', () => {
    const n = new Normalizer()
    const long = 'x'.repeat(500)
    const [ev] = n.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: long }] }
    })
    expect(ev).toEqual({ kind: 'tool_result', id: 't1', ok: true, summary: 'x'.repeat(200) })
  })

  test('tool_result summary: array content joins its text parts', () => {
    const n = new Normalizer()
    const [ev] = n.push({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't2',
            is_error: true,
            content: [
              { type: 'text', text: 'one' },
              { type: 'tool_reference', tool_name: 'x' },
              { type: 'text', text: 'two' }
            ]
          }
        ]
      }
    })
    expect(ev).toEqual({ kind: 'tool_result', id: 't2', ok: false, summary: 'one\ntwo' })
  })

  test('e5-partial: partial messages precede the final one, which equals the concatenated deltas', () => {
    const msgs = fixture('e5-partial')
    const deltas = msgs
      .map((m) => (m as { event?: { delta?: { type?: string; text?: string } } }).event?.delta)
      .filter((d) => d?.type === 'text_delta')
      .map((d) => d!.text)
    const events = replay('e5-partial')
    const messages = ofKind(events, 'message')
    const partials = messages.filter((m) => m.partial)
    const finals = messages.filter((m) => !m.partial)
    expect(partials).toHaveLength(deltas.length)
    expect(finals).toHaveLength(1)
    expect(messages.indexOf(finals[0])).toBeGreaterThan(messages.indexOf(partials[partials.length - 1]))
    expect(finals[0].text).toBe(deltas.join(''))
    // each partial carries the full text so far, not the delta
    expect(partials[1].text).toBe(deltas.slice(0, 2).join(''))
    expect(partials[partials.length - 1].text).toBe(finals[0].text)
  })

  test('e5-thinking-opus-high: thinking stub opens partial, then closes with a duration', () => {
    const events = replay('e5-thinking-opus-high')
    const thinking = ofKind(events, 'thinking')
    expect(thinking).toHaveLength(2)
    expect(thinking[0]).toEqual({ kind: 'thinking', text: null, partial: true })
    expect(thinking[1].text).toBeNull()
    expect(thinking[1].partial).toBeUndefined()
    expect(thinking[1].durationMs).toBeGreaterThanOrEqual(0)
  })

  test('thinking text accumulates from thinking_delta and duration uses the clock', () => {
    let t = 1000
    const n = new Normalizer(() => t)
    const stream = (event: unknown) => n.push({ type: 'stream_event', event })
    stream({ type: 'message_start', message: { id: 'm1' } })
    expect(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })).toEqual([
      { kind: 'thinking', text: null, partial: true }
    ])
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm, ' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ok.' } })
    t = 4200
    expect(stream({ type: 'content_block_stop', index: 0 })).toEqual([
      { kind: 'thinking', text: 'Hmm, ok.', durationMs: 3200 }
    ])
  })

  test('thinking blocks inside assistant messages are ignored', () => {
    const n = new Normalizer()
    expect(
      n.push({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'thinking', thinking: 'secret', signature: 's' }] }
      })
    ).toEqual([])
  })

  test('partial text is keyed per message and content block', () => {
    const n = new Normalizer()
    const stream = (event: unknown) => n.push({ type: 'stream_event', event })
    const delta = (index: number, text: string) =>
      stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    stream({ type: 'message_start', message: { id: 'm1' } })
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })
    expect(delta(0, 'a')).toEqual([{ kind: 'message', text: 'a', partial: true }])
    expect(delta(1, 'x')).toEqual([{ kind: 'message', text: 'x', partial: true }])
    expect(delta(0, 'b')).toEqual([{ kind: 'message', text: 'ab', partial: true }])
    stream({ type: 'message_stop' })
    stream({ type: 'message_start', message: { id: 'm2' } })
    expect(delta(0, 'z')).toEqual([{ kind: 'message', text: 'z', partial: true }])
  })

  test.each([
    ['permission_check_status', { type: 'system', subtype: 'permission_check_status' }],
    ['task_summary', { type: 'system', subtype: 'task_summary' }],
    ['hook_response', { type: 'system', subtype: 'hook_response' }],
    ['hook_started', { type: 'system', subtype: 'hook_started' }],
    ['commands_changed', { type: 'system', subtype: 'commands_changed' }],
    ['thinking_tokens', { type: 'system', subtype: 'thinking_tokens' }],
    ['post_turn_summary', { type: 'system', subtype: 'post_turn_summary' }],
    ['unknown type', { type: 'something_new' }],
    ['non-object', 'text'],
    ['null', null]
  ])('ignores %s', (_name, msg) => {
    expect(new Normalizer().push(msg)).toEqual([])
  })

  test('ignores user text echoes', () => {
    expect(
      new Normalizer().push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    ).toEqual([])
  })

  test('replaying every fixture never throws', () => {
    for (const name of [
      'e1-simple',
      'e2-interrupt',
      'e2-interrupt-active',
      'e2-resume',
      'e3-auto',
      'e3-default',
      'e3-risky',
      'e4-ask-handoff',
      'e5-partial',
      'e5-thinking-opus-high'
    ]) {
      expect(() => replay(name)).not.toThrow()
    }
  })
})

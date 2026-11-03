import { describe, expect, it } from 'vitest'
import type { StoredEvent, ThreadEvent } from '../../../shared/events'
import { liveLine } from './liveLine'

const at = (seq: number, event: ThreadEvent, runId = 'r1'): StoredEvent => ({ runId, seq, at: '2026-11-01T10:00:00.000Z', event })
const call = (seq: number, name: string, input: unknown, runId = 'r1'): StoredEvent =>
  at(seq, { kind: 'tool_call', id: `c${seq}`, name, input }, runId)

describe('liveLine', () => {
  it('names the file being edited, relative to the ticket folder', () => {
    const events = [call(1, 'Edit', { file_path: 'C:\\work\\t1\\src\\export.ts' })]
    expect(liveLine(events, 'Implementer', 'C:\\work\\t1')).toBe('Implementer is editing src/export.ts')
    expect(liveLine([call(1, 'Write', { file_path: '/w/t1/a.md' })], 'Planner', '/w/t1')).toBe('Planner is editing a.md')
  })

  it('reads and searches', () => {
    expect(liveLine([call(1, 'Read', { file_path: '/w/t1/src/a.ts' })], 'Planner', '/w/t1')).toBe('Planner is reading src/a.ts')
    expect(liveLine([call(1, 'Grep', { pattern: 'TODO' })], 'Planner', null)).toBe('Planner is reading TODO')
  })

  it('runs a command, shortened when long', () => {
    expect(liveLine([call(1, 'Bash', { command: 'npm test' })], 'Implementer', null)).toBe('Implementer is running npm test')
    expect(liveLine([call(1, 'Bash', { command: 'x'.repeat(80) })], 'Implementer', null)).toBe(`Implementer is running ${'x'.repeat(59)}…`)
  })

  it('uses the latest call, and only of the open run', () => {
    const events = [call(1, 'Bash', { command: 'npm test' }), call(2, 'Edit', { file_path: 'a.ts' }), at(3, { kind: 'message', text: 'ok' })]
    expect(liveLine(events, 'Implementer', null)).toBe('Implementer is editing a.ts')
    const next = [call(1, 'Edit', { file_path: 'a.ts' }, 'r1'), at(2, { kind: 'message', text: 'hi' }, 'r2')]
    expect(liveLine(next, 'Reviewer', null)).toBe('Reviewer is working…')
  })

  it('says it is working before any tool call, or for a tool it has no wording for', () => {
    expect(liveLine([], 'Planner', null)).toBe('Planner is working…')
    expect(liveLine([call(1, 'WebFetch', { url: 'x' })], 'Planner', null)).toBe('Planner is working…')
  })
})

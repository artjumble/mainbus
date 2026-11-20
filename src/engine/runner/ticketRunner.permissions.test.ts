import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../shared/events'
import { FakeRuntime } from '../runtime/fakeRuntime'
import { Normalizer } from '../runtime/normalize'
import { type PermissionRequest } from '../runtime/types'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

import { count, installRunnerHooks, keepAlive, makeRunner, pausedRun, permission, repos, thread, ticket, tmp, waitForPending, waitForThread } from './ticketRunnerHarness'

installRunnerHooks()

describe('TicketRunner', () => {
  describe('permissions and turns', () => {
    it('permissions are expired when the process exits on its own', async () => {
      const runtime = new FakeRuntime([{ waitForSend: true }, { exit: 0 }])
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)
      const verdict = runtime.specs[0].onPermission(permission('npm run build'))
      const decision = await waitForPending()

      await runner.send(ticket.id, 'Wrap up')

      expect(await verdict).toMatchObject({ allow: false })
      expect(await repos.decisions.get(decision.id)).toMatchObject({ status: 'expired' })
      await eventually(async () => expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'paused' }))
    })

    it('a guarded Write outside the worktree gets no Always allow, and always_allow on it is rejected', async () => {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)
      const write: PermissionRequest = {
        toolName: 'Write',
        input: { file_path: path.join(tmp, 'elsewhere.txt'), content: 'x' },
        toolUseId: 'tool-2',
        signal: new AbortController().signal
      }

      const verdict = runtime.specs[0].onPermission(write)
      const decision = await waitForPending()

      expect(decision).toMatchObject({ kind: 'permission', allowAlways: false })
      await expect(runner.answer(decision.id, { kind: 'permission', choice: 'always_allow' }, 'thread')).rejects.toThrow(
        /Always allow/
      )
      expect(await repos.allowRules.list(ticket.workspaceId)).toEqual([])
      expect(await repos.decisions.get(decision.id)).toMatchObject({ status: 'pending' })
      await runner.answer(decision.id, { kind: 'permission', choice: 'allow_once' }, 'thread')
      expect(await verdict).toEqual({ allow: true })
      expect(await repos.allowRules.list(ticket.workspaceId)).toEqual([])
    })

    it('two consecutive error turns fail the run with the real error text, without a nudge', async () => {
      const runtime = new FakeRuntime([
        { emit: { kind: 'turn_end', ok: false, error: 'API Error: 500' } },
        { emit: { kind: 'turn_end', ok: false, error: 'API Error: 529 overloaded' } },
        { waitForSend: true }
      ])
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)

      await eventually(async () =>
        expect(await runner.stateOf(ticket.id)).toMatchObject({
          column: 'needs_you',
          agentStatus: 'failed',
          summary: 'Failed: API Error: 529 overloaded'
        })
      )
      expect(runtime.sent).toEqual([])
    })

    it('two success-with-is_error results fail the run with the API error text, without a nudge', async () => {
      const apiError = (text: string): AgentEvent =>
        new Normalizer().push({ type: 'result', subtype: 'success', is_error: true, result: text })[0]
      const runtime = new FakeRuntime([
        { emit: apiError('Claude AI usage limit reached') },
        { emit: apiError('Claude AI usage limit reached|1761868800') },
        { waitForSend: true }
      ])
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)

      await eventually(async () =>
        expect(await runner.stateOf(ticket.id)).toMatchObject({
          column: 'needs_you',
          agentStatus: 'failed',
          summary: 'Failed: Claude AI usage limit reached|1761868800'
        })
      )
      expect(runtime.sent).toEqual([])
      expect(count(await thread(), 'nudge')).toBe(0)
    })

    it('one error turn is neither a failure nor a silent turn', async () => {
      const runtime = new FakeRuntime([
        { emit: { kind: 'turn_end', ok: false, error: 'API Error: 500' } },
        { emit: { kind: 'message', text: 'after' } },
        { waitForSend: true }
      ])
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)

      await waitForThread((e) => e.kind === 'message' && e.text === 'after')
      expect(runtime.sent).toEqual([])
      expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'working' })
    })

    it('an ask_user answered before turn_end gets no nudge', async () => {
      const runtime = new FakeRuntime([
        { callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } },
        { waitForSend: true }, // the answer arrives before the turn ends
        { emit: { kind: 'turn_end', ok: true } },
        { emit: { kind: 'message', text: 'after' } },
        { waitForSend: true }
      ])
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)
      const decision = await waitForPending()

      await runner.answer(decision.id, { kind: 'option', index: 0 }, 'thread')
      await waitForThread((e) => e.kind === 'message' && e.text === 'after')

      expect(runtime.sent).toEqual(['Answer: Old API'])
    })

    it('a send that falls back to a fresh agent puts the message in the prompt once', async () => {
      await pausedRun()
      const fresh = new FakeRuntime(keepAlive, { rejectResume: true })
      const runner = makeRunner(fresh)

      await runner.send(ticket.id, 'Please also cover logout')

      expect(fresh.specs).toHaveLength(2)
      expect(fresh.specs[0].prompt).toBe('Please also cover logout')
      expect(fresh.specs[1].prompt.split('Please also cover logout')).toHaveLength(2)
      expect(fresh.specs[1].prompt.endsWith('\n\nPlease also cover logout')).toBe(true)
      expect(await thread()).toContainEqual({ kind: 'user_message', text: 'Please also cover logout' })
    })

    it('the digest says what the user answered', async () => {
      await pausedRun({ ask: true })
      const decision = await waitForPending()
      const fresh = new FakeRuntime(keepAlive, { rejectResume: true })
      const runner = makeRunner(fresh)

      await runner.answer(decision.id, { kind: 'option', index: 1, note: 'keep it small' }, 'thread')

      expect(fresh.specs[1].prompt).toContain('Asked the user: Which API? → New API (note: keep it small)')
      expect(fresh.specs[1].prompt.endsWith('\n\nAnswer: New API\nNote: keep it small')).toBe(true)
    })
  })
})

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeRequest } from '../permissions/policy'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { type RunSpec } from '../runtime/types'
import { TicketRunner } from './ticketRunner'

import { count, installRunnerHooks, keepAlive, makeRunner, permission, repos, thread, ticket, waitForPending, waitForThread, worktrees } from './ticketRunnerHarness'

installRunnerHooks()

describe('TicketRunner in unattended mode', () => {
  async function started(script: FakeStep[] = keepAlive): Promise<{ runner: TicketRunner; spec: RunSpec }> {
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime, worktrees, true)
    await runner.start(ticket.id)
    return { runner, spec: runtime.specs[0] }
  }

  it('allows a request the guard has no opinion on, records it in the thread, and saves no rule', async () => {
    const { spec } = await started()
    expect(await spec.onPermission(permission('npm install zod'))).toEqual({ allow: true })
    expect(await repos.decisions.pending(ticket.id)).toEqual([])
    expect(await thread()).toContainEqual({
      kind: 'notice',
      text: 'Allowed by unattended mode: Implementer wants to run `npm install zod`'
    })
    expect(await repos.allowRules.list(ticket.workspaceId)).toEqual([])
  })

  it('a request covered by an allow rule is allowed by the rule, with no notice', async () => {
    await repos.allowRules.add({ workspaceId: ticket.workspaceId, toolName: 'Bash', pattern: 'npm test *' })
    const { spec } = await started()
    expect(await spec.onPermission(permission('npm test -- login'))).toEqual({ allow: true })
    expect(count(await thread(), 'notice')).toBe(0)
  })

  it.each([
    ['a push', 'git push origin main'],
    ['a force-push', 'git push --force origin main'],
    ['a credentials read', 'cat ~/.npmrc'],
    ['a write outside the folder', 'rm -rf C:\\Users\\u\\x'],
    ['git config', 'git config user.name x']
  ])('%s still opens a card', async (_name, command) => {
    const { spec } = await started()
    void spec.onPermission(permission(command))
    const decision = await waitForPending()
    expect(decision).toMatchObject({ kind: 'permission', question: describeRequest(permission(command), 'Implementer') })
    expect(count(await thread(), 'notice')).toBe(0)
  })

  it("a write through $TEMP into the ticket's scratch folder is not a hard stop; one climbing out of it is", async () => {
    const { spec } = await started()
    const reviewer =
      'npm run typecheck > "$TEMP/tc.txt" 2>&1; echo TC=$? >> "$TEMP/tc.txt"; npm test > "$TEMP/test.txt" 2>&1'
    expect(await spec.onPermission(permission(reviewer))).toEqual({ allow: true })
    expect(await repos.decisions.pending(ticket.id)).toEqual([])

    void spec.onPermission(permission('echo hi > $TEMP/../x'))
    expect(await waitForPending()).toMatchObject({ kind: 'permission' })
  })

  it('denies a background command, with no card and no notice', async () => {
    const { spec } = await started()
    expect(await spec.onPermission({ ...permission('npm test'), input: { command: 'npm test', run_in_background: true } })).toMatchObject({ allow: false })
    expect(await repos.decisions.pending(ticket.id)).toEqual([])
    expect(count(await thread(), 'notice')).toBe(0)
  })

  it('allows an automatic guard reason without a card', async () => {
    const { spec } = await started()
    expect(await spec.onPermission(permission('git reset --hard'))).toEqual({ allow: true })
    expect(await repos.decisions.pending(ticket.id)).toEqual([])
  })

  it('a cd back to the worktree from a subfolder raises no hard stop; the same cd from the worktree itself does', async () => {
    const { spec } = await started()
    expect(await spec.onPermission({ ...permission('cd ../..'), cwd: path.join(spec.cwd, 'src', 'engine') })).toEqual({ allow: true })
    expect(await repos.decisions.pending(ticket.id)).toEqual([])

    void spec.onPermission(permission('cd ../..'))
    expect(await waitForPending()).toMatchObject({ kind: 'permission' })
  })

  it('without a usage gate a failed turn is only an error turn, as before', async () => {
    const runtime = new FakeRuntime([
      { emit: { kind: 'turn_end', ok: false, error: 'Claude AI usage limit reached' } },
      { waitForSend: true }
    ])
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await waitForThread((e) => e.kind === 'turn_end')
    expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'working' })
  })
})

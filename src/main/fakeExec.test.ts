import { describe, expect, it } from 'vitest'
import { resolveClaude } from '../engine/runtime/resolveClaude'
import { fakeClaudeExec } from './fakeExec'

describe('fakeClaudeExec', () => {
  it('makes setup.check ok without a real claude', async () => {
    expect(await resolveClaude(fakeClaudeExec)).toMatchObject({ ok: true, version: '0.0.0' })
    expect(await resolveClaude(fakeClaudeExec, 'linux')).toMatchObject({ ok: true })
  })
})

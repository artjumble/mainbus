import { describe, expect, it } from 'vitest'
import { checkTestCommands, SETUP_COMMAND_MAX, TEST_COMMANDS_MAX, type TestCommand } from './domain'

const ok: TestCommand = { name: 'Unit', command: 'npx vitest run --reporter=json --outputFile=<results>', format: 'vitest-json' }

describe('checkTestCommands', () => {
  it('accepts an empty list, which turns the feature off', () => {
    expect(checkTestCommands([])).toEqual({ ok: true, commands: [] })
  })

  it('trims the name and the command', () => {
    expect(checkTestCommands([{ ...ok, name: '  Unit ', command: `  ${ok.command}  ` }])).toEqual({ ok: true, commands: [ok] })
  })

  it('accepts a plain command without a results placeholder', () => {
    expect(checkTestCommands([{ name: 'E2E', command: 'npm run e2e', format: 'plain' }]).ok).toBe(true)
  })

  it('refuses a structured format without <results>, saying where it goes', () => {
    const r = checkTestCommands([{ name: 'Unit', command: 'npx vitest run', format: 'vitest-json' }])
    expect(r).toMatchObject({ ok: false })
    expect(r.ok ? '' : r.reason).toContain('<results>')
  })

  it.each([
    ['an empty name', { ...ok, name: ' ' }],
    ['a long name', { ...ok, name: 'x'.repeat(61) }],
    ['an empty command', { ...ok, command: ' ' }],
    ['a command of two lines', { ...ok, command: 'a\nb <results>' }],
    ['a command that is too long', { ...ok, command: `${'x'.repeat(SETUP_COMMAND_MAX)} <results>` }],
    ['an unknown format', { ...ok, format: 'tap' as never }]
  ])('refuses %s', (_label, command) => {
    expect(checkTestCommands([command]).ok).toBe(false)
  })

  it('refuses names that differ only in case, and too many commands', () => {
    expect(checkTestCommands([ok, { ...ok, name: 'unit' }]).ok).toBe(false)
    const many = Array.from({ length: TEST_COMMANDS_MAX + 1 }, (_, i) => ({ ...ok, name: `c${i}` }))
    expect(checkTestCommands(many).ok).toBe(false)
  })
})

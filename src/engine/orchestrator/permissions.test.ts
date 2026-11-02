import { describe, expect, test } from 'vitest'
import { ORCHESTRATOR_DENIED, orchestratorVerdict } from './permissions'

const CWD = 'C:\\Users\\x\\AppData\\Local\\Mainbus\\orchestrator'
const REPO = 'C:\\code\\repo'
const verdict = (tool: string, input: Record<string, unknown>) => orchestratorVerdict(tool, input, { cwd: CWD, repo: REPO })

describe('orchestratorVerdict', () => {
  test.each([
    ['Read', { file_path: `${REPO}\\src\\index.ts` }],
    ['Read', { file_path: 'notes.md' }],
    ['Grep', { pattern: 'TODO', path: `${REPO}\\src` }],
    ['Grep', { pattern: 'TODO' }],
    ['Glob', { pattern: '**/*.ts', path: REPO }],
    ['Glob', { pattern: '*.md' }],
    ['mcp__mainbus__list_workspaces', {}],
    ['mcp__mainbus__list_tickets', { column: 'ready' }],
    ['mcp__mainbus__get_ticket', { number: 1 }],
    ['mcp__mainbus__get_run_status', { number: 1 }],
    ['mcp__mainbus__get_recent_events', { number: 1 }],
    ['mcp__mainbus__list_pending_decisions', {}]
  ])('allows %s %j', (tool, input) => {
    expect(verdict(tool, input)).toEqual({ allow: true })
  })

  test.each([
    ['Read', { file_path: `${REPO}\\.env` }],
    ['Read', { file_path: 'C:\\Users\\x\\.ssh\\id_rsa' }],
    ['Read', { file_path: 'C:\\Users\\x\\.claude\\.credentials.json' }],
    ['Grep', { pattern: 'KEY', path: `${REPO}\\.env` }],
    ['Grep', { pattern: 'KEY', path: REPO, glob: '.env*' }],
    ['Glob', { pattern: '**/.env', path: REPO }]
  ])('denies the credential file in %s %j', (tool, input) => {
    const v = verdict(tool, input)
    expect(v.allow).toBe(false)
    if (!v.allow) expect(v.message).toMatch(/^Reads a credentials file/)
  })

  test('denies reads outside its folder and the repo', () => {
    const v = verdict('Read', { file_path: 'C:\\code\\other\\README.md' })
    expect(v.allow).toBe(false)
    if (!v.allow) expect(v.message).toContain(ORCHESTRATOR_DENIED)
  })

  test.each([
    ['Write', { file_path: `${REPO}\\x.ts`, content: '' }],
    ['Edit', { file_path: `${REPO}\\x.ts`, old_string: 'a', new_string: 'b' }],
    ['Bash', { command: 'ls' }],
    ['PowerShell', { command: 'ls' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['WebSearch', { query: 'x' }],
    ['Task', { prompt: 'x' }],
    ['Agent', { prompt: 'x' }],
    ['AskUserQuestion', { questions: [] }],
    ['mcp__mainbus__handoff', { summary: 'x' }],
    ['mcp__other__tool', {}]
  ])('denies %s without a card', (tool, input) => {
    expect(verdict(tool, input)).toEqual({ allow: false, message: ORCHESTRATOR_DENIED })
  })
})

import { describe, expect, test } from 'vitest'
import type { AllowRule } from '../../shared/domain'
import { BACKGROUND_DENIED, describeRequest, isAllowed, isBackgroundShell, isDestructivePush, requestParts, rulesFromRequest } from './policy'

const rule = (toolName: string, pattern: string | null): AllowRule => ({
  id: 'r1',
  workspaceId: 'w1',
  toolName,
  pattern,
})
const bash = (command: string) => ({ toolName: 'Bash', input: { command } })
/** The single rule "Always allow" saves for a request that is not a chain. */
const ruleFromRequest = (...args: Parameters<typeof rulesFromRequest>) => {
  const rules = rulesFromRequest(...args)
  expect(rules).toHaveLength(1)
  return rules[0]
}

describe('ruleFromRequest', () => {
  test('PowerShell tool rules behave like Bash', () => {
    const req = { toolName: 'PowerShell', input: { command: 'npm install zod' } }
    expect(ruleFromRequest('w1', req)).toEqual({
      workspaceId: 'w1',
      toolName: 'PowerShell',
      pattern: 'npm install *',
    })
    const rules = [rule('PowerShell', 'npm install *')]
    expect(isAllowed(rules, req)).toBe(true)
    expect(isAllowed(rules, { toolName: 'PowerShell', input: { command: 'npm install zod; Remove-Item x' } })).toBe(
      false,
    )
    expect(isAllowed(rules, { toolName: 'Bash', input: { command: 'npm install zod' } })).toBe(false)
  })

  test('Bash rule generalises arguments after the subcommand', () => {
    expect(ruleFromRequest('w1', bash('pnpm install left-pad')).pattern).toBe('pnpm install *')
    expect(ruleFromRequest('w1', bash('git status')).pattern).toBe('git status *')
    expect(ruleFromRequest('w1', bash('ls -la')).pattern).toBe('ls *')
    expect(ruleFromRequest('w1', bash('  ls  ')).pattern).toBe('ls *')
  })

  test('non-Bash rule allows the whole tool', () => {
    const r = ruleFromRequest('w1', { toolName: 'WebFetch', input: { url: 'https://example.com' } })
    expect(r).toEqual({ workspaceId: 'w1', toolName: 'WebFetch', pattern: null })
    expect(isAllowed([rule('WebFetch', null)], { toolName: 'WebFetch', input: { url: 'https://other.example' } })).toBe(
      true,
    )
    expect(isAllowed([rule('WebFetch', null)], { toolName: 'WebSearch', input: {} })).toBe(false)
  })
})

describe('isAllowed', () => {
  test('matches by prefix with a trailing wildcard', () => {
    const rules = [rule('Bash', 'pnpm install *')]
    expect(isAllowed(rules, bash('pnpm install zod'))).toBe(true)
    expect(isAllowed(rules, bash('pnpm install'))).toBe(true)
    expect(isAllowed(rules, bash('pnpm run x'))).toBe(false)
    expect(isAllowed(rules, bash('pnpm installer'))).toBe(false)
    expect(isAllowed([], bash('pnpm install zod'))).toBe(false)
  })

  test('force-pushes are never auto-allowed', () => {
    const rules = [rule('Bash', 'git push *'), rule('Bash', null)]
    expect(isAllowed(rules, bash('git push origin x'))).toBe(true)
    expect(isAllowed([rule('Bash', 'git push *')], bash('git push --force origin x'))).toBe(false)
    expect(isAllowed(rules, bash('git push --force origin x'))).toBe(false)
    expect(isAllowed(rules, bash('git push -f'))).toBe(false)
    expect(isAllowed(rules, bash('git push --force-with-lease'))).toBe(false)
    expect(isAllowed(rules, bash('git push origin +main'))).toBe(false)
    expect(isAllowed(rules, bash('"C:\\Program Files\\Git\\cmd\\git.exe" push -f'))).toBe(false)
    expect(isAllowed(rules, bash('git add . && git push --force'))).toBe(false)
  })

  test('chained commands are never auto-allowed', () => {
    const rules = [rule('Bash', 'pnpm install *')]
    expect(isAllowed(rules, bash('pnpm install x && rm -rf /'))).toBe(false)
    expect(isAllowed(rules, bash('pnpm install x || rm -rf /'))).toBe(false)
    expect(isAllowed(rules, bash('pnpm install x; rm -rf /'))).toBe(false)
    expect(isAllowed(rules, bash('pnpm install x | sh'))).toBe(false)
    expect(isAllowed(rules, bash('pnpm install x\nrm -rf /'))).toBe(false)
    expect(isAllowed(rules, bash('pnpm install x\r\nrm -rf /'))).toBe(false)
  })

  test('a null pattern allows any input for that tool', () => {
    expect(isAllowed([rule('Bash', null)], bash('anything at all && more'))).toBe(true)
  })

  test('a shell input without a command string is not allowed by a pattern rule', () => {
    expect(isAllowed([rule('Bash', 'ls *')], { toolName: 'Bash', input: {} })).toBe(false)
  })
})

describe('requestParts', () => {
  const none = { command: null, path: null, input: null }

  test('Bash and PowerShell keep the command', () => {
    expect(requestParts(bash('ls\npwd'), 'Implementer', 'why')).toEqual({ ...none, role: 'Implementer', tool: 'Bash', command: 'ls\npwd', reason: 'why' })
    expect(requestParts({ toolName: 'PowerShell', input: { command: 'Get-Date' } }, 'Reviewer', undefined)).toEqual({
      ...none,
      role: 'Reviewer',
      tool: 'PowerShell',
      command: 'Get-Date',
      reason: null
    })
  })

  test('file tools keep the path and the input', () => {
    const input = { file_path: 'C:/w/a.ts', content: 'x' }
    expect(requestParts({ toolName: 'Write', input }, 'Implementer', undefined)).toEqual({ ...none, role: 'Implementer', tool: 'Write', path: 'C:/w/a.ts', input, reason: null })
    expect(requestParts({ toolName: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }, 'Implementer', undefined).path).toBe('n.ipynb')
  })

  test('other tools keep the input', () => {
    expect(requestParts({ toolName: 'WebFetch', input: { url: 'https://x.dev' } }, 'Planner', undefined)).toEqual({
      ...none,
      role: 'Planner',
      tool: 'WebFetch',
      input: { url: 'https://x.dev' },
      reason: null
    })
  })
})

describe('describeRequest', () => {
  test('Bash', () => {
    expect(describeRequest(bash('pnpm install left-pad'), 'Implementer')).toBe(
      'Implementer wants to run `pnpm install left-pad`',
    )
  })

  test('PowerShell', () => {
    expect(describeRequest({ toolName: 'PowerShell', input: { command: 'Get-Date' } }, 'Reviewer')).toBe(
      'Reviewer wants to run `Get-Date`',
    )
  })

  test('file tools', () => {
    for (const toolName of ['Write', 'Edit', 'MultiEdit']) {
      expect(describeRequest({ toolName, input: { file_path: 'C:\\w\\a.ts' } }, 'Implementer')).toBe(
        'Implementer wants to edit `C:\\w\\a.ts`',
      )
    }
    expect(describeRequest({ toolName: 'NotebookEdit', input: { notebook_path: 'C:\\w\\n.ipynb' } }, 'Implementer')).toBe(
      'Implementer wants to edit `C:\\w\\n.ipynb`',
    )
  })

  test('anything else', () => {
    expect(describeRequest({ toolName: 'WebFetch', input: {} }, 'Implementer')).toBe('Implementer wants to use WebFetch')
  })
})

describe('fail-closed policy', () => {
  const prefix = (p: string) => [rule('Bash', p)]

  test('opaque commands are never allowed by any rule', () => {
    const rules = [rule('Bash', null), rule('Bash', 'pnpm install *'), rule('Bash', 'pnpm install $(x)')]
    for (const c of [
      'pnpm install $(rm -rf ~)',
      'pnpm install `x`',
      'pnpm install x & rm y',
      '(pnpm install x)',
      'bash -c "pnpm install x"',
      'echo "unbalanced',
    ]) {
      expect(isAllowed(rules, bash(c))).toBe(false)
    }
    expect(isAllowed([rule('Bash', '=bash -c "x"')], bash('bash -c "x"'))).toBe(false)
    expect(isAllowed([rule('Bash', '=node -e "x"'), rule('Bash', null)], bash('node -e "x"'))).toBe(false)
    expect(isAllowed([rule('Bash', 'python *')], bash('python -c "x"'))).toBe(false)
  })

  test('pattern rules do not match commands with a redirect, $ or &', () => {
    expect(isAllowed(prefix('git status *'), bash('git status > C:\\Users\\u\\.gitconfig'))).toBe(false)
    expect(isAllowed(prefix('echo *'), bash('echo $HOME'))).toBe(false)
    expect(isAllowed(prefix('git status *'), bash('git status'))).toBe(true)
  })

  test('destructive pushes are never allowed, including abbreviated options', () => {
    const rules = [rule('Bash', 'git push *'), rule('Bash', null)]
    for (const c of [
      'git push --force-w',
      'git push --f',
      'git push --fo origin x',
      'git push --force-with-lease=main:abc',
      'git push --force-if-includes',
      'git push --mirror',
      'git push --delete origin x',
      'git push -d origin x',
      'git push --prune origin',
      'git push -fu origin x',
      'git push origin :old',
      'git push origin +main',
      'git -C sub push -f',
      'git --git-dir x push --force',
    ]) {
      expect(isDestructivePush(c), c).toBe(true)
      expect(isAllowed(rules, bash(c)), c).toBe(false)
    }
    for (const c of ['git push origin main', 'git push -u origin x', 'git status', 'git push --follow-tags']) {
      expect(isDestructivePush(c), c).toBe(false)
    }
    expect(isDestructivePush('(git push -f)')).toBe(true)
    expect(isAllowed([rule('Bash', 'git push *')], bash('git push origin mainbus/1-x'))).toBe(true)
  })

  test('exact rules match only their own command', () => {
    const rules = prefix('=node scripts/x.js --flag')
    expect(isAllowed(rules, bash('node scripts/x.js --flag'))).toBe(true)
    expect(isAllowed(rules, bash('node  scripts/x.js   --flag'))).toBe(true)
    expect(isAllowed(rules, bash('node scripts/y.js --flag'))).toBe(false)
    expect(isAllowed(rules, bash('node scripts/x.js --flag y'))).toBe(false)
    expect(isAllowed(rules, bash('node'))).toBe(false)
  })

  test('ruleFromRequest returns exact rules for interpreters and wrappers', () => {
    expect(ruleFromRequest('w1', bash('node -e "x"')).pattern).toBe('=node -e "x"')
    expect(ruleFromRequest('w1', bash('cmd /c npm test')).pattern).toBe('=cmd /c npm test')
    expect(ruleFromRequest('w1', bash('python3 x.py')).pattern).toBe('=python3 x.py')
    expect(ruleFromRequest('w1', bash('npx   vitest run')).pattern).toBe('=npx vitest run')
    expect(ruleFromRequest('w1', bash('pnpm dlx create-x')).pattern).toBe('=pnpm dlx create-x')
    expect(ruleFromRequest('w1', bash('git -C sub status')).pattern).toBe('=git -C sub status')
    expect(ruleFromRequest('w1', bash('echo $HOME')).pattern).toBe('=echo $HOME')
    expect(ruleFromRequest('w1', bash('git status > out.txt')).pattern).toBe('=git status > out.txt')
    expect(ruleFromRequest('w1', bash('a & b')).pattern).toBe('=a & b')
  })

  test('an exact rule for a command ending in a glob never turns into a prefix rule', () => {
    const r = ruleFromRequest('w1', bash('git checkout -f main *'), { exact: true })
    expect(r.pattern).toBe('=git checkout -f main *')
    const rules = [rule('Bash', r.pattern)]
    expect(isAllowed(rules, bash('git checkout -f main *'))).toBe(true)
    expect(isAllowed(rules, bash('git checkout -f main other'))).toBe(false)
    expect(isAllowed(rules, bash('git checkout -f main'))).toBe(false)
  })

  test('a pattern is either =exact, or a prefix ending in " *"; nothing else matches', () => {
    expect(isAllowed([rule('Bash', 'pnpm install')], bash('pnpm install'))).toBe(false)
    expect(isAllowed([rule('Bash', '=pnpm install')], bash('pnpm install'))).toBe(true)
    expect(isAllowed([rule('Bash', '=pnpm install')], bash('pnpm install zod'))).toBe(false)
    expect(isAllowed([rule('Bash', '=pnpm install *')], bash('pnpm install zod'))).toBe(false)
  })

  test('a command whose first token starts with = gets an exact rule, never a prefix rule', () => {
    const r = ruleFromRequest('w1', bash('=x run it'))
    expect(r.pattern).toBe('==x run it')
    expect(r.pattern?.endsWith(' *')).toBe(false)
    expect(isAllowed([rule('Bash', '=x run it *')], bash('=x run it now'))).toBe(false)
  })

  test('runners and stdin interpreters are never allowed, even with a null rule', () => {
    const rules = [rule('Bash', null), rule('Bash', 'npx *'), rule('Bash', '=npx node -e "1"')]
    expect(isAllowed(rules, bash('npx node -e "1"'))).toBe(false)
    expect(isAllowed(rules, bash('echo 1 | node'))).toBe(false)
    expect(isAllowed(rules, bash('python "-cimport os"'))).toBe(false)
    expect(isAllowed([rule('Bash', 'npx *')], bash('npx vitest run'))).toBe(true)
  })

  test('opts.exact forces an exact rule', () => {
    expect(ruleFromRequest('w1', bash('pnpm install left-pad'), { exact: true }).pattern).toBe('=pnpm install left-pad')
    expect(ruleFromRequest('w1', bash('pnpm install left-pad'), { exact: false }).pattern).toBe('pnpm install *')
  })

  test('ordinary commands still generalise', () => {
    expect(ruleFromRequest('w1', bash('npm test')).pattern).toBe('npm test *')
    expect(ruleFromRequest('w1', bash('git commit -m "fix; x"')).pattern).toBe('git commit *')
  })

  test('prefix rules still allow quoted separators in arguments', () => {
    expect(isAllowed(prefix('git commit *'), bash('git commit -m "fix; x"'))).toBe(true)
  })
})

describe('chains', () => {
  test('Always allow on a chain saves a prefix rule for each command in it', () => {
    expect(rulesFromRequest('w1', bash('git add -A && git commit -m "x; y"')).map((r) => r.pattern)).toEqual([
      'git add *',
      'git commit *',
    ])
    expect(rulesFromRequest('w1', bash('npm test; npm test -- --run | tail -5')).map((r) => r.pattern)).toEqual([
      'npm test *',
      'tail *',
    ])
  })

  test('a chain with any command that needs an exact rule saves one exact rule', () => {
    for (const c of ['npm test && node x.js', 'git add . && git -C sub commit', 'ls && echo $HOME', 'ls > out.txt && ls', 'ls & ls']) {
      expect(rulesFromRequest('w1', bash(c)).map((r) => r.pattern), c).toEqual([`=${c}`])
    }
  })

  test('a chain is allowed only when every command in it is covered', () => {
    const rules = [rule('Bash', 'git add *'), rule('Bash', 'git commit *'), rule('Bash', 'npm test *')]
    expect(isAllowed(rules, bash('git add -A && git commit -m "fix; x"'))).toBe(true)
    expect(isAllowed(rules, bash('npm test || git add .'))).toBe(true)
    expect(isAllowed(rules, bash('git add -A && git commit -m x && git push'))).toBe(false)
    expect(isAllowed(rules, bash('git add -A && rm -rf x'))).toBe(false)
    expect(isAllowed(rules, bash('git add -A | sh'))).toBe(false)
    expect(isAllowed(rules, bash('git add -A && git commit -m x > log.txt'))).toBe(false)
    expect(isAllowed(rules, bash('git add $X && git commit -m x'))).toBe(false)
    expect(isAllowed(rules, bash('git add -A & git commit -m x'))).toBe(false)
    expect(isAllowed(rules, bash('git add -A && sudo git commit -m x'))).toBe(false)
  })

  test('a prefix rule matches whole words, not part of one', () => {
    expect(isAllowed([rule('Bash', 'git add *')], bash('git adder x'))).toBe(false)
    expect(isAllowed([rule('Bash', 'git add *')], bash('git add'))).toBe(true)
  })

  test('the rules saved for a chain allow that chain again', () => {
    const c = 'git add -A && git commit -m "first"'
    const saved = rulesFromRequest('w1', bash(c)).map((r, i) => ({ ...r, id: `r${i}` }))
    expect(isAllowed(saved, bash(c))).toBe(true)
    expect(isAllowed(saved, bash('git add src && git commit -m "second"'))).toBe(true)
  })

  // Fake paths only: nothing here reads a file.
  test('no rule, prefix, exact or tool-wide, allows reading or printing credentials', () => {
    const pwsh = (command: string) => ({ toolName: 'PowerShell', input: { command } })
    const cases = [
      bash('cat ~/.npmrc | grep -v token'),
      bash('cat .env'),
      bash('npm config get //registry.npmjs.org/:_authToken'),
      bash('gh auth token'),
      bash('printenv'),
      pwsh('Get-Content $env:USERPROFILE\\.npmrc'),
      pwsh('Get-ChildItem env:'),
    ]
    for (const req of cases) {
      const saved = [...rulesFromRequest('w1', req), ...rulesFromRequest('w1', req, { exact: true })]
      const rules = [...saved, rule(req.toolName, null)].map((r, i) => ({ ...r, id: `r${i}` }))
      expect(saved.some((r) => r.pattern?.startsWith('=')), req.input.command).toBe(true)
      expect(isAllowed(rules, req), req.input.command).toBe(false)
    }
    for (const [toolName, input] of [
      ['Read', { file_path: '.env' }],
      ['Grep', { pattern: 'x', path: 'C:\\Users\\u\\.npmrc' }],
      ['Glob', { pattern: '**/*.pem' }],
    ] as const) {
      expect(isAllowed([rule(toolName, null)], { toolName, input }), toolName).toBe(false)
    }
    // The same rules still allow ordinary reads.
    expect(isAllowed([rule('Bash', 'cat *')], bash('cat .env.example'))).toBe(true)
    expect(isAllowed([rule('Read', null)], { toolName: 'Read', input: { file_path: 'src/a.ts' } })).toBe(true)
  })
})

// Fake worktree paths only: nothing here touches the disk.
describe('commands agents really run', () => {
  const wt = 'C:\\Users\\u\\AppData\\Local\\Mainbus\\work\\repo\\4-ticket'
  const folders = { worktree: wt, additionalDirectories: [] }
  const prefix = (p: string) => [rule('Bash', p)]
  const saved = (command: string) =>
    rulesFromRequest('w1', bash(command), { folders }).map((r, i) => ({ ...r, id: `r${i}` }))
  const patterns = (command: string) => saved(command).map((r) => r.pattern)

  test('stream duplications and redirects to null neither stop nor take part in prefix rules', () => {
    expect(patterns('npm test 2>&1 | tail -15')).toEqual(['npm test *', 'tail *'])
    for (const c of [
      'git status 2>&1',
      'git status 1>&2',
      'git status >&2',
      'git status &>/dev/null',
      'git status >/dev/null',
      'git status 2>/dev/null',
      'git status >nul',
      'git status 2>NUL',
      'git status >$null',
      'git status 2>$null',
      'git status 2>&1 >/dev/null',
    ]) {
      expect(patterns(c), c).toEqual(['git status *'])
      expect(isAllowed(prefix('git status *'), bash(c)), c).toBe(true)
    }
    const pwsh = { toolName: 'PowerShell', input: { command: 'git status 2>$null' } }
    expect(isAllowed([rule('PowerShell', 'git status *')], pwsh)).toBe(true)
  })

  test('redirects to files, a lone &, and $ anywhere but a null target still need an exact rule', () => {
    const rules = [...prefix('git status *'), ...prefix('echo *'), ...prefix('ls *')]
    for (const c of [
      'git status 2>&1 > out.txt',
      'git status 2> err.txt',
      'git status >&out.txt',
      'git status &> out.txt',
      'git status 2>&1 & ls',
      'echo $null',
      'git status > $HOME',
      'git status >"$nulls"',
      'echo "a&b"',
    ]) {
      expect(patterns(c), c).toEqual([`=${c}`])
      expect(isAllowed(rules, bash(c)), c).toBe(false)
    }
  })

  test('after one Always allow, the next test run with a different tail raises no card', () => {
    const rules = [...saved('npm test 2>&1 | tail -15'), rule('Bash', 'grep *'), rule('Bash', 'head *')]
    expect(isAllowed(rules, bash(`cd "${wt}" && npm test 2>&1 | grep -E "FAIL|Error" | head -20`), folders)).toBe(true)
    expect(isAllowed(rules, bash('npm test 2>&1 | tail -40'), folders)).toBe(true)
  })

  test('a cd into the ticket folder needs no rule and saves none', () => {
    const fwd = wt.replace(/\\/g, '/')
    const gitBash = `/c/${fwd.slice(3)}`
    for (const c of [
      `cd "${wt}" && npm test`,
      `cd ${fwd} && npm test`,
      `cd "${gitBash}" && npm test`,
      `cd "${wt.toLowerCase()}" && npm test`,
      `cd "${wt}\\src\\engine" && npm test`,
      `cd src && npm test`,
      `pushd "${wt}" && npm test`,
      `chdir "${wt}" && npm test`,
    ]) {
      expect(isAllowed([rule('Bash', 'npm test *')], bash(c), folders), c).toBe(true)
      expect(patterns(c), c).toEqual(['npm test *'])
    }
    for (const c of [`Set-Location "${wt}"; npm test`, `Set-Location -Path "${wt}"; npm test`, `sl ${wt}; npm test`]) {
      const req = { toolName: 'PowerShell', input: { command: c } }
      expect(isAllowed([rule('PowerShell', 'npm test *')], req, folders), c).toBe(true)
      expect(rulesFromRequest('w1', req, { folders }).map((r) => r.pattern), c).toEqual(['npm test *'])
    }
    // Only a cd into the folder: allowed with no rule at all, and nothing to save.
    expect(isAllowed([], bash(`cd "${wt}"`), folders)).toBe(true)
    expect(patterns(`cd "${wt}"`)).toEqual([])
  })

  test('a cd anywhere else is part of the chain', () => {
    const rules = [rule('Bash', 'npm test *')]
    for (const c of [
      'cd C:\\Users\\u\\other && npm test',
      `cd "${wt}\\.." && npm test`,
      'cd ~ && npm test',
      'cd && npm test',
      'cd .. && npm test',
    ]) {
      expect(isAllowed(rules, bash(c), folders), c).toBe(false)
    }
    expect(patterns('cd C:\\Users\\u\\other && npm test')).toEqual(['cd C:\\Users\\u\\other *', 'npm test *'])
    // Without the ticket's folders (a guarded request), a cd is never transparent.
    expect(isAllowed(rules, bash(`cd "${wt}" && npm test`))).toBe(false)
  })
})

describe('isBackgroundShell', () => {
  test('is true only for a Bash or PowerShell call with run_in_background: true', () => {
    expect(isBackgroundShell('Bash', { command: 'npm test', run_in_background: true })).toBe(true)
    expect(isBackgroundShell('PowerShell', { command: 'npm test', run_in_background: true })).toBe(true)
    expect(isBackgroundShell('Bash', { command: 'npm test' })).toBe(false)
    expect(isBackgroundShell('Bash', { command: 'npm test', run_in_background: false })).toBe(false)
    expect(isBackgroundShell('Read', { run_in_background: true })).toBe(false)
  })

  test('its message tells the agent to use the foreground', () => {
    expect(BACKGROUND_DENIED).toMatch(/^Run this in the foreground instead/)
  })
})

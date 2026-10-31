import { describe, expect, test } from 'vitest'
import type { AllowRule } from '../../shared/domain'
import { describeRequest, isAllowed, isDestructivePush, rulesFromRequest } from './policy'

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
    expect(isAllowed(prefix('git status *'), bash('git status 2>&1'))).toBe(false)
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
})

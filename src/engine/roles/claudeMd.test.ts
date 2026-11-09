import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

// The repo's CLAUDE.md reaches every role (they run with the project's settings), so the commands it gives must exist.
const root = path.join(import.meta.dirname, '..', '..', '..')
const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

// pnpm's own commands, which aren't package.json scripts.
const PNPM_COMMANDS = new Set(['install', 'exec', 'run'])
// The package each binary CLAUDE.md runs with `pnpm exec` comes from.
const BIN_PACKAGES: Record<string, string> = { vitest: 'vitest', playwright: '@playwright/test' }

function words(pattern: RegExp): string[] {
  return [...claudeMd.matchAll(pattern)].map((m) => m[1]!)
}

describe("the repo's CLAUDE.md", () => {
  test('names only scripts that package.json has', () => {
    const scripts = [...words(/\bpnpm (?!run\b|exec\b)([\w:-]+)/g), ...words(/\bpnpm run ([\w:-]+)/g)]
    expect(scripts).toContain('typecheck')
    for (const name of scripts.filter((s) => !PNPM_COMMANDS.has(s))) {
      expect(pkg.scripts, `pnpm ${name}`).toHaveProperty([name])
    }
  })

  test('runs with pnpm exec only binaries from packages in its dependencies', () => {
    const bins = words(/\bpnpm exec ([\w@/-]+)/g)
    expect(new Set(bins)).toEqual(new Set(['vitest', 'playwright']))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const bin of bins) {
      expect(BIN_PACKAGES, bin).toHaveProperty([bin])
      expect(deps, bin).toHaveProperty([BIN_PACKAGES[bin]!])
    }
  })

  test('names no npm or npx commands', () => {
    expect(claudeMd).not.toMatch(/(?<![\w-])npm /)
    expect(claudeMd).not.toMatch(/(?<![\w-])npx /)
  })

  test('tells agents to run related tests while working and leave the full suites to the Reviewer', () => {
    expect(claudeMd).toContain('pnpm exec vitest related <the source files you changed> --run')
    expect(claudeMd).toContain('pnpm exec playwright test e2e/<spec>.spec.ts')
    expect(claudeMd).toContain('The Reviewer runs the full suites.')
  })
})

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkReportsFolder } from '../../shared/domain'
import { runCommand } from './command'
import { runGit } from './git'
import { investigationTitle, ReportFileSaver, reportDate, reportFilePath, reportFileText } from './reportFiles'

const AT = '2026-11-06T09:00:00.000Z'

describe('checkReportsFolder', () => {
  it.each([
    ['docs/investigations', 'docs/investigations'],
    [' docs\\investigations\\ ', 'docs/investigations'],
    ['./notes//reports/.', 'notes/reports'],
    ['reports', 'reports'],
    ['..x/y', '..x/y']
  ])('keeps %j inside the repo as %j', (input, folder) => {
    expect(checkReportsFolder(input)).toEqual({ ok: true, folder })
  })

  it.each([
    ['', /Give a folder/],
    ['.', /Give a folder/],
    ['../outside', /stay inside the repository/],
    ['docs/../../outside', /stay inside the repository/],
    ['C:\\reports', /relative to the repository/],
    ['c:reports', /relative to the repository/],
    ['/etc/reports', /relative to the repository/],
    ['\\\\server\\share', /relative to the repository/],
    ['.git/hooks', /inside \.git/],
    ['docs/.GIT', /inside \.git/],
    ['docs/what?', /character/],
    ['docs/trailing. ', /can't end with a space or a dot/]
  ])('refuses %j', (input, reason) => {
    const checked = checkReportsFolder(input)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.reason).toMatch(reason)
  })
})

describe('the report file', () => {
  const ticket = {
    number: 73,
    title: 'Why  is login\nslow?',
    intent: [
      { text: 'Find out why login is slow.\nIt takes ages.', at: AT },
      { text: 'An agent wrote this', at: AT, source: { kind: 'agent' as const, agent: 'x', cwd: '/x' } },
      { text: 'Also check the cache', at: AT }
    ]
  }

  it('is named <folder>/<date>-<n>-<slug>.md, and a refused folder throws', () => {
    expect(reportFilePath('docs/investigations', ticket, '2026-11-06')).toBe('docs/investigations/2026-11-06-73-why-is-login-slow.md')
    expect(reportFilePath('notes\\', ticket, '2026-11-06')).toBe('notes/2026-11-06-73-why-is-login-slow.md')
    expect(() => reportFilePath('../x', ticket, '2026-11-06')).toThrow(/inside the repository/)
  })

  it('is dated in local time', () => {
    expect(reportDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('starts with a short header of the ticket, the date and only the user\'s own words, then the report exactly', () => {
    const report = '# Findings\n\n> quoted\n\nThe cause is X.'
    expect(reportFileText(ticket, report, '2026-11-06')).toBe(
      [
        '> **Investigation #73:** Why is login slow?',
        "> **Date:** 2026-11-06 · **Status:** report, recommends but doesn't authorise changes",
        "> **The question (the user's words):** Find out why login is slow.",
        '> It takes ages.',
        '> ',
        '> Also check the cache',
        '',
        report,
        ''
      ].join('\n')
    )
    // A report that already ends in a newline gets no second one.
    expect(reportFileText(ticket, 'R\n', '2026-11-06').endsWith('\n\nR\n')).toBe(true)
  })

  it('is committed as "Investigation #<n>: <title>"', () => {
    expect(investigationTitle(ticket)).toBe('Investigation #73: Why is login slow?')
  })
})

describe('ReportFileSaver', () => {
  let tmp: string
  let repo: string

  async function git(args: string[], cwd = repo): Promise<string> {
    const r = await runGit(args, cwd)
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-report-file-'))
    repo = path.join(tmp, 'repo')
    await fs.mkdir(repo)
    await git(['init', '-b', 'main'])
    await git(['config', 'user.name', 'Report Author'])
    await git(['config', 'user.email', 'author@example.com'])
    await git(['commit', '--allow-empty', '-m', 'initial'])
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
  })

  const saver = () => new ReportFileSaver(runCommand)
  const input = (content: string) => ({ worktreePath: repo, relPath: 'docs/investigations/r.md', content, message: 'Investigation #1: X' })

  it('writes the file, creating its folder, and commits only it with the repo\'s identity', async () => {
    await fs.writeFile(path.join(repo, 'other.txt'), 'untouched\n')
    await git(['add', 'other.txt'])
    const result = await saver().save(input('# One\n'))
    expect(result).toEqual({ ok: true, commit: (await git(['rev-parse', 'HEAD'])).trim() })
    expect(await git(['log', '-1', '--format=%s|%an'])).toBe('Investigation #1: X|Report Author\n')
    expect((await git(['show', '--name-only', '--format='])).trim()).toBe('docs/investigations/r.md')
    // What was staged before is still staged, and not committed.
    expect((await git(['status', '--porcelain'])).trim()).toBe('A  other.txt')
  })

  it('overwrites the file in a new commit, even when nothing in it changed', async () => {
    const first = await saver().save(input('# One\n'))
    const second = await saver().save(input('# Two\n'))
    const third = await saver().save(input('# Two\n'))
    expect(first.ok && second.ok && third.ok).toBe(true)
    expect((await git(['log', '--format=%s'])).trim().split('\n')).toHaveLength(4)
    expect(await git(['show', 'HEAD:docs/investigations/r.md'])).toBe('# Two\n')
  })

  it('refuses a path outside the repository, and one through a link out of it', async () => {
    expect(await saver().save({ ...input('x'), relPath: '../escape.md' })).toEqual({ ok: false, reason: '../escape.md is outside the repository' })
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    let linked = true
    await fs.symlink(outside, path.join(repo, 'docs-link'), 'junction').catch(() => {
      linked = false
    })
    if (linked) {
      expect(await saver().save({ ...input('x'), relPath: 'docs-link/r.md' })).toEqual({ ok: false, reason: 'docs-link/r.md is outside the repository' })
      expect(await fs.readdir(outside)).toEqual([])
    }
  })

  it('says why when git fails, and when the folder is gone', async () => {
    // A folder the repo ignores: git refuses to add the file, and Mainbus doesn't force it.
    await fs.writeFile(path.join(repo, '.gitignore'), 'docs/\n')
    const ignored = await saver().save(input('x'))
    expect(ignored.ok).toBe(false)
    if (!ignored.ok) expect(ignored.reason).toMatch(/^git add failed: .*ignored/)

    const gone = await new ReportFileSaver(runCommand).save({ ...input('x'), worktreePath: path.join(tmp, 'missing') })
    expect(gone).toEqual({ ok: false, reason: "the ticket's folder is missing" })
  })

  it('says why when the file cannot be written', async () => {
    // A folder where the file should go.
    await fs.mkdir(path.join(repo, 'docs', 'investigations', 'r.md'), { recursive: true })
    const result = await saver().save(input('x'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/^the file could not be written: /)
  })
})

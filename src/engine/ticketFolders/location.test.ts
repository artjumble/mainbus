import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../git/git'
import { copyTemplateRepo } from '../testFixtures'
import { checkTicketFoldersLocation, LONG_TICKET_FOLDER, type TicketFoldersLocationDeps } from './location'

let tmp: string
let deps: TicketFoldersLocationDeps

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-loc-'))
  deps = { dataHome: path.join(tmp, 'home'), workspaces: [], git: runGit }
})
afterEach(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }))

describe('checkTicketFoldersLocation', () => {
  it('an empty value, or the data home, means the data home', async () => {
    expect(await checkTicketFoldersLocation(null, deps)).toEqual({ location: null, warning: null })
    expect(await checkTicketFoldersLocation('  ', deps)).toEqual({ location: null, warning: null })
    expect(await checkTicketFoldersLocation(deps.dataHome, deps)).toEqual({ location: null, warning: null })
  })

  it('makes a missing folder and leaves nothing behind in it', async () => {
    const root = path.join(tmp, 'fast', 'mb')
    expect(await checkTicketFoldersLocation(root, deps)).toMatchObject({ location: root })
    expect(await fs.readdir(root)).toEqual([])
  })

  it('refuses a relative path, a network path, and a non-string', async () => {
    await expect(checkTicketFoldersLocation('mb', deps)).rejects.toThrow('full path')
    await expect(checkTicketFoldersLocation(7, deps)).rejects.toThrow('folder path')
    const win = { ...deps, platform: 'win32' as const }
    for (const bad of ['\\\\server\\share\\mb', '\\\\?\\D:\\mb', 'D:mb', 'mb']) {
      await expect(checkTicketFoldersLocation(bad, win)).rejects.toThrow('full path')
    }
  })

  it('refuses a file, and a folder inside a workspace repo or any git repository', async () => {
    const file = path.join(tmp, 'a-file')
    await fs.writeFile(file, 'x')
    await expect(checkTicketFoldersLocation(file, deps)).rejects.toThrow()
    await expect(checkTicketFoldersLocation(path.join(file, 'sub'), deps)).rejects.toThrow()

    const repo = path.join(tmp, 'repo')
    await copyTemplateRepo(repo)
    await expect(checkTicketFoldersLocation(path.join(repo, 'tickets'), deps)).rejects.toThrow('git repository')
    await expect(checkTicketFoldersLocation(path.join(repo, 'tickets'), { ...deps, workspaces: [{ name: 'Mine', slug: 'mine', repoPath: repo }] })).rejects.toThrow('Mine')
    expect(await fs.stat(path.join(repo, 'tickets')).catch(() => null)).toBeNull()
  })

  it('refuses a folder it cannot write to, and removes what it made', async () => {
    // A file where the folder's parent would be makes mkdir fail on every platform.
    const blocker = path.join(tmp, 'blocker')
    await fs.writeFile(blocker, 'x')
    await expect(checkTicketFoldersLocation(path.join(blocker, 'mb'), deps)).rejects.toThrow()
  })

  it('warns, without blocking, when a typical ticket folder would be long (Windows)', async () => {
    const win = { ...deps, platform: 'win32' as const }
    if (process.platform !== 'win32') return
    const short = await checkTicketFoldersLocation(path.join(tmp, 's'), { ...win, workspaces: [] })
    const long = path.join(tmp, 'a'.repeat(LONG_TICKET_FOLDER))
    const checked = await checkTicketFoldersLocation(long, win)
    expect(checked.location).toBe(long)
    expect(checked.warning).toContain('characters')
    expect(short.warning === null || short.location!.length > 40).toBe(true)
  })
})

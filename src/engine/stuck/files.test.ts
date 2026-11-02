import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { newestChange } from './files'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-files-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
})

const old = new Date('2020-01-01T00:00:00Z')
const recent = new Date('2026-11-02T09:00:00Z')

/** Writes a file with the given modification time, then sets every folder on its way back to `old`. */
async function touch(file: string, when: Date): Promise<void> {
  const full = path.join(root, file)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, 'x')
  await fs.utimes(full, when, when)
}

async function ageFolders(...folders: string[]): Promise<void> {
  for (const folder of folders) await fs.utimes(path.join(root, folder), old, old)
}

describe('newestChange', () => {
  test('is the newest modification time of any file under the folder', async () => {
    await touch('a.txt', old)
    await touch('src/deep/b.txt', recent)
    await ageFolders('src/deep', 'src', '')
    expect(await newestChange(root)).toBe(recent.getTime())
  })

  test('ignores node_modules, build output and the like', async () => {
    await touch('a.txt', old)
    await touch('node_modules/pkg/index.js', recent)
    await touch('dist/out.js', recent)
    await touch('.git/index', recent)
    await ageFolders('node_modules/pkg', 'node_modules', 'dist', '.git', '')
    expect(await newestChange(root)).toBe(old.getTime())
  })

  test('is null for a folder that does not exist, and for an empty one with no mtime to speak of', async () => {
    expect(await newestChange(path.join(root, 'missing'))).toBeNull()
    expect(await newestChange(root)).toBeNull()
  })
})

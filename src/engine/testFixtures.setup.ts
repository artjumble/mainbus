// Vitest globalSetup: builds the template git repos and the pre-migrated database once per run, so each test
// copies them instead of running `git init` and every migration itself.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TestProject } from 'vitest/node'
import { openDb } from './db/open'
import { runGit } from './git/git'
import { resolveHome } from './home'

async function git(args: string[], cwd: string): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-fixtures-'))

  // The repo the runner tests build: one commit, no repo-level identity (commits use -c).
  const repo = path.join(tmp, 'repo')
  await fs.mkdir(repo)
  await git(['init', '-b', 'main'], repo)
  await fs.writeFile(path.join(repo, 'README.md'), 'hello\n')
  await git(['add', '.'], repo)
  await git(['commit', '-m', 'initial'], repo)

  // The same with the repo's own identity, which commits Mainbus makes in it use.
  const repoWithIdentity = path.join(tmp, 'repo-identity')
  await fs.cp(repo, repoWithIdentity, { recursive: true, preserveTimestamps: true })
  await git(['config', 'user.name', 'Test'], repoWithIdentity)
  await git(['config', 'user.email', 'test@example.com'], repoWithIdentity)

  // A standalone, fully migrated database (VACUUM INTO, not a copy of a live WAL file).
  const migrationsDir = path.join(import.meta.dirname, 'db', 'migrations')
  const migrated = resolveHome({ MAINBUS_HOME: path.join(tmp, 'migrated') }, 'dev', os.homedir())
  const handle = await openDb(migrated, migrationsDir)
  handle.close()
  const db = path.join(tmp, 'template.db')
  const sqlite = new DatabaseSync(migrated.db)
  try {
    sqlite.exec(`VACUUM INTO '${db.replaceAll("'", "''")}'`)
  } finally {
    sqlite.close()
  }

  project.provide('testFixtures', { repo, repoWithIdentity, db })
  return () => fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

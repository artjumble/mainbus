// Test helpers over the templates that testFixtures.setup.ts builds once per run.
import fs from 'node:fs/promises'
import os from 'node:os'
import { inject } from 'vitest'
import path from 'node:path'
import { resolveHome, type HomePaths } from './home'

declare module 'vitest' {
  export interface ProvidedContext {
    testFixtures: { repo: string; repoWithIdentity: string; db: string }
  }
}

function fixtures(): { repo: string; repoWithIdentity: string; db: string } {
  const f = inject('testFixtures')
  if (!f) throw new Error('testFixtures is not provided: add src/engine/testFixtures.setup.ts to the project globalSetup')
  return f
}

/**
 * Copies the template repo (one commit, README.md) to `dir`. With `identity`, the repo has its own user.name and
 * user.email configured; without, commits need -c, as in a fresh `git init`.
 */
export async function copyTemplateRepo(dir: string, options: { identity?: boolean } = {}): Promise<string> {
  const f = fixtures()
  await fs.cp(options.identity ? f.repoWithIdentity : f.repo, dir, { recursive: true, preserveTimestamps: true })
  return dir
}

/** Copies the pre-migrated database to `file`, creating its folder. */
export async function copyTemplateDb(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.copyFile(fixtures().db, file)
}

/** The paths of a data home at `root`, with a migrated database already in place. */
export async function testHome(root: string): Promise<HomePaths> {
  const paths = resolveHome({ MAINBUS_HOME: root }, 'dev', os.homedir())
  await copyTemplateDb(paths.db)
  return paths
}

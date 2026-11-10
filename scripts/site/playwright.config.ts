import { defineConfig } from '@playwright/test'

/**
 * The marketing site's tooling: `pnpm site:screenshots` (screenshots.spec.ts) and `pnpm site:check` (site.spec.ts).
 * Kept out of e2e/ so the app's own suite never runs them.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 15 * 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../../test-results/site'
})

import { defineConfig } from '@playwright/test'

/**
 * `pnpm artboards:screenshots`: every wireframe artboard in every theme, with a screenshot of each in
 * test-results/artboards/. Not part of `pnpm e2e`, which runs the artboards once, in the default theme.
 */
process.env['MAINBUS_ARTBOARD_THEMES'] = 'all'

export default defineConfig({
  testDir: '.',
  testMatch: 'artboards.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results/artboards-run'
})

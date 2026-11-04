import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { THEME_IDS } from './src/shared/domain'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          // node:sqlite prints an ExperimentalWarning on import; keep test output clean.
          execArgv: ['--disable-warning=ExperimentalWarning'],
          include: ['src/engine/**/*.test.ts', 'src/main/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/cli/**/*.test.ts']
        }
      },
      {
        plugins: [react()],
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          globals: true,
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/src/test-setup.ts']
        }
      },
      // The component tests again in each other theme, axe checks included (see renderWithMantine).
      ...THEME_IDS.filter((id) => id !== 'light').map((id) => ({
        plugins: [react()],
        test: {
          name: `jsdom-${id}`,
          environment: 'jsdom',
          globals: true,
          include: ['src/renderer/**/*.test.tsx'],
          setupFiles: ['src/renderer/src/test-setup.ts'],
          env: { MAINBUS_TEST_THEME: id }
        }
      }))
    ]
  }
})

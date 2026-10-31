import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

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
          include: ['src/engine/**/*.test.ts', 'src/main/**/*.test.ts', 'src/shared/**/*.test.ts']
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
      }
    ]
  }
})

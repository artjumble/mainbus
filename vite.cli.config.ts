import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// The `mainbus` CLI and MCP server as one self-contained CommonJS file, run by Node in dev and by
// Mainbus.exe in Node mode (ELECTRON_RUN_AS_NODE) in the stable build. Every dependency is bundled.
export default defineConfig({
  build: {
    ssr: 'src/cli/index.ts',
    outDir: 'out/cli',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'cjs', entryFileNames: 'mainbus.cjs', codeSplitting: false }
    }
  },
  ssr: { noExternal: true, target: 'node' }
})

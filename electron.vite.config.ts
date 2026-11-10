import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

// Dev only: the React Refresh preamble is an inline script and Vite HMR uses a websocket.
// The production CSP in index.html stays strict.
const relaxCspInDev: Plugin = {
  name: 'mainbus:relax-csp-in-dev',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' mainbus-model: ws://localhost:* http://localhost:*" />`
    )
  }
}

export default defineConfig({
  main: {},
  preload: {
    build: {
      // Sandboxed renderers only run CommonJS preload scripts.
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react(), relaxCspInDev]
  }
})

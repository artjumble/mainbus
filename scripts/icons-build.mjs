// Renders the app icon's sources in design/icons/ into the PNGs the running app loads, in resources/icons/:
//   mainbus-256.png                 the window and taskbar icon, and the notifications' icon (mainbus.svg)
//   mainbus-tray-<black|white>-N.png the tray glyph for light and dark taskbars, at every Windows display scale
// The output is committed, so a build never needs this. Run it with `pnpm icons:build` after changing the SVGs.
// Playwright drives the repo's own Electron (icons-preview-window.cjs), as icons-preview.mjs does.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const scripts = dirname(fileURLToPath(import.meta.url))
const src = join(scripts, '..', 'design', 'icons')
const out = join(scripts, '..', 'resources', 'icons')

// The tray at 100%, 125%, 150%, 200%, 250% and 300% display scale (TRAY_SIZES in src/main/appIcon.ts).
const TRAY_SIZES = [16, 20, 24, 32, 40, 48]

const jobs = [
  { svg: 'mainbus.svg', name: 'mainbus', sizes: [256] },
  { svg: 'mainbus-tray-black.svg', name: 'mainbus-tray-black', sizes: TRAY_SIZES },
  { svg: 'mainbus-tray-white.svg', name: 'mainbus-tray-white', sizes: TRAY_SIZES }
]

mkdirSync(out, { recursive: true })
const electronApp = await electron.launch({ args: [join(scripts, 'icons-preview-window.cjs')] })
try {
  const page = await electronApp.firstWindow()
  for (const { svg, name, sizes } of jobs) {
    const uri = `data:image/svg+xml;base64,${readFileSync(join(src, svg)).toString('base64')}`
    for (const size of sizes) {
      // Drawn on a canvas of exactly `size` pixels: the SVG is rasterized at that size, with a transparent ground.
      const png = await page.evaluate(
        ([uri, size]) =>
          new Promise((resolve, reject) => {
            const img = new Image()
            img.onload = () => {
              const canvas = document.createElement('canvas')
              canvas.width = size
              canvas.height = size
              canvas.getContext('2d').drawImage(img, 0, 0, size, size)
              resolve(canvas.toDataURL('image/png').slice('data:image/png;base64,'.length))
            }
            img.onerror = () => reject(new Error('The SVG did not load'))
            img.src = uri
          }),
        [uri, size]
      )
      writeFileSync(join(out, `${name}-${size}.png`), Buffer.from(png, 'base64'))
      console.log(`wrote resources/icons/${name}-${size}.png`)
    }
  }
} finally {
  await electronApp.close()
}

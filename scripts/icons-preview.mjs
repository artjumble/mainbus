// Renders the icon concepts in design/icons/ into two preview sheets:
//   design/icons/preview.png  every concept at 256, 64, 32 and 16 px on light and dark, plus a Night Owl variant
//   design/icons/taskbar.png  each concept at 16 px in a mock Windows taskbar and tray, light and dark, with the orange dot
// A concept is NN-name.svg; NN-name-16.svg, if present, is its simplified variant for 16 and 32 px.
// Run with `pnpm icons:preview`. Playwright drives the repo's own Electron (icons-preview-window.cjs), as the e2e
// tests do, so there is no browser to download.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const scripts = dirname(fileURLToPath(import.meta.url))
const dir = join(scripts, '..', 'design', 'icons')

const LIGHT = '#F3F3F3' // Windows 11 light taskbar
const DARK = '#202020' // Windows 11 dark taskbar
const NIGHT_OWL_GROUND = '#011627'
const DOT = '#B5530F' // Needs-you orange
// The tray's dot, as src/main/tray/icons.ts draws it: centre at 72% of the size, radius 26%.
const DOT_CENTRE = 0.72
const DOT_RADIUS = 0.26

// The app palette to Night Owl's (src/renderer/src/theme.ts): tile, lanes, links, foreground.
const NIGHT_OWL = { '#1E3F99': '#0B2942', '#3A5FC4': '#1D3B53', '#7E9BE6': '#5F7E97', '#F4F4F1': '#82AAFF' }

const files = readdirSync(dir).filter((f) => /^\d\d-.+\.svg$/.test(f))
const concepts = files
  .filter((f) => !/-(16|32)\.svg$/.test(f))
  .sort()
  .map((f) => {
    const base = f.replace(/\.svg$/, '')
    const small = files.includes(`${base}-16.svg`) ? `${base}-16.svg` : f
    const [, num, slug] = /^(\d\d)-(.+)$/.exec(base)
    const name = slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
    return { num, name, full: read(f), small: read(small), hasSmall: small !== f }
  })

function read(f) {
  return readFileSync(join(dir, f), 'utf8')
}

function nightOwl(svg) {
  return svg.replace(/#[0-9A-Fa-f]{6}/g, (c) => NIGHT_OWL[c.toUpperCase()] ?? c)
}

function uri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// An icon drawn at `size` real pixels, optionally with the tray dot over it.
function img(svg, size, dot = false) {
  const d = dot
    ? `<span class="dot" style="left:${size * (DOT_CENTRE - DOT_RADIUS)}px;top:${size * (DOT_CENTRE - DOT_RADIUS)}px;width:${size * DOT_RADIUS * 2}px;height:${size * DOT_RADIUS * 2}px"></span>`
    : ''
  return `<span class="icon" style="width:${size}px;height:${size}px"><img src="${uri(svg)}" width="${size}" height="${size}">${d}</span>`
}

// A 16 px rendering blown up 4x with hard pixels, so the real pixels can be judged.
function zoom(svg) {
  return `<canvas class="zoom" width="16" height="16" data-src="${uri(svg)}"></canvas>`
}

function cell(c, bg, svgs) {
  return `<div class="cell" style="background:${bg}">
    ${img(svgs.full, 256)}${img(svgs.full, 64)}${img(svgs.small, 32)}${img(svgs.small, 16)}${zoom(svgs.small)}
  </div>`
}

const style = `
  * { box-sizing: border-box; margin: 0 }
  body { font: 14px 'Segoe UI', system-ui, sans-serif; color: #1F1F1F; background: #fff; padding: 24px; width: max-content }
  h1 { font-size: 20px; margin-bottom: 4px }
  p.note { color: #5b6168; margin-bottom: 16px }
  .row { display: flex; gap: 12px; align-items: stretch; margin-bottom: 12px }
  .label { width: 150px; padding-top: 8px }
  .label b { display: block; font-size: 18px }
  .label small { color: #5b6168 }
  .cell { display: flex; gap: 16px; align-items: center; padding: 16px; border-radius: 8px }
  .icon { position: relative; display: inline-block; flex: none }
  .icon img { display: block }
  .dot { position: absolute; border-radius: 50%; background: ${DOT} }
  canvas.zoom { width: 64px; height: 64px; image-rendering: pixelated; flex: none }
  .head { display: flex; gap: 12px; margin-bottom: 6px; color: #5b6168 }
  .head div { padding-left: 16px }
`

const drawZooms = `
  Promise.all([...document.querySelectorAll('canvas.zoom')].map((c) => new Promise((done) => {
    const i = new Image()
    i.onload = () => { c.getContext('2d').drawImage(i, 0, 0, 16, 16); done() }
    i.src = c.dataset.src
  }))).then(() => { document.body.dataset.ready = '1' })
`

const sheetWidth = 256 + 64 + 32 + 16 + 64 + 16 * 4 + 32
const contact = `<!doctype html><html><head><style>${style}</style></head><body>
  <h1>Mainbus icon concepts</h1>
  <p class="note">Each row: 256, 64, 32 and 16 px, then the 16 px rendering at 4x. 32 and 16 px use the simplified variant where there is one (marked *).
  Light ${LIGHT} and dark ${DARK} are Windows 11's taskbar colours; the last column is the Night Owl variant on Night Owl's ground.</p>
  <div class="head"><div style="width:150px"></div><div style="width:${sheetWidth}px">Light</div><div style="width:${sheetWidth}px">Dark</div><div>Night Owl</div></div>
  ${concepts
    .map(
      (c) => `<div class="row">
        <div class="label"><b>${c.num}</b>${c.name}${c.hasSmall ? ' *' : ''}</div>
        ${cell(c, LIGHT, c)}${cell(c, DARK, c)}${cell(c, NIGHT_OWL_GROUND, { full: nightOwl(c.full), small: nightOwl(c.small) })}
      </div>`
    )
    .join('')}
  <script>${drawZooms}</script>
</body></html>`

// Generic stand-ins for other apps and the tray's system icons: plain shapes, so the concept is the only real icon.
const otherApp = (fg) => `<span style="width:16px;height:16px;border-radius:4px;border:2px solid ${fg};display:inline-block;opacity:.55"></span>`
const sysIcon = (fg) => `<span style="width:12px;height:12px;border-radius:50%;border:2px solid ${fg};display:inline-block;opacity:.55;margin:2px"></span>`

function taskbar(c, bg, fg) {
  return `<div class="bar" style="background:${bg};color:${fg}">
    <span class="apps">${otherApp(fg)}${otherApp(fg)}<span class="btn">${img(c.small, 16)}<i style="background:${fg}"></i></span>${otherApp(fg)}</span>
    <span class="tray">${sysIcon(fg)}${sysIcon(fg)}${img(c.small, 16)}${img(c.small, 16, true)}<span class="clock">09:41</span></span>
  </div>`
}

const taskbarHtml = `<!doctype html><html><head><style>${style}
  .bar { display: flex; justify-content: space-between; align-items: center; width: 520px; height: 40px; padding: 0 12px; border-radius: 6px }
  .apps, .tray { display: flex; gap: 14px; align-items: center }
  .tray { gap: 10px }
  .btn { position: relative; display: inline-flex; padding: 6px; border-radius: 4px; background: rgba(128,128,128,.18) }
  .btn i { position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; border-radius: 1px; opacity: .7 }
  .clock { font-size: 12px; margin-left: 6px }
</style></head><body>
  <h1>Mainbus icon concepts in the taskbar and tray</h1>
  <p class="note">Real pixels: 16 px in a taskbar button and in the tray, without and with the tray's orange "needs you" dot (src/main/tray/icons.ts geometry).</p>
  ${concepts
    .map(
      (c) => `<div class="row"><div class="label"><b>${c.num}</b>${c.name}</div>${taskbar(c, LIGHT, '#1F1F1F')}${taskbar(c, DARK, '#F3F3F3')}</div>`
    )
    .join('')}
</body></html>`

const electronApp = await electron.launch({ args: [join(scripts, 'icons-preview-window.cjs')] })
try {
  const page = await electronApp.firstWindow()
  for (const [html, out, zooms] of [
    [contact, 'preview.png', true],
    [taskbarHtml, 'taskbar.png', false]
  ]) {
    await page.setContent(html)
    await page.waitForFunction(() => [...document.images].every((i) => i.complete))
    if (zooms) await page.waitForFunction(() => document.body.dataset.ready === '1')
    await page.locator('body').screenshot({ path: join(dir, out) })
    console.log(`wrote design/icons/${out}`)
  }
} finally {
  await electronApp.close()
}

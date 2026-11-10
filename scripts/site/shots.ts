/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { useTheme, type ThemeId } from '../../e2e/artboardHelpers'
import { DEMO_HOME, DEMO_PROJECTS } from './demoSeed'

export const root = path.resolve(import.meta.dirname, '..', '..')
/** The raw 2× captures (ignored by git). */
export const RAW = path.join(root, 'test-results', 'site-shots')
/** Where the site's images go. */
export const IMG = path.join(root, 'site', 'img')

/** Every screenshot is taken at this size in CSS pixels, at 2 device pixels per CSS pixel. */
export const SIZE = { width: 1440, height: 900 }

type Bridge = { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }

/** Calls the engine through the preload bridge, as the renderer does. */
export function invoke<T>(page: Page, command: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([c, a]) => (globalThis as unknown as Bridge).mainbus.invoke(c as string, ...(a as unknown[])), [command, args] as const) as Promise<T>
}

/**
 * Starts the built app with FakeRuntime playing `script`, a temporary data home and the demo repositories, at 2 device
 * pixels per CSS pixel. Refuses to run without a temporary MAINBUS_HOME: it never opens the user's own board.
 */
export async function launchDemo(opts: { tmp: string; script: string; repos: string[]; clockStart: Date }): Promise<{ app: ElectronApplication; page: Page }> {
  const home = path.join(opts.tmp, 'home')
  if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()))) throw new Error(`The demo's data home must be in the temp folder, not ${home}`)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['--force-device-scale-factor=2', '.'],
    cwd: root,
    env: {
      ...env,
      MAINBUS_HOME: home,
      MAINBUS_RUNTIME: `fake:${opts.script}`,
      MAINBUS_TEST_REPO: opts.repos.join(path.delimiter),
      MAINBUS_FAKE_CLOCK: opts.clockStart.toISOString()
    }
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [SIZE.width, SIZE.height])
  // The window may be wider than the screen allows: the page is laid out at exactly this size whatever the window is.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: SIZE.width, height: SIZE.height, deviceScaleFactor: 2, mobile: false })
  const metrics = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }))
  if (metrics.w !== SIZE.width || metrics.h !== SIZE.height || metrics.dpr !== 2) throw new Error(`The page is ${JSON.stringify(metrics)}, not ${SIZE.width}×${SIZE.height} at 2×`)
  return { app, page }
}

/** Moves the engine's fake clock on, running what comes due. */
export async function advance(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate(async (_e, by) => {
    const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
    if (!clock) throw new Error('The fake clock is not on')
    await clock.advance(by)
  }, ms)
}

/** A path in both slash styles. */
function bothSlashes(p: string): string[] {
  return [...new Set([p, p.replace(/\\/g, '/')])]
}

/** The temp folder by every name it may show under (the long form and any 8.3 short form). */
function spellings(dir: string): string[] {
  const all = new Set([dir, path.resolve(dir)])
  try {
    all.add(fs.realpathSync.native(dir))
  } catch {
    // Not there (yet): the given names are enough.
  }
  return [...all]
}

/**
 * What the screenshots show in place of the run's real folders: the data home first (it is inside the temp folder),
 * then the temp folder that holds the demo repositories.
 */
export function maskPairs(tmp: string): [string, string][] {
  const pairs: [string, string][] = []
  for (const t of spellings(tmp)) {
    const home = path.join(t, 'home')
    pairs.push(...bothSlashes(home).map((h, i): [string, string] => [h, i === 0 ? DEMO_HOME : DEMO_HOME.replace(/\\/g, '/')]))
  }
  for (const t of spellings(tmp)) pairs.push(...bothSlashes(t).map((h, i): [string, string] => [h, i === 0 ? DEMO_PROJECTS : DEMO_PROJECTS.replace(/\\/g, '/')]))
  return pairs
}

function gitConfig(key: string): string | null {
  try {
    return execFileSync('git', ['config', '--global', key], { windowsHide: true, stdio: 'pipe' }).toString().trim() || null
  } catch {
    return null
  }
}

/** Text that must never be in a screenshot: this machine's paths, user, host and git identity, and the temp folder. */
export function privateNeedles(tmp: string): { text: string[]; words: string[] } {
  const text = [os.homedir(), os.tmpdir(), ...spellings(tmp), gitConfig('user.email'), gitConfig('user.name')]
    .filter((s): s is string => !!s && s.length >= 4)
    .flatMap(bothSlashes)
  const words = [os.userInfo().username, os.hostname()].filter((s) => s.length >= 3)
  return { text, words }
}

/** Replaces the run's real folders with the demo's in the page's text, form values and labels. */
async function mask(page: Page, pairs: [string, string][]): Promise<void> {
  await page.evaluate((replacements) => {
    const swap = (s: string): string => {
      let out = s
      for (const [from, to] of replacements) {
        const lower = from.toLowerCase()
        for (let i = out.toLowerCase().indexOf(lower); i >= 0; i = out.toLowerCase().indexOf(lower, i + to.length)) {
          out = out.slice(0, i) + to + out.slice(i + from.length)
        }
      }
      return out
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = swap(node.nodeValue ?? '')
      if (next !== node.nodeValue) node.nodeValue = next
    }
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))) {
      const next = swap(el.value)
      if (next !== el.value) el.value = next
    }
    for (const el of Array.from(document.querySelectorAll('[title], [aria-label], [placeholder]'))) {
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(attr)
        if (v !== null && swap(v) !== v) el.setAttribute(attr, swap(v))
      }
    }
  }, pairs)
}

/** Fails when the page's text, form values or labels hold anything private. */
async function scan(page: Page, needles: { text: string[]; words: string[] }, slug: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const parts = [document.body.innerText, document.title]
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))) parts.push(el.value)
    for (const el of Array.from(document.querySelectorAll('[title], [aria-label], [placeholder]'))) {
      for (const attr of ['title', 'aria-label', 'placeholder']) parts.push(el.getAttribute(attr) ?? '')
    }
    return parts.join('\n')
  })
  const lower = seen.toLowerCase()
  const found = [
    ...needles.text.filter((n) => lower.includes(n.toLowerCase())),
    ...needles.words.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(seen))
  ]
  if (found.length > 0) throw new Error(`The ${slug} screenshot would show private text (${found.length} match${found.length === 1 ? '' : 'es'}); nothing was saved.`)
}

export interface Capturer {
  /** Captures the window in each theme (Light, then Dark, by default), masked and scanned, then goes back to Light. */
  (slug: string, themes?: ThemeId[]): Promise<void>
  /** Every slug captured, with its themes. */
  readonly taken: { slug: string; themes: ThemeId[] }[]
  /** Run before each theme's capture, after the theme is drawn: to scroll something into view, say. */
  prepare: (() => Promise<void>) | null
}

export function capturer(page: Page, tmp: string): Capturer {
  const pairs = maskPairs(tmp)
  const needles = privateNeedles(tmp)
  const taken: { slug: string; themes: ThemeId[] }[] = []
  fs.mkdirSync(RAW, { recursive: true })
  const capture = async (slug: string, themes: ThemeId[] = ['light', 'dark']): Promise<void> => {
    for (const theme of themes) {
      const current = (await page.locator('html').getAttribute('data-mainbus-theme')) ?? 'light'
      if (current !== theme) await useTheme(page, theme)
      await shot.prepare?.()
      // Let the recently-changed outline, the theme's transition and any toast settle.
      await page.waitForTimeout(theme === themes[0] ? 1500 : 500)
      await mask(page, pairs)
      await scan(page, needles, slug)
      const file = path.join(RAW, `${slug}-${theme}.png`)
      await page.screenshot({ path: file })
    }
    if (((await page.locator('html').getAttribute('data-mainbus-theme')) ?? 'light') !== 'light') await useTheme(page, 'light')
    taken.push({ slug, themes })
  }
  const shot: Capturer = Object.assign(capture, { taken, prepare: null })
  return shot
}

/** The PNG's width and height, from its header. */
export function pngSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** The WebP's width and height, from its VP8/VP8L/VP8X header. */
export function webpSize(b: Buffer): { width: number; height: number } {
  const chunk = b.toString('ascii', 12, 16)
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
}

const isWebp = (b: Buffer): boolean => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'

/** Per-file and total limits for the site's images. */
export const MAX_WEBP_BYTES = 500 * 1024
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024

/**
 * Encodes the raw captures into site/img in a hidden window (Chromium's own encoders, so no new dependency): for each
 * slug and theme a 2× and a 1× WebP, a 1× PNG fallback in the first theme, and og.png from the hero. Clears each
 * slug's old files first, so a re-run leaves exactly what it made.
 */
export async function encode(taken: { slug: string; themes: ThemeId[] }[], og: { slug: string; theme: ThemeId }): Promise<string[]> {
  fs.mkdirSync(IMG, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const viewer = await electron.launch({ args: [path.join(import.meta.dirname, 'viewer.cjs')], env })
  const written: string[] = []
  try {
    const page = await viewer.firstWindow()
    const run = (png: Buffer, out: { width: number; height: number; type: string; quality?: number; crop?: { width: number; height: number } }): Promise<Buffer> =>
      page
        .evaluate(
          async ([b64, o]) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
            const canvas = new OffscreenCanvas(o.width, o.height)
            const ctx = canvas.getContext('2d')!
            ctx.imageSmoothingQuality = 'high'
            const src = o.crop ?? { width: bitmap.width, height: bitmap.height }
            ctx.drawImage(bitmap, 0, 0, src.width, src.height, 0, 0, o.width, o.height)
            const blob = await canvas.convertToBlob({ type: o.type, ...(o.quality !== undefined ? { quality: o.quality } : {}) })
            const out = new Uint8Array(await blob.arrayBuffer())
            let s = ''
            for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000))
            return btoa(s)
          },
          [png.toString('base64'), out] as const
        )
        .then((b64) => Buffer.from(b64, 'base64'))
    const save = (name: string, data: Buffer): void => {
      fs.writeFileSync(path.join(IMG, name), data)
      written.push(name)
    }
    for (const { slug, themes } of taken) {
      for (const old of fs.readdirSync(IMG).filter((f) => f === `${slug}.png` || f.startsWith(`${slug}-`))) fs.rmSync(path.join(IMG, old))
      for (const theme of themes) {
        const raw = fs.readFileSync(path.join(RAW, `${slug}-${theme}.png`))
        const { width, height } = pngSize(path.join(RAW, `${slug}-${theme}.png`))
        const full = await run(raw, { width, height, type: 'image/webp', quality: 0.82 })
        const half = await run(raw, { width: width / 2, height: height / 2, type: 'image/webp', quality: 0.85 })
        for (const b of [full, half]) if (!isWebp(b)) throw new Error(`This Electron can't encode WebP: ${slug}-${theme} came back as something else`)
        save(`${slug}-${theme}.webp`, full)
        save(`${slug}-${theme}-${width / 2}.webp`, half)
        if (theme === themes[0]) save(`${slug}.png`, await run(raw, { width: width / 2, height: height / 2, type: 'image/png' }))
      }
    }
    // The social card: the top of the hero at 1200×630.
    const hero = fs.readFileSync(path.join(RAW, `${og.slug}-${og.theme}.png`))
    const { width } = pngSize(path.join(RAW, `${og.slug}-${og.theme}.png`))
    save('og.png', await run(hero, { width: 1200, height: 630, type: 'image/png', crop: { width, height: Math.round((width * 630) / 1200) } }))
  } finally {
    await viewer.close().catch(() => {})
  }
  return written
}

/** Prints each image's size and fails when a WebP or the whole folder is over its limit. */
export function checkSizes(): void {
  const files = fs.readdirSync(IMG).filter((f) => /\.(webp|png)$/.test(f)).sort()
  let total = 0
  const rows: string[] = []
  const over: string[] = []
  for (const f of files) {
    const bytes = fs.statSync(path.join(IMG, f)).size
    total += bytes
    rows.push(`${f.padEnd(40)} ${(bytes / 1024).toFixed(0).padStart(6)} KB`)
    if (f.endsWith('.webp') && bytes > MAX_WEBP_BYTES) over.push(f)
  }
  console.log([...rows, `${'total'.padEnd(40)} ${(total / 1024).toFixed(0).padStart(6)} KB`].join('\n'))
  if (over.length > 0) throw new Error(`Over ${MAX_WEBP_BYTES / 1024} KB: ${over.join(', ')}`)
  if (total > MAX_TOTAL_BYTES) throw new Error(`site/img is ${(total / 1024 / 1024).toFixed(1)} MB, over ${MAX_TOTAL_BYTES / 1024 / 1024} MB`)
}

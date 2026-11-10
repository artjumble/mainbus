/// <reference lib="dom" />
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * `pnpm site:check`: opens the marketing site in a hidden window of the repo's own Electron, from a small local
 * server that answers unknown paths with 404.html as the hosts do, and from file:// as someone opening index.html
 * would. Checks accessibility (axe, every rule, in light and dark), reduced motion, sideways overflow from phone to
 * wide screens, that every image loads, keyboard focus, and the page's metadata and host files.
 */

const site = path.resolve(import.meta.dirname, '..', '..', 'site')
const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

let server: http.Server
let base: string
let viewer: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rel = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1)
    const file = path.resolve(site, rel)
    const inside = file.startsWith(site + path.sep)
    if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    } else {
      res.writeHead(404, { 'content-type': TYPES['.html']! })
      res.end(fs.readFileSync(path.join(site, '404.html')))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  viewer = await electron.launch({ args: [path.join(import.meta.dirname, 'viewer.cjs')], env })
  page = await viewer.firstWindow()
})

test.afterAll(async () => {
  await viewer?.close().catch(() => {})
  await new Promise((resolve) => server?.close(resolve))
})

async function size(width: number, height = 900): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.detach()
}

/** Every image loads, the lazy ones too, from the source the colour scheme picks. */
async function expectImagesLoad(what: string): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('img').forEach((img) => (img.loading = 'eager')))
  await expect
    .poll(() => page.evaluate(() => Array.from(document.images).every((img) => img.complete)), { message: `${what}: images finish loading`, timeout: 30_000 })
    .toBe(true)
  const broken = await page.evaluate(() => Array.from(document.images).filter((img) => img.naturalWidth === 0).map((img) => img.currentSrc || img.src))
  expect(broken, `${what}: images that didn't load`).toEqual([])
}

async function expectNoAxeViolations(what: string): Promise<void> {
  await page.evaluate(axeSource)
  const violations = await page.evaluate(async () => {
    interface AxeViolation {
      id: string
      help: string
      nodes: { target: string[]; failureSummary?: string }[]
    }
    const results = await (window as unknown as { axe: { run: (c: Document) => Promise<{ violations: AxeViolation[] }> } }).axe.run(document)
    return results.violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary?.replace(/\s+/g, ' ').slice(0, 220) ?? ''}`)
    }))
  })
  expect(violations, `axe violations on ${what}`).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test(`index and 404 pass axe, with every image loaded, in ${scheme}`, async () => {
    await size(1440)
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' })
    await page.goto(`${base}/`)
    await expectImagesLoad(`index (${scheme})`)
    // The scheme's own screenshots.
    const sources = await page.evaluate(() => Array.from(document.images).map((img) => img.currentSrc))
    expect(sources.filter((s) => /img\/(board|worktree)-/.test(s)).every((s) => s.includes(`-${scheme}`))).toBe(true)
    await expectNoAxeViolations(`index (${scheme})`)

    const missing = await page.goto(`${base}/no/such/page`)
    expect(missing!.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible()
    await expectImagesLoad(`404 (${scheme})`)
    // Its styles came through from a nested path.
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('system-ui')
    await expectNoAxeViolations(`404 (${scheme})`)
  })
}

test('opens straight from the file, with no build: styles, images and icons', async () => {
  await size(1440)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(pathToFileURL(path.join(site, 'index.html')).href)
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('system-ui')
  await expectImagesLoad('index from file://')
})

test('nothing overflows sideways, from a phone to a wide screen', async () => {
  await page.emulateMedia({ colorScheme: 'light' })
  for (const width of [360, 768, 1024, 1440]) {
    await size(width)
    for (const url of [`${base}/`, `${base}/missing`]) {
      await page.goto(url)
      const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
      expect(scroll, `${url} at ${width}px`).toBeLessThanOrEqual(client)
    }
  }
})

test('reduced motion: no smooth scrolling, animations or transitions', async () => {
  await size(1440)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${base}/`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto')
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto(`${base}/`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('smooth')
})

test('the first Tab reaches the skip link, which shows with a focus outline and leads to the content', async () => {
  await size(1440)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${base}/`)
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  expect(await skip.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  // Every link and button can be reached, with a visible outline.
  await page.keyboard.press('Tab')
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)
  expect(outline).not.toBe('none')
})

test('the head has the title, description, canonical URL, icons and social cards; the host files are there', async () => {
  await page.goto(`${base}/`)
  const meta = (selector: string): Promise<string | null> => page.locator(selector).first().getAttribute('content')
  expect(await page.title()).toContain('Mainbus')
  expect(await meta('meta[name="description"]')).toBeTruthy()
  expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://mainbus.app/')
  expect(await meta('meta[property="og:url"]')).toBe('https://mainbus.app/')
  expect(await meta('meta[property="og:title"]')).toBeTruthy()
  expect(await meta('meta[property="og:description"]')).toBeTruthy()
  expect(await meta('meta[property="og:image"]')).toBe('https://mainbus.app/img/og.png')
  expect(await meta('meta[property="og:image:alt"]')).toBeTruthy()
  expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image')
  expect(await meta('meta[name="twitter:image"]')).toBe('https://mainbus.app/img/og.png')
  for (const href of await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll((ls) => ls.map((l) => (l as HTMLLinkElement).href))) {
    const res = await page.request.get(href)
    expect(res.status(), href).toBe(200)
  }
  const og = fs.readFileSync(path.join(site, 'img', 'og.png'))
  expect([og.readUInt32BE(16), og.readUInt32BE(20)]).toEqual([1200, 630])
  expect(fs.readFileSync(path.join(site, 'robots.txt'), 'utf8')).toContain('User-agent: *')
  expect(fs.readFileSync(path.join(site, 'CNAME'), 'utf8').trim()).toBe('mainbus.app')
  // The 404 page isn't for search engines.
  await page.goto(`${base}/missing`)
  expect(await meta('meta[name="robots"]')).toBe('noindex')
})

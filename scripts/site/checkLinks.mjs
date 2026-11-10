// Checks the marketing site's pages (site/*.html) without a browser or dependencies:
//   - every local href, src and srcset (relative, or root-absolute from site/) is a file that exists;
//   - every #fragment, on the page or another local page, is an id on it;
//   - every <img> has an alt attribute (and a non-empty one for the screenshots in img/), a width and a height;
//   - there are no scripts.
// External links are listed; with --external each is fetched and must answer 2xx or 3xx.
// Run with `node scripts/site/checkLinks.mjs [--external]`, or as part of `pnpm site:check`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'site')
const pages = readdirSync(site).filter((f) => f.endsWith('.html'))
const problems = []
const external = new Map()

/** Each tag's attributes, by tag name: a small parser, enough for hand-written HTML. */
function tags(html) {
  const out = []
  const tagRe = /<([a-zA-Z][\w-]*)(\s[^>]*?)?\/?>/g
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(tagRe)) {
    const attrs = {}
    for (const a of (m[2] ?? '').matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? ''
    }
    out.push({ name: m[1].toLowerCase(), attrs })
  }
  return out
}

function idsOf(file) {
  return new Set(tags(readFileSync(file, 'utf8')).map((t) => t.attrs.id).filter(Boolean))
}

function decode(s) {
  return s.replace(/&amp;/g, '&')
}

for (const page of pages) {
  const html = readFileSync(join(site, page), 'utf8')
  const all = tags(html)
  const ids = new Set(all.map((t) => t.attrs.id).filter(Boolean))
  const refs = []
  for (const t of all) {
    if (t.name === 'script') problems.push(`${page}: has a <script>; the site has none`)
    for (const attr of ['href', 'src']) if (t.attrs[attr] !== undefined) refs.push({ tag: t.name, url: decode(t.attrs[attr]) })
    if (t.attrs.srcset !== undefined) for (const part of t.attrs.srcset.split(',')) refs.push({ tag: t.name, url: decode(part.trim().split(/\s+/)[0]) })
    if (t.name === 'img') {
      const src = t.attrs.src ?? '(no src)'
      if (t.attrs.alt === undefined) problems.push(`${page}: <img ${src}> has no alt`)
      else if (t.attrs.alt.trim() === '' && /(^|\/)img\//.test(src)) problems.push(`${page}: the screenshot ${src} has an empty alt`)
      if (!t.attrs.width || !t.attrs.height) problems.push(`${page}: <img ${src}> has no width and height`)
    }
  }
  for (const { tag, url } of refs) {
    if (url === '') {
      problems.push(`${page}: an empty link on <${tag}>`)
    } else if (/^https?:\/\//.test(url)) {
      // Canonical and social URLs point at the site itself, once deployed: checked as local files instead.
      const own = /^https:\/\/mainbus\.app(\/.*)?$/.exec(url)
      if (own) {
        const path = (own[1] ?? '/').split('#')[0]
        const file = join(site, path === '/' ? 'index.html' : path)
        if (!existsSync(file)) problems.push(`${page}: ${url} would be missing once deployed (no ${file})`)
      } else {
        external.set(url, [...(external.get(url) ?? []), page])
      }
    } else if (/^(mailto|tel):/.test(url)) {
      continue
    } else if (url.startsWith('#')) {
      if (url !== '#' && !ids.has(url.slice(1))) problems.push(`${page}: ${url} matches no id on the page`)
    } else {
      const [path, fragment] = url.split('#')
      const file = path.startsWith('/') ? join(site, path === '/' ? 'index.html' : path) : resolve(site, path)
      if (!existsSync(file) || (statSync(file).isDirectory() && !existsSync(join(file, 'index.html')))) {
        problems.push(`${page}: ${url} is missing`)
      } else if (fragment && file.endsWith('.html') && !idsOf(file).has(fragment)) {
        problems.push(`${page}: ${url} matches no id on ${path}`)
      }
    }
  }
}

console.log(`Checked ${pages.length} pages: ${pages.join(', ')}`)
console.log(`External links (${external.size}${process.argv.includes('--external') ? ', fetched' : ', not fetched; add --external'}):`)
for (const url of external.keys()) console.log(`  ${url}`)

if (process.argv.includes('--external')) {
  for (const url of external.keys()) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow' })
      if (res.status >= 400) problems.push(`${url} answered ${res.status}`)
    } catch (err) {
      problems.push(`${url} could not be fetched: ${err.message}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('\nNo broken links or images.')

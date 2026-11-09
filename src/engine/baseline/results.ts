import path from 'node:path'
import type { TestResultFormat } from '../../shared/domain'

export type ParsedResults = { failures: string[] } | { error: string }

/** A name is one line and not endless: it goes into prompts and onto screens. */
const NAME_MAX = 300

function clean(name: string): string {
  const one = name.replace(/\s+/g, ' ').trim()
  return one.length > NAME_MAX ? `${one.slice(0, NAME_MAX)}…` : one
}

function unique(names: string[]): string[] {
  return [...new Set(names.map(clean).filter((n) => n !== ''))].sort()
}

function rel(root: string, file: string): string {
  const absolute = path.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file)
  if (!absolute) return file.replace(/\\/g, '/')
  // Compare with the separators of the report's own paths, which may come from another platform.
  const slashed = file.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? slashed.slice(base.length + 1) : slashed
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The failing tests of a vitest (or Jest) JSON report: `<file> > <describe titles> > <title>`; a suite that failed to load counts as its file. */
function parseVitest(text: string, root: string): ParsedResults {
  const json: unknown = JSON.parse(text)
  if (!isObject(json) || !Array.isArray(json.testResults)) return { error: 'not a vitest JSON report: no testResults' }
  const failures: string[] = []
  for (const file of json.testResults) {
    if (!isObject(file)) continue
    const name = rel(root, str(file.name))
    let named = false
    for (const a of Array.isArray(file.assertionResults) ? file.assertionResults : []) {
      if (!isObject(a) || a.status !== 'failed') continue
      const titles = [...(Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(str) : []), str(a.title)].filter((t) => t !== '')
      failures.push([name, ...titles].join(' > '))
      named = true
    }
    if (!named && file.status === 'failed') failures.push(name)
  }
  return { failures: unique(failures) }
}

/** The failing tests of a Playwright JSON report: `<file> > <describe titles> > <title>`, with ` [project]` when it has one. Flaky counts as passed. */
function parsePlaywright(text: string): ParsedResults {
  const json: unknown = JSON.parse(text)
  if (!isObject(json) || !Array.isArray(json.suites)) return { error: 'not a Playwright JSON report: no suites' }
  const failures: string[] = []
  const walk = (suite: unknown, titles: string[]): void => {
    if (!isObject(suite)) return
    // A file-level suite is titled with its file name, which the test's own file already says.
    const title = str(suite.title)
    const here = title !== '' && title !== str(suite.file) ? [...titles, title] : titles
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObject(spec)) continue
      for (const t of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isObject(t) || t.status !== 'unexpected') continue
        const project = str(t.projectName)
        const name = [str(spec.file) || str(suite.file), ...here, str(spec.title)].filter((p) => p !== '').join(' > ')
        failures.push(`${name}${project ? ` [${project}]` : ''}`)
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child, here)
  }
  for (const s of json.suites) walk(s, [])
  return { failures: unique(failures) }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (m, dec?: string, hex?: string, named?: string) => {
    if (dec) return String.fromCodePoint(Number.parseInt(dec, 10))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    return (named && ENTITIES[named]) || m
  })
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return decode(m?.[1] ?? m?.[2] ?? '')
}

/** The failing cases of a JUnit XML report: `<classname> > <name>`. A case with a failure or error child fails. */
function parseJunit(text: string): ParsedResults {
  if (!/<testsuites?[\s>]/.test(text)) return { error: 'not a JUnit XML report: no testsuite' }
  const failures: string[] = []
  // A case is either self-closing (it passed) or has a body that may hold <failure> or <error>.
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g
  for (const m of text.matchAll(re)) {
    const body = m[3] ?? ''
    if (!/<(failure|error)\b/.test(body)) continue
    failures.push([attr(m[1] ?? '', 'classname'), attr(m[1] ?? '', 'name')].filter((p) => p !== '').join(' > '))
  }
  return { failures: unique(failures) }
}

/**
 * The failing tests named in a results file. `root` is the folder the tests ran in: file paths are shown relative to it.
 * Plain results have none to read. Returns `{ error }` for text that isn't the format.
 */
export function parseResults(format: TestResultFormat, text: string, root: string): ParsedResults {
  try {
    switch (format) {
      case 'vitest-json':
        return parseVitest(text, root)
      case 'playwright-json':
        return parsePlaywright(text)
      case 'junit-xml':
        return parseJunit(text)
      case 'plain':
        return { failures: [] }
    }
  } catch (err) {
    return { error: `the results could not be read as ${format}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** The file extension for a format's results file. */
export function resultsExtension(format: TestResultFormat): string {
  return format === 'junit-xml' ? 'xml' : format === 'plain' ? 'txt' : 'json'
}

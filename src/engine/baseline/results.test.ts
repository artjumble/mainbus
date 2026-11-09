import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseResults } from './results'

const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')

describe('parseResults', () => {
  it('reads the failing tests of a vitest JSON report, and a suite that failed to load as its file', () => {
    expect(parseResults('vitest-json', fixture('vitest.json'), 'C:\\work\\repo')).toEqual({
      failures: ['/elsewhere/broken.test.ts', 'src/math/math.test.ts > math > divide > throws on zero']
    })
  })

  it('reads the failing tests of a Playwright JSON report; flaky and skipped ones count as passed', () => {
    expect(parseResults('playwright-json', fixture('playwright.json'), '/repo')).toEqual({
      failures: ['board.spec.ts > tickets > moves a ticket [electron]']
    })
  })

  it('reads the failing and erroring cases of a JUnit XML report, decoding entities', () => {
    expect(parseResults('junit-xml', fixture('junit.xml'), '/repo')).toEqual({
      failures: ['math > arithmetic > divides & rounds', 'math > crashes']
    })
  })

  it('gives an error for text that is not the format, or not parseable', () => {
    expect(parseResults('vitest-json', '{"a":1}', '/repo')).toHaveProperty('error')
    expect(parseResults('vitest-json', 'not json', '/repo')).toHaveProperty('error')
    expect(parseResults('playwright-json', '[]', '/repo')).toHaveProperty('error')
    expect(parseResults('junit-xml', '<html></html>', '/repo')).toHaveProperty('error')
  })

  it('names no failures for plain results', () => {
    expect(parseResults('plain', 'anything', '/repo')).toEqual({ failures: [] })
  })

  it('clips and tidies long names, and lists each test once', () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: '/r/a.test.ts',
          status: 'failed',
          assertionResults: [
            { ancestorTitles: [], title: 'a\nb', status: 'failed' },
            { ancestorTitles: [], title: 'a\nb', status: 'failed' },
            { ancestorTitles: [], title: 'x'.repeat(400), status: 'failed' }
          ]
        }
      ]
    })
    const result = parseResults('vitest-json', json, '/r') as { failures: string[] }
    expect(result.failures).toHaveLength(2)
    expect(result.failures).toContain('a.test.ts > a b')
    expect(result.failures.some((f) => f.length <= 301 && f.endsWith('…'))).toBe(true)
  })
})

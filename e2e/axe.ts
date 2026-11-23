import fs from 'node:fs'
import { createRequire } from 'node:module'
import { expect, type Page } from '@playwright/test'

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

/** Runs axe over the page with every rule on, colour contrast included, and fails with what it found. */
/** `rules` limits axe to those rules; a floating surface is outside the page's landmarks, so it is measured for colour contrast only. */
export async function expectNoAxeViolations(page: Page, what: string, rules?: string[]): Promise<void> {
  // Evaluated, not injected as a script tag, so the page's content security policy does not apply.
  await page.evaluate(axeSource)
  const violations = await page.evaluate(async (rules) => {
    const results = await (window as unknown as { axe: { run: (c: Document, o?: object) => Promise<{ violations: AxeViolation[] }> } }).axe.run(document, rules ? { runOnly: rules } : {})
    interface AxeViolation {
      id: string
      help: string
      nodes: { target: string[]; failureSummary?: string }[]
    }
    return results.violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary?.replace(/\s+/g, ' ').slice(0, 220) ?? ''}`)
    }))
  }, rules)
  expect(violations, `axe violations on ${what}`).toEqual([])
}

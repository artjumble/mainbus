import type { Page } from '@playwright/test'

/**
 * Clicks Add workspace on the welcome screen (the test's folder picker answers with the throwaway repository) and waits
 * for the new workspace's board. The Workspaces rail shows before any workspace exists, so waiting on it alone races
 * the add flow (base branch lookup, warning check): the board's New ticket button is what shows the add is done.
 */
export async function addWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add workspace' }).click()
  await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()
  await page.getByRole('button', { name: 'New ticket' }).waitFor()
}

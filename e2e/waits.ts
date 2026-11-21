/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Waits until no finite animation or transition is running in the page, or under the locator's element: what an
 * accessibility check or a measurement needs before it reads colours or boxes. Endless ones (spinners) are ignored.
 */
export async function animationsSettled(scope: Page | Locator): Promise<void> {
  await expect
    .poll(() =>
      'goto' in scope ? scope.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length) : scope.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length)
    )
    .toBe(0)
}

/**
 * dnd-kit's keyboard sensor attaches its keydown listener in a setTimeout(0) when a drag starts, which is before it
 * announces "Picked up". One more macrotask in the page therefore runs after the listener is in place.
 */
export async function keyboardDragReady(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

/** Waits until the element's box is the same on two reads one frame apart (the shell has stopped moving). */
export async function boxStable(locator: Locator): Promise<void> {
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(await locator.boundingBox())
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
}

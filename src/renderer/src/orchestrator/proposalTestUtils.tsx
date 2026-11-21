import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal } from '../../../shared/proposals'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { ProposalCard } from './ProposalCard'

/**
 * The accessibility check every proposal card file shares: the card has no axe violations, and, for a card with an
 * Override editor, neither does the editor once opened. `override: false` says the card offers no editor.
 * Kept out of test-utils so that file doesn't pull ProposalCard into every renderer test.
 */
export async function expectCardAccessible(proposal: Proposal, opts: { override?: boolean } = {}): Promise<void> {
  renderWithMantine(<ProposalCard proposal={proposal} />)
  await expectNoAxeViolations()
  const override = screen.queryByRole('button', { name: 'Override' })
  if (opts.override === false) {
    expect(override).not.toBeInTheDocument()
    return
  }
  // getByRole throws when the button is gone, so a renamed button can't skip the second check.
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  await expectNoAxeViolations()
}

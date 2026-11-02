import type { ReactElement } from 'react'

/**
 * How the card shows one kind of proposal: P is its payload, R its result, E the state of its Override editor.
 * A new kind adds a view and an entry in ProposalCard's VIEWS.
 */
export interface ProposalView<P, R, E> {
  /** One line, such as "Create 2 tickets in Backlog". */
  summary(payload: P): string
  /** What is proposed, in full enough to decide on. */
  Body(props: { payload: P }): ReactElement
  /** The editor's defaults: the proposal as it is. Absent, with Editor and toOverride, for a kind with nothing to change. */
  initialEdit?(payload: P): E
  Editor?(props: { value: E; onChange: (value: E) => void; payload: P }): ReactElement
  /** What Confirm with changes sends, or null when there is nothing to confirm (such as every draft left out). */
  toOverride?(edit: E): unknown
  /**
   * For a proposal the user must decide themselves: the choices to offer, each confirming with its own override.
   * The card then has no Confirm or Override, only these and Reject, and none is pre-selected.
   */
  choices?(payload: P): { label: string; override: unknown }[] | null
  /** The label of the button that confirms, from the payload; 'Confirm' when absent. */
  confirmLabel?(payload: P): string
  /** The label of the button that rejects; 'Reject' when absent. */
  rejectLabel?: string
  /** The receipt once carried out, such as "Created #21 and #22". */
  Receipt(props: { result: R }): ReactElement
}

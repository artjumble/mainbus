import { Button, Group, Loader, Paper, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { Proposal, ProposalFailure, ProposalKindName } from '../../../shared/proposals'
import { invoke } from '../api'
import { showError } from '../notify'
import { createTicketsView } from './CreateTicketsProposal'
import type { ProposalView } from './proposalView'

/** The card's view of each kind of proposal. */
const VIEWS: Record<ProposalKindName, ProposalView<any, any, any>> = {
  create_tickets: createTicketsView
}

interface Props {
  proposal: Proposal
}

/**
 * A proposal of the orchestrator, where it was proposed in the thread. Pending, it shows what is proposed with
 * Confirm, Override and Reject; Override opens an editor in place. Once decided it is a one-line receipt.
 */
export function ProposalCard({ proposal }: Props): ReactElement {
  const view = VIEWS[proposal.kind]
  return proposal.status === 'pending' ? <Pending proposal={proposal} view={view} /> : <Receipt proposal={proposal} view={view} />
}

function Pending({ proposal, view }: Props & { view: ProposalView<any, any, any> }): ReactElement {
  const [edit, setEdit] = useState<unknown>(null)
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null)
  const editing = edit !== null
  const override = editing ? view.toOverride(edit) : null

  async function decide(kind: 'confirm' | 'reject'): Promise<void> {
    if (busy) return
    setBusy(kind)
    try {
      if (kind === 'reject') await invoke('proposal.reject', proposal.id)
      else if (editing) await invoke('proposal.confirm', proposal.id, override)
      else await invoke('proposal.confirm', proposal.id)
    } catch (err) {
      // The card stays as it is: an invalid override can be fixed, and a decided proposal updates by itself.
      showError(err, kind === 'reject' ? 'Could not reject' : 'Could not confirm')
    } finally {
      setBusy(null)
    }
  }

  const summary = view.summary(proposal.payload)
  return (
    <Paper withBorder p="sm" radius="md" data-proposal="pending" role="group" aria-label={`Proposal: ${summary}`}>
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          {summary}
        </Text>
        {editing ? <view.Editor value={edit} onChange={setEdit} /> : <view.Body payload={proposal.payload} />}
        {proposal.evidence !== null && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }} data-evidence>
            {`Why: ${proposal.evidence}`}
          </Text>
        )}
        <Group gap="xs">
          {editing ? (
            <>
              <Button size="xs" disabled={override === null || busy !== null} loading={busy === 'confirm'} onClick={() => void decide('confirm')}>
                Confirm with changes
              </Button>
              <Button size="xs" variant="default" disabled={busy !== null} onClick={() => setEdit(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="xs" disabled={busy !== null} loading={busy === 'confirm'} onClick={() => void decide('confirm')}>
                Confirm
              </Button>
              <Button size="xs" variant="default" disabled={busy !== null} onClick={() => setEdit(view.initialEdit(proposal.payload))}>
                Override
              </Button>
            </>
          )}
          <Button size="xs" variant="subtle" color="gray" disabled={busy !== null} loading={busy === 'reject'} onClick={() => void decide('reject')}>
            Reject
          </Button>
        </Group>
      </Stack>
    </Paper>
  )
}

function Receipt({ proposal, view }: Props & { view: ProposalView<any, any, any> }): ReactElement {
  let line: ReactElement
  if (proposal.status === 'rejected') {
    line = (
      <Text size="sm" c="dimmed">
        Rejected
      </Text>
    )
  } else if (proposal.status === 'failed') {
    line = (
      <Text size="sm" c="needs.7" style={{ whiteSpace: 'pre-wrap' }}>
        {`Failed: ${(proposal.result as ProposalFailure).error}`}
      </Text>
    )
  } else if (proposal.result === null) {
    line = (
      <Group gap="xs">
        <Loader size={12} type="dots" />
        <Text size="sm" c="dimmed">
          Working…
        </Text>
      </Group>
    )
  } else {
    line = <view.Receipt result={proposal.result} />
  }
  return (
    <Paper withBorder px="sm" py={6} radius="md" data-proposal="receipt" data-status={proposal.status}>
      {line}
    </Paper>
  )
}

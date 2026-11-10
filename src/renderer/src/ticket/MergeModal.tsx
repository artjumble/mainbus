import { Alert, Button, Checkbox, Group, Loader, Modal, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useEffect, useState, type ReactElement } from 'react'
import { mergePlanSentences, SUGGESTION_TEXT, type MergeOutcome, type MergePreview } from '../../../shared/merge'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { errorMessage, showError } from '../notify'
import type { BoardTicket } from '../store'

interface Props {
  opened: boolean
  ticket: Pick<BoardTicket, 'id' | 'number' | 'title'>
  onClose: () => void
}

const DIRTY_MESSAGE = "The merge is done, but the ticket's folder has uncommitted changes, so it stayed in Review. Ask the Implementer to commit them, then move it to Done."
const ASKED_MESSAGE = "The merge is done. Mainbus needs your answer about the ticket's folder before it can move to Done."

/**
 * The confirmation before Merge…: works out what would happen now and says exactly that, or why it can't be done.
 * Merging asks the engine for the same plan again and refuses if it changed.
 */
export function MergeModal({ opened, ticket, onClose }: Props): ReactElement {
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [moveToDone, setMoveToDone] = useState(true)
  const [merging, setMerging] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) return
    let current = true
    setPreview(null)
    setFailure(null)
    setDeleteBranch(false)
    setMoveToDone(true)
    invoke('ticket.mergePreview', ticket.id).then(
      (p) => {
        if (current) setPreview(p)
      },
      (err: unknown) => {
        if (!current) return
        showError(err, "Couldn't check the merge")
        onClose()
      }
    )
    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, ticket.id])

  async function merge(): Promise<void> {
    if (!preview?.ok) return
    const plan = preview.plan
    setMerging(true)
    setFailure(null)
    try {
      const outcome: MergeOutcome = await asOwnChange(ticket.id, () =>
        invoke('ticket.merge', ticket.id, { expect: plan, moveToDone, deleteBranch: plan.kind === 'pull_request' && deleteBranch })
      )
      notifications.show({
        color: 'ready',
        title: `Merged #${ticket.number}`,
        message: [
          plan.kind === 'pull_request' ? `Pull ${plan.base} in your checkout to get it.` : `${plan.base} is up to date.`,
          outcome.fetchError !== null ? `Could not fetch ${plan.base}: ${outcome.fetchError}` : null,
          outcome.moved === 'dirty' ? DIRTY_MESSAGE : outcome.moved === 'asked' ? ASKED_MESSAGE : null
        ]
          .filter((s): s is string => s !== null)
          .join(' ')
      })
      onClose()
    } catch (err) {
      setFailure(errorMessage(err))
    } finally {
      setMerging(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Merge #${ticket.number} ${ticket.title}`}>
      <Stack gap="md">
        {preview === null && <Loader size="sm" aria-label="Checking the merge" />}
        {preview !== null && !preview.ok && (
          <Stack gap={4}>
            <Text size="sm" c="needs.7">
              {preview.reason}
            </Text>
            {preview.suggest !== null && <Text size="sm">{SUGGESTION_TEXT[preview.suggest]}</Text>}
          </Stack>
        )}
        {preview?.ok && (
          <Stack gap="xs">
            {mergePlanSentences(preview.plan).map((sentence) => (
              <Text key={sentence} size="sm">
                {sentence}
              </Text>
            ))}
            {preview.plan.kind === 'pull_request' && (
              <Checkbox
                label="Delete the branch on GitHub afterwards"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
                disabled={merging}
              />
            )}
            <Checkbox
              label="Move to Done afterwards"
              description="Removes the ticket's folder; the branch is kept."
              checked={moveToDone}
              onChange={(e) => setMoveToDone(e.currentTarget.checked)}
              disabled={merging}
            />
          </Stack>
        )}
        {failure !== null && (
          <Alert color="needs" title="The merge didn't happen">
            {failure}
          </Alert>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={merging}>
            Cancel
          </Button>
          <Button onClick={() => void merge()} loading={merging} disabled={!preview?.ok}>
            Merge
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

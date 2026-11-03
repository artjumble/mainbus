import { Button, Group, Loader, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { invoke } from '../api'
import { showError } from '../notify'

interface Props {
  opened: boolean
  /** The Investigate ticket whose report is promoted. */
  ticketId: string
  onClose: () => void
}

interface Draft {
  title: string
  spec: string
  drafted: boolean
}

/** The dialog before Promote: the new Change ticket's title and spec, drafted from the report and editable. */
export function PromoteModal({ opened, ticketId, onClose }: Props): ReactElement {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [promoting, setPromoting] = useState(false)

  useEffect(() => {
    if (!opened) return
    let current = true
    setDraft(null)
    invoke('ticket.draftPromotion', ticketId).then(
      (d) => {
        if (current) setDraft(d)
      },
      (err: unknown) => {
        if (!current) return
        showError(err, "Couldn't draft the new ticket")
        onClose()
      }
    )
    return () => {
      current = false
    }
    // onClose is the parent's; the draft is fetched once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, ticketId])

  async function promote(): Promise<void> {
    if (!draft) return
    setPromoting(true)
    try {
      await invoke('ticket.promote', ticketId, { title: draft.title, spec: draft.spec })
      onClose()
    } catch (err) {
      showError(err, 'Could not promote')
    } finally {
      setPromoting(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Promote to a Change ticket" size="lg">
      {draft === null ? (
        <Group gap="sm">
          <Loader size="sm" />
          <Text size="sm">Drafting the spec from the report…</Text>
        </Group>
      ) : (
        <Stack gap="md">
          <TextInput label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.currentTarget.value })} />
          <Textarea
            label="Spec"
            autosize
            minRows={6}
            maxRows={16}
            value={draft.spec}
            onChange={(e) => setDraft({ ...draft, spec: e.currentTarget.value })}
          />
          {!draft.drafted && (
            <Text size="sm" c="dimmed">
              Couldn't draft a spec; it holds the report.
            </Text>
          )}
          <Text size="sm" c="dimmed">
            The new ticket goes to Ready with your words and the report. This ticket moves to Done.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose} disabled={promoting}>
              Cancel
            </Button>
            <Button onClick={() => void promote()} loading={promoting} disabled={draft.title.trim() === ''}>
              Promote
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}

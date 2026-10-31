import { Button, Checkbox, Group, Modal, Stack, Textarea, TextInput } from '@mantine/core'
import { useState, type FormEvent, type ReactElement } from 'react'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

interface Props {
  opened: boolean
  onClose: () => void
}

/** One criterion per line; blank lines are dropped. */
function splitCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function NewTicketModal({ opened, onClose }: Props): ReactElement {
  const refreshBoard = useMainbus((s) => s.refreshBoard)
  const [title, setTitle] = useState('')
  const [intent, setIntent] = useState('')
  const [spec, setSpec] = useState('')
  const [criteria, setCriteria] = useState('')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)

  const canCreate = title.trim() !== '' && intent.trim() !== ''

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!canCreate || saving) return
    setSaving(true)
    try {
      await invoke('ticket.create', {
        title: title.trim(),
        // Verbatim: the intent is the user's own words, whitespace included.
        intent,
        spec,
        criteria: splitCriteria(criteria),
        labels: [],
        column: ready ? 'ready' : 'backlog'
      })
      setTitle('')
      setIntent('')
      setSpec('')
      setCriteria('')
      setReady(false)
      onClose()
      // The board also refreshes on board.changed; a failure here is not a failed create.
      void refreshBoard().catch((err) => showError(err, 'Could not refresh the board'))
    } catch (err) {
      showError(err, 'Could not create the ticket')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New ticket" size="lg">
      <form onSubmit={(e) => void submit(e)}>
        <Stack gap="sm">
          <TextInput label="Title" required data-autofocus value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          <Textarea
            label="In your words"
            description="Kept exactly as you write it."
            required
            autosize
            minRows={3}
            value={intent}
            onChange={(e) => setIntent(e.currentTarget.value)}
          />
          <Textarea
            label="Spec"
            description="Optional."
            autosize
            minRows={2}
            value={spec}
            onChange={(e) => setSpec(e.currentTarget.value)}
          />
          <Textarea
            label="Acceptance criteria"
            description="One per line."
            autosize
            minRows={2}
            value={criteria}
            onChange={(e) => setCriteria(e.currentTarget.value)}
          />
          <Checkbox
            label="Put it in Ready (otherwise Backlog)"
            checked={ready}
            onChange={(e) => setReady(e.currentTarget.checked)}
          />
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate} loading={saving}>
              Create
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

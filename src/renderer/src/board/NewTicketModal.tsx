import { Badge, Button, Checkbox, Group, Modal, NativeSelect, Radio, Stack, Textarea, TextInput } from '@mantine/core'
import { useState, type ClipboardEvent, type FormEvent, type ReactElement } from 'react'
import type { NewAttachment } from '../../../shared/api'
import type { TicketKind } from '../../../shared/domain'
import { invoke } from '../api'
import { PendingImages } from '../attachments/Attachments'
import { filesOf, readImages } from '../attachments/files'
import { showError } from '../notify'
import { useMainbus } from '../store'

interface Props {
  opened: boolean
  onClose: () => void
}

/** One criterion per line; blank lines are dropped. */
export function splitCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Comma separated; blanks are dropped. */
export function splitLabels(text: string): string[] {
  return text
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '')
}

export function NewTicketModal({ opened, onClose }: Props): ReactElement {
  const refreshBoard = useMainbus((s) => s.refreshBoard)
  const workspaceName = useMainbus((s) => s.workspace?.name)
  const [title, setTitle] = useState('')
  const [intent, setIntent] = useState('')
  const [spec, setSpec] = useState('')
  const [criteria, setCriteria] = useState('')
  const [labels, setLabels] = useState('')
  const [column, setColumn] = useState<'backlog' | 'ready'>('backlog')
  const [startWhenReady, setStartWhenReady] = useState(false)
  const [kind, setKind] = useState<TicketKind>('change')
  const [images, setImages] = useState<NewAttachment[]>([])
  const [saving, setSaving] = useState(false)

  const canCreate = title.trim() !== '' && intent.trim() !== ''

  async function addImages(files: File[]): Promise<void> {
    const read = await readImages(files, images.length)
    if (read.length > 0) setImages((now) => [...now, ...read])
  }

  // A pasted image is added to the ticket's images; pasted text goes into the field as usual.
  function onPaste(e: ClipboardEvent): void {
    const files = filesOf(e.clipboardData)
    if (files.length === 0) return
    if (e.clipboardData.getData('text/plain') === '') e.preventDefault()
    void addImages(files)
  }

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
        labels: splitLabels(labels),
        column,
        kind,
        ...(startWhenReady ? { startWhenReady } : {}),
        ...(images.length > 0 ? { attachments: images } : {})
      })
      setTitle('')
      setIntent('')
      setSpec('')
      setCriteria('')
      setLabels('')
      setColumn('backlog')
      setStartWhenReady(false)
      setKind('change')
      setImages([])
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
      <form onSubmit={(e) => void submit(e)} onPaste={onPaste}>
        <Stack gap="sm">
          {workspaceName && (
            <Badge variant="outline" color="gray" size="sm" radius="sm" tt="none" w="fit-content">
              {workspaceName}
            </Badge>
          )}
          <Radio.Group label="Kind" value={kind} onChange={(v) => setKind(v as TicketKind)}>
            <Group mt={4} align="flex-start">
              <Radio value="change" label="Change" />
              <Radio value="investigate" label="Investigate" description="Finds out and writes a report; changes no code" />
            </Group>
          </Radio.Group>
          <TextInput label="Title" required data-autofocus placeholder="What needs doing" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
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
            placeholder="Context the agent will need"
            autosize
            minRows={2}
            value={spec}
            onChange={(e) => setSpec(e.currentTarget.value)}
          />
          <Textarea
            label="Acceptance criteria"
            description="One per line."
            placeholder="How you'll know it's done"
            autosize
            minRows={2}
            value={criteria}
            onChange={(e) => setCriteria(e.currentTarget.value)}
          />
          <TextInput
            label="Labels"
            description="Comma separated."
            value={labels}
            onChange={(e) => setLabels(e.currentTarget.value)}
          />
          <PendingImages
            images={images}
            onAdd={(files) => void addImages(files)}
            onRemove={(i) => setImages((now) => now.filter((_, j) => j !== i))}
          />
          <NativeSelect
            label="Column"
            data={[
              { value: 'backlog', label: 'Backlog' },
              { value: 'ready', label: 'Ready' }
            ]}
            value={column}
            onChange={(e) => setColumn(e.currentTarget.value as 'backlog' | 'ready')}
          />
          <Checkbox
            label="Ask the orchestrator to start an agent once it's in Ready"
            checked={startWhenReady}
            onChange={(e) => setStartWhenReady(e.currentTarget.checked)}
          />
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate} loading={saving}>
              Create ticket
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

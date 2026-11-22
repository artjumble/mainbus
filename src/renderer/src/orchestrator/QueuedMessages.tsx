import { Box, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import { queuedLabel } from '../../../shared/queue'
import type { OrchestratorQueue, QueuedMessage } from '../../../shared/events'
import { SentImages } from '../attachments/Attachments'
import { hasMod } from '../platform'
import { MentionText } from '../thread/MentionText'

interface Props {
  queue: OrchestratorQueue
  /** Rejects (after reporting why) when the words couldn't be changed; the editor then stays open. */
  onEdit: (id: string, text: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onSendNow: (id: string) => Promise<void>
}

/**
 * The messages the user sent while the orchestrator was working, below the thread as pending bubbles, each with its
 * place in the order. The container is always mounted, so a screen reader announces a message when it is queued.
 */
export function QueuedMessages({ queue, onEdit, onRemove, onSendNow }: Props): ReactElement {
  const { items, held } = queue
  return (
    <div aria-live="polite" data-queued-messages>
      {items.length > 0 && (
        <Stack gap={6} px="md" py={4}>
          {held !== null && (
            <Text size="xs" c="needs" data-queue-held>
              {held}
            </Text>
          )}
          <Stack component="ol" aria-label="Queued messages" gap={6} m={0} p={0} mah={220} style={{ listStyle: 'none', overflowY: 'auto' }}>
            {items.map((item, i) => (
              <Queued key={item.id} item={item} place={i + 1} onEdit={onEdit} onRemove={onRemove} onSendNow={onSendNow} />
            ))}
          </Stack>
        </Stack>
      )}
    </div>
  )
}

function Queued({
  item,
  place,
  onEdit,
  onRemove,
  onSendNow
}: { item: QueuedMessage; place: number } & Pick<Props, 'onEdit' | 'onRemove' | 'onSendNow'>): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const editing = draft !== null
  // A message of only images has no words to edit.
  const canSave = draft !== null && (draft.trim() !== '' || item.images.length > 0)

  async function save(): Promise<void> {
    if (draft === null || !canSave || saving) return
    setSaving(true)
    try {
      await onEdit(item.id, draft.trim())
      setDraft(null)
    } catch {
      // Reported by the caller; the editor stays open with the words.
    } finally {
      setSaving(false)
    }
  }

  return (
    <li style={{ alignSelf: 'flex-end', maxWidth: '90%', width: editing ? '100%' : undefined }} data-queued={item.id}>
      <Paper withBorder p="sm" radius="md" style={{ borderStyle: 'dashed', opacity: editing ? 1 : 0.85 }}>
        <Text size="xs" c="dimmed" fw={600} mb={2}>
          {queuedLabel(place)}
        </Text>
        {item.images.length > 0 && (
          <Box mb={item.text === '' ? 0 : 6}>
            <SentImages images={item.images} />
          </Box>
        )}
        {editing ? (
          <Textarea
            aria-label={`Edit queued message ${place}`}
            autosize
            minRows={2}
            maxRows={8}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setDraft(null)
              } else if (e.key === 'Enter' && hasMod(e)) {
                e.preventDefault()
                void save()
              }
            }}
          />
        ) : (
          item.text !== '' && <MentionText text={item.text} />
        )}
        <Group gap="xs" mt={6} justify="flex-end" wrap="wrap">
          {editing ? (
            <>
              <Button size="compact-xs" variant="default" aria-label={`Cancel editing queued message ${place}`} onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="compact-xs" disabled={!canSave} loading={saving} aria-label={`Save queued message ${place}`} onClick={() => void save()}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button size="compact-xs" variant="default" aria-label={`Edit queued message ${place}`} onClick={() => setDraft(item.text)}>
                Edit
              </Button>
              <Button size="compact-xs" variant="default" aria-label={`Remove queued message ${place}`} onClick={() => void onRemove(item.id)}>
                Remove
              </Button>
              <Button size="compact-xs" variant="light" aria-label={`Send queued message ${place} now`} onClick={() => void onSendNow(item.id)}>
                Send now
              </Button>
            </>
          )}
        </Group>
      </Paper>
    </li>
  )
}

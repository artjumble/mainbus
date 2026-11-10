import { Alert, Badge, Button, Checkbox, Group, Modal, NativeSelect, Radio, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { DictationTextarea } from '../voice/DictationTextarea'
import { useEffect, useState, type ClipboardEvent, type FormEvent, type ReactElement } from 'react'
import type { NewAttachment } from '../../../shared/api'
import type { LineupPreset, LineupRole, TicketKind } from '../../../shared/domain'
import { findPreset, presetRunSettings } from '../../../shared/runSettings'
import { invoke } from '../api'
import { PendingImages } from '../attachments/Attachments'
import { filesOf, readImages } from '../attachments/files'
import { showError } from '../notify'
import { useMainbus } from '../store'
import { BlockedByPicker } from '../ticket/BlockedByPicker'

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
  const [blockedBy, setBlockedBy] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [presets, setPresets] = useState<LineupPreset[]>([])
  const [changeLineup, setChangeLineup] = useState<LineupRole[]>([])
  /** The chosen preset's name; '' means the lineup's defaults. */
  const [preset, setPreset] = useState('')

  // Read on every opening, so presets edited in the settings show up. Without them the dialog works as before.
  useEffect(() => {
    if (!opened) return
    let cancelled = false
    Promise.all([invoke('preset.list'), invoke('lineup.get', 'change')]).then(
      ([listed, lineup]) => {
        if (cancelled) return
        setPresets(listed)
        setChangeLineup(lineup)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [opened])

  const chosenPreset = kind === 'change' && preset !== '' ? findPreset(presets, preset) : undefined
  const presetNotices = chosenPreset ? presetRunSettings(chosenPreset, changeLineup).notices : []

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
        ...(chosenPreset ? { preset: chosenPreset.name } : {}),
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
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
      setPreset('')
      setImages([])
      setBlockedBy([])
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
          <DictationTextarea
            label="In your words"
            description="Kept exactly as you write it."
            required
            autosize
            minRows={3}
            value={intent}
            onValueChange={setIntent}
          />
          <DictationTextarea
            label="Spec"
            description="Optional."
            placeholder="Context the agent will need"
            autosize
            minRows={2}
            value={spec}
            onValueChange={setSpec}
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
          {kind === 'change' && presets.length > 0 && (
            <NativeSelect
              label="Preset"
              description="Which roles run, and with which models."
              data={[{ value: '', label: 'Lineup defaults' }, ...presets.map((p) => ({ value: p.name, label: p.name }))]}
              value={preset}
              onChange={(e) => setPreset(e.currentTarget.value)}
            />
          )}
          {presetNotices.length > 0 && (
            <Alert color="needs" variant="light" p="xs" title="Part of this preset doesn't fit the lineup">
              <Stack gap={2}>
                {presetNotices.map((n) => (
                  <Text key={n} size="sm">
                    {n}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}
          <BlockedByPicker value={blockedBy} onChange={setBlockedBy} />
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

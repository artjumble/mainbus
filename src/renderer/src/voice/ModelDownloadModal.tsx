import { Button, Group, Modal, Progress, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import { voiceModelSize, voiceModelSourceUrl, type VoiceModelSpec, type VoiceModelStatus } from '../../../shared/voice'

const mb = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`

/**
 * Asks before the speech model is downloaded, and shows the download. It says what is fetched, from where, how big it is and
 * where it goes, and that audio never leaves the computer. Nothing is downloaded until Download is pressed.
 */
export function ModelDownloadModal({
  opened,
  model,
  status,
  onClose,
  onDownload,
  onCancel
}: {
  opened: boolean
  model: VoiceModelSpec
  status: VoiceModelStatus | undefined
  onClose: () => void
  onDownload: () => void
  onCancel: () => void
}): ReactElement {
  const download = status?.download ?? null
  const installed = status?.installed === true
  const size = voiceModelSize(model)
  const percent = download && download.total > 0 ? Math.round((download.loaded / download.total) * 100) : 0
  return (
    <Modal opened={opened} onClose={() => {
        // Closing the dialog during a download stops it.
        if (download) onCancel()
        onClose()
      }} title="Download the speech model" size="md">
      <Stack gap="sm">
        {installed ? (
          <Text>Ready. Press the mic to dictate.</Text>
        ) : (
          <>
            <Text size="sm">
              To turn speech into text on this computer, Mainbus needs the {model.label} model ({mb(size)}). It is downloaded once.
            </Text>
            <Text size="sm" component="div">
              From: <Text span ff="monospace" size="xs">{voiceModelSourceUrl(model, '')}</Text>
            </Text>
            <Text size="sm">Into: the models folder of Mainbus&apos;s data folder.</Text>
            <Text size="sm">Audio never leaves your computer, and recordings are not kept.</Text>
          </>
        )}
        {download && (
          <Stack gap={4}>
            <Progress value={percent} aria-label="Download progress" />
            <Text size="xs" c="dimmed" role="status">
              {mb(download.loaded)} of {mb(download.total)}
            </Text>
          </Stack>
        )}
        {status?.error && (
          <Text size="sm" c="red" role="alert">
            {status.error}
          </Text>
        )}
        <Group justify="flex-end">
          {installed ? (
            <Button onClick={onClose}>Close</Button>
          ) : download ? (
            <Button variant="default" onClick={onCancel}>
              Cancel download
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={onClose}>
                Not now
              </Button>
              <Button onClick={onDownload}>Download {mb(size)}</Button>
            </>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}

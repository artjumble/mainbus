import { Button, Group, NativeSelect, Progress, Stack, Switch, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import {
  isVoiceModelId,
  VOICE_DEFAULTS,
  VOICE_MODELS,
  voiceModelSize,
  WHISPER_LANGUAGES,
  type VoiceModelId,
  type VoiceModelStatus,
  type VoiceSettings as VoiceSettingsValue
} from '../../../shared/voice'
import { invoke, onEngineEvent } from '../api'
import { showError } from '../notify'

const mb = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`

/** The audio inputs the system has; empty until read, and re-read when a device is plugged in or removed. */
function useMicrophones(opened: boolean): { id: string; label: string }[] {
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([])
  useEffect(() => {
    const media = navigator.mediaDevices
    if (!opened || !media?.enumerateDevices) return
    let alive = true
    const read = (): void => {
      void media
        .enumerateDevices()
        .then((all) => {
          if (!alive) return
          const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
          setDevices(inputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })))
        })
        .catch(() => {})
    }
    read()
    media.addEventListener?.('devicechange', read)
    return () => {
      alive = false
      media.removeEventListener?.('devicechange', read)
    }
  }, [opened])
  return devices
}

/** "Voice input": on or off, the model (downloaded on request), the language and the microphone. */
export function VoiceSettings({ opened }: { opened: boolean }): ReactElement {
  const [voice, setVoice] = useState<VoiceSettingsValue>(VOICE_DEFAULTS)
  const [models, setModels] = useState<VoiceModelStatus[]>([])
  const microphones = useMicrophones(opened)

  useEffect(() => {
    if (!opened) return
    let alive = true
    invoke('settings.get')
      .then((s) => alive && s?.voice && setVoice(s.voice))
      .catch((err: unknown) => alive && showError(err, 'Could not load the settings'))
    invoke('voice.models')
      .then((m) => alive && Array.isArray(m) && setModels(m))
      .catch(() => {})
    const off = onEngineEvent((e) => {
      if (e.type === 'voice.changed') setVoice(e.voice)
      if (e.type === 'voice.models') setModels(e.models)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [opened])

  async function save(patch: Partial<VoiceSettingsValue>): Promise<void> {
    try {
      const settings = await invoke('settings.setVoice', patch)
      if (settings?.voice) setVoice(settings.voice)
    } catch (err) {
      showError(err, 'Could not save the settings')
    }
  }

  async function modelAction(command: 'voice.downloadModel' | 'voice.cancelDownload' | 'voice.removeModel', id: VoiceModelId): Promise<void> {
    try {
      const next = await invoke(command, id)
      if (Array.isArray(next)) setModels(next)
    } catch (err) {
      showError(err, 'Could not change the voice model')
    }
  }

  const spec = VOICE_MODELS.find((m) => m.id === voice.model) ?? VOICE_MODELS[0]!
  const status = models.find((m) => m.id === voice.model)
  const download = status?.download ?? null
  const missing = voice.microphone !== '' && microphones.length > 0 && !microphones.some((d) => d.id === voice.microphone)

  return (
    <Stack gap="sm">
      <Switch
        label="Voice input"
        description="A mic button in long-form text fields turns your speech into text on this computer. Nothing is uploaded and recordings are not kept."
        checked={voice.enabled}
        onChange={(e) => void save({ enabled: e.currentTarget.checked })}
      />
      <Group gap="sm" wrap="nowrap" align="end">
        <NativeSelect
          label="Model"
          w={220}
          disabled={!voice.enabled}
          data={VOICE_MODELS.map((m) => ({ value: m.id, label: `${m.label} (${mb(voiceModelSize(m))})` }))}
          value={voice.model}
          onChange={(e) => {
            const id = e.currentTarget.value
            if (isVoiceModelId(id)) void save({ model: id })
          }}
        />
        <NativeSelect
          label="Language"
          w={180}
          disabled={!voice.enabled}
          data={[{ value: 'auto', label: 'Automatic (English)' }, ...Object.entries(WHISPER_LANGUAGES).map(([value, label]) => ({ value, label }))]}
          value={voice.language}
          onChange={(e) => void save({ language: e.currentTarget.value })}
        />
      </Group>
      <Stack gap={4}>
        <Text size="xs" c="dimmed" role="status">
          {download
            ? `Downloading ${spec.label}: ${mb(download.loaded)} of ${mb(download.total)}`
            : status?.installed
              ? `${spec.label} is downloaded.`
              : `${spec.label} is not downloaded yet. It is fetched once (${mb(voiceModelSize(spec))}) from huggingface.co when you press Download, or when you first press a mic button and agree.`}
        </Text>
        {download && <Progress value={download.total > 0 ? (download.loaded / download.total) * 100 : 0} aria-label="Download progress" />}
        {status?.error && (
          <Text size="xs" c="red" role="alert">
            {status.error}
          </Text>
        )}
        <Group gap="xs">
          {download ? (
            <Button size="compact-sm" variant="default" onClick={() => void modelAction('voice.cancelDownload', spec.id)}>
              Cancel download
            </Button>
          ) : status?.installed ? (
            <Button size="compact-sm" variant="default" onClick={() => void modelAction('voice.removeModel', spec.id)}>
              Remove {spec.label}
            </Button>
          ) : (
            <Button size="compact-sm" onClick={() => void modelAction('voice.downloadModel', spec.id)}>
              Download {spec.label}
            </Button>
          )}
        </Group>
      </Stack>
      <Text size="xs" c="dimmed">
        Whisper can&apos;t tell the language by itself here: Automatic means English. Choose the language you speak if it is another.
      </Text>
      <NativeSelect
        label="Microphone"
        w={320}
        disabled={!voice.enabled}
        data={[
          { value: '', label: 'System default' },
          ...(missing ? [{ value: voice.microphone, label: 'Saved microphone (not connected)' }] : []),
          ...microphones.map((d) => ({ value: d.id, label: d.label }))
        ]}
        value={voice.microphone}
        onChange={(e) => void save({ microphone: e.currentTarget.value })}
      />
      {missing && (
        <Text size="xs" c="dimmed">
          The saved microphone isn&apos;t connected, so dictation uses the system default.
        </Text>
      )}
    </Stack>
  )
}

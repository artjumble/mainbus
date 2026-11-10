import { Group, NativeSelect, NumberInput, Stack, Switch, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { REVIEW_DONE_WAIT_DEFAULT, REVIEW_DONE_WAIT_MAX, REVIEW_DONE_WAIT_MIN, type Effort } from '../../../shared/domain'
import { EFFORTS, effortLabel } from '../../../shared/models'
import { ORCHESTRATOR_MODEL_NOTE, type OrchestratorFamily } from '../../../shared/orchestratorModel'
import { invoke } from '../api'
import { showError } from '../notify'
import { useOrchestratorModel } from '../orchestrator/useOrchestratorModel'

const EFFORT_CHOICES = EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))

/**
 * The orchestrator's model (the latest Fable, Opus or Sonnet that the user's `claude` offers) and effort. A change
 * applies from its next turn; the engine's event brings the new state back.
 */
function OrchestratorModelSettings(): ReactElement {
  const state = useOrchestratorModel()

  async function save(change: { model: OrchestratorFamily } | { effort: Effort }): Promise<void> {
    try {
      await ('model' in change
        ? invoke('settings.setOrchestratorModel', change.model)
        : invoke('settings.setOrchestratorEffort', change.effort))
    } catch (err) {
      showError(err, 'Could not save the settings')
    }
  }

  return (
    <Stack gap={6}>
      <Group gap="sm" wrap="nowrap" align="end">
        <NativeSelect
          label="Model"
          w={160}
          data={state ? state.options.map((o) => ({ value: o.family, label: o.label })) : []}
          value={state?.current.family ?? ''}
          disabled={state === null}
          onChange={(e) => void save({ model: e.currentTarget.value as OrchestratorFamily })}
        />
        <NativeSelect
          label="Effort"
          w={120}
          data={EFFORT_CHOICES}
          value={state?.effort ?? ''}
          disabled={state === null}
          onChange={(e) => void save({ effort: e.currentTarget.value as Effort })}
        />
      </Group>
      <Text size="xs" c="dimmed">
        {ORCHESTRATOR_MODEL_NOTE}
      </Text>
      {state?.notice && (
        <Text size="xs" c="needs" data-model-notice>
          {state.notice}
        </Text>
      )}
    </Stack>
  )
}

/** The orchestrator's model and effort, and "Let the orchestrator read web pages". */
export function OrchestratorSettings({ opened }: { opened: boolean }): ReactElement {
  const [webAccess, setWebAccess] = useState<boolean | null>(null)
  const [review, setReview] = useState<{ on: boolean; waitMinutes: number } | null>(null)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('settings.get')
      .then((settings) => {
        if (cancelled || !settings) return
        setWebAccess(settings.orchestratorWebAccess)
        setReview({ on: settings.reviewDoneTickets ?? true, waitMinutes: settings.reviewDoneWaitMinutes ?? REVIEW_DONE_WAIT_DEFAULT })
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  async function save(on: boolean): Promise<void> {
    const previous = webAccess
    setWebAccess(on)
    try {
      const settings = await invoke('settings.setOrchestratorWebAccess', on)
      setWebAccess(settings.orchestratorWebAccess)
    } catch (err) {
      setWebAccess(previous)
      showError(err, 'Could not save the settings')
    }
  }

  async function saveReview(change: { on: boolean } | { waitMinutes: number }): Promise<void> {
    const previous = review
    if (review) setReview({ ...review, ...change })
    try {
      const settings = await invoke('settings.setReviewDone', change)
      setReview({ on: settings.reviewDoneTickets, waitMinutes: settings.reviewDoneWaitMinutes })
    } catch (err) {
      setReview(previous)
      showError(err, 'Could not save the settings')
    }
  }

  return (
    <Stack gap="md">
      {opened && <OrchestratorModelSettings />}
      <Switch
        label="Review finished tickets for follow-ups"
        description="When a ticket that ran reaches Done, the orchestrator reads what its agents left behind and proposes follow-up tickets for you to confirm. These turns use your plan, and a run of tickets finishing together is one review."
        checked={review?.on ?? true}
        disabled={review === null}
        onChange={(e) => void saveReview({ on: e.currentTarget.checked })}
      />
      <NumberInput
        label="Wait before reviewing (minutes)"
        description="How long after the last ticket reached Done the orchestrator waits, so a run of merges becomes one review."
        value={review?.waitMinutes ?? REVIEW_DONE_WAIT_DEFAULT}
        min={REVIEW_DONE_WAIT_MIN}
        max={REVIEW_DONE_WAIT_MAX}
        allowDecimal={false}
        allowNegative={false}
        clampBehavior="strict"
        disabled={review === null || !review.on}
        onChange={(v) => {
          if (typeof v === 'number' && Number.isInteger(v) && v >= REVIEW_DONE_WAIT_MIN && v <= REVIEW_DONE_WAIT_MAX) void saveReview({ waitMinutes: v })
        }}
      />
      <Switch
        label="Let the orchestrator read web pages"
        description="It can open pages you link and search the web. Pages are read as data, never as instructions; addresses on this computer or your local network are always refused."
        checked={webAccess ?? true}
        disabled={webAccess === null}
        onChange={(e) => void save(e.currentTarget.checked)}
      />
    </Stack>
  )
}

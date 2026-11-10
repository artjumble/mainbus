import { Group, NativeSelect, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { Effort } from '../../../shared/domain'
import { EFFORT_OPTIONS, effortLabel, modelLabel } from '../../../shared/models'
import type { RoleChoice } from '../../../shared/runSettings'
import { useModelOptions } from '../useModelOptions'

export type { RoleChoice }

/** The options plus, when the stored value isn't one of them, that value, so the select never misreports it. */
export function withCurrent(
  options: { value: string; label: string }[],
  current: string,
  label: (value: string) => string = (v) => v
): { value: string; label: string }[] {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label: label(current) }]
}

interface Props {
  choice: RoleChoice
  onChange: (patch: Partial<RoleChoice>) => void
  disabled?: boolean
}

/** A role's name, then its model and effort selects, on one line; both are off while the role is unticked. */
export function ModelEffortRow({ choice, onChange, disabled = false }: Props): ReactElement {
  const models = useModelOptions()
  const effortOptions = withCurrent(EFFORT_OPTIONS, choice.effort).map((o) => ({ ...o, label: effortLabel(o.value) }))
  return (
    <Group gap="xs" wrap="nowrap" role="group" aria-label={choice.name}>
      <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
        {choice.name}
      </Text>
      <NativeSelect
        size="xs"
        w={100}
        aria-label={`Model for ${choice.name}`}
        data={withCurrent(models, choice.model, modelLabel)}
        value={choice.model}
        disabled={disabled || !choice.ticked}
        onChange={(e) => onChange({ model: e.currentTarget.value })}
      />
      <NativeSelect
        size="xs"
        w={100}
        aria-label={`Effort for ${choice.name}`}
        data={effortOptions}
        value={choice.effort}
        disabled={disabled || !choice.ticked}
        onChange={(e) => onChange({ effort: e.currentTarget.value as Effort })}
      />
    </Group>
  )
}

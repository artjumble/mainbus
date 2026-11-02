import { Checkbox, Group, NativeSelect } from '@mantine/core'
import type { ReactElement } from 'react'
import type { Effort } from '../../../shared/domain'
import { EFFORT_OPTIONS, MODEL_OPTIONS, effortLabel } from '../../../shared/models'

/** One role of a start being chosen: whether it runs, and with which model and effort. */
export interface RoleChoice {
  roleId: string
  name: string
  ticked: boolean
  model: string
  effort: Effort
}

/** The options plus, when the stored value isn't one of them, that value, so the select never misreports it. */
export function withCurrent(options: { value: string; label: string }[], current: string): { value: string; label: string }[] {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }]
}

interface Props {
  choice: RoleChoice
  onChange: (patch: Partial<RoleChoice>) => void
  /** The box can't be unticked: it is the last one ticked. */
  keepTicked?: boolean
}

/** A role's box, then its model and effort selects, on one line. */
export function RoleChoiceRow({ choice, onChange, keepTicked = false }: Props): ReactElement {
  const effortOptions = withCurrent(EFFORT_OPTIONS, choice.effort).map((o) => ({ ...o, label: effortLabel(o.value) }))
  return (
    <Group gap="xs" wrap="nowrap" role="group" aria-label={choice.name}>
      <Checkbox
        label={choice.name}
        style={{ flex: 1, minWidth: 0 }}
        checked={choice.ticked}
        disabled={keepTicked && choice.ticked}
        onChange={(e) => onChange({ ticked: e.currentTarget.checked })}
      />
      <NativeSelect
        size="xs"
        w={100}
        aria-label={`Model for ${choice.name}`}
        data={withCurrent(MODEL_OPTIONS, choice.model)}
        value={choice.model}
        disabled={!choice.ticked}
        onChange={(e) => onChange({ model: e.currentTarget.value })}
      />
      <NativeSelect
        size="xs"
        w={100}
        aria-label={`Effort for ${choice.name}`}
        data={effortOptions}
        value={choice.effort}
        disabled={!choice.ticked}
        onChange={(e) => onChange({ effort: e.currentTarget.value as Effort })}
      />
    </Group>
  )
}

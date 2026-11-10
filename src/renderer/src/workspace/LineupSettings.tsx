import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  ActionIcon,
  Alert,
  Button,
  Collapse,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
  UnstyledButton
} from '@mantine/core'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ROLE_PHASES, type Effort, type Lineup, type LineupRole, type RolePhase, type ToolProfile } from '../../../shared/domain'
import { DEFAULT_MODELS, EFFORT_OPTIONS, OTHER_ROLE_DEFAULT, modelLabel } from '../../../shared/models'
import { invoke } from '../api'
import { useModelOptions } from '../useModelOptions'
import { phaseLabel } from '../board/TicketCard'
import { withCurrent } from '../ticket/RoleChoice'
import { errorMessage, showError } from '../notify'
import { PresetSettings } from './PresetSettings'
import { moveRole, newRole, removeRole, sameLineup, toDraft, type DraftRole } from './lineupDraft'

/** "" stands for null ("Orchestrator decides", "Previous role"), which a native select cannot hold as a value. */
const DEFAULT = ''
const EFFORTS = [{ value: DEFAULT, label: 'Orchestrator decides' }, ...EFFORT_OPTIONS]

/** "Planner Opus, high effort; …; any other role Sonnet, medium effort", from the default table. */
function defaultsText(): string {
  return [...DEFAULT_MODELS, { name: 'any other role', ...OTHER_ROLE_DEFAULT }]
    .map((d) => `${d.name} ${modelLabel(d.model)}, ${d.effort} effort`)
    .join('; ')
}
const PHASES = ROLE_PHASES.map((p) => ({ value: p, label: phaseLabel(p) }))
const TOOL_PROFILES: { value: ToolProfile; label: string }[] = [
  { value: 'read_only', label: 'Read only (no file edits)' },
  { value: 'edit', label: 'Can edit files' }
]

/** What a role does, in a line: the first sentence of its instructions. */
export function firstSentence(instructions: string): string {
  const text = instructions.trim().replace(/\s+/g, ' ')
  if (text === '') return 'No instructions yet'
  const end = text.search(/[.!?](\s|$)/)
  const sentence = end === -1 ? text : text.slice(0, end + 1)
  return sentence.length > 100 ? `${sentence.slice(0, 99)}…` : sentence
}

/** The name to show for a role, even while its name field is empty. */
function displayName(role: DraftRole, index: number): string {
  return role.name.trim() || `Role ${index + 1}`
}

interface Props {
  opened: boolean
}

const LINEUP_TEXT: Record<Lineup, string> = {
  change: 'Change tickets are worked by these roles in turn, top to bottom. Drag a role, or use its arrows, to reorder.',
  investigate:
    'Investigate tickets are worked by these roles in turn, top to bottom. The last role ends with a report instead of a handoff. Drag a role, or use its arrows, to reorder.'
}

/** What happens to the ticket when the last role is done. */
const AFTER_LAST: Record<Lineup, string> = {
  change: 'Ticket moves to Ready for review, waiting on you.',
  investigate: 'The report is saved and the ticket moves to Review, waiting on you.'
}

/** The workspace's lineups, one tab each. Both editors stay mounted, so unsaved edits survive a tab switch. */
export function LineupSettings({ opened }: Props): ReactElement {
  // Bumped when the Change lineup is saved, so the presets below are read against its new roles.
  const [changeSaves, setChangeSaves] = useState(0)
  return (
    <Stack gap="sm" component="section" aria-labelledby="lineup-heading">
      <Title order={3} size="h4" id="lineup-heading">
        Lineup
      </Title>
      <Tabs defaultValue="change" keepMounted>
        <Tabs.List>
          <Tabs.Tab value="change">Change</Tabs.Tab>
          <Tabs.Tab value="investigate">Investigate</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="change" pt="sm">
          <LineupEditor opened={opened} lineup="change" onSaved={() => setChangeSaves((n) => n + 1)} />
        </Tabs.Panel>
        <Tabs.Panel value="investigate" pt="sm">
          <LineupEditor opened={opened} lineup="investigate" />
        </Tabs.Panel>
      </Tabs>
      <PresetSettings opened={opened} lineupVersion={changeSaves} />
    </Stack>
  )
}

/** One lineup: the roles that work a ticket of that kind in turn. One Save writes the whole lineup. */
export function LineupEditor({ opened, lineup: kind, onSaved }: Props & { lineup: Lineup; onSaved?: () => void }): ReactElement {
  // The saved lineup is what Save compares against, and what stays on screen after a save.
  const [saved, setSaved] = useState<DraftRole[] | null>(null)
  const [roles, setRoles] = useState<DraftRole[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Moving a row moves its buttons in the DOM, which drops focus; this puts it back after Move up/down.
  const [refocus, setRefocus] = useState<{ id: string; direction: 'up' | 'down' } | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  function adopt(lineup: LineupRole[], selectIndex = 0): void {
    const drafts = lineup.map(toDraft)
    setSaved(drafts)
    setRoles(drafts)
    setSelectedId(drafts[Math.min(selectIndex, drafts.length - 1)]?.id ?? null)
  }

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    setError(null)
    void invoke('lineup.get', kind)
      .then((lineup) => {
        if (!cancelled) adopt(lineup)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the lineup')
      })
    return () => {
      cancelled = true
    }
  }, [opened, kind])

  useEffect(() => {
    if (refocus === null) return
    setRefocus(null)
    const row = listRef.current?.querySelector(`[data-role-id="${CSS.escape(refocus.id)}"]`)
    const button = (direction: string): HTMLButtonElement | null | undefined =>
      row?.querySelector<HTMLButtonElement>(`button[data-move="${direction}"]:not(:disabled)`)
    // At the top or bottom the arrow just used is disabled, so focus goes to the other one.
    ;(button(refocus.direction) ?? button(refocus.direction === 'up' ? 'down' : 'up'))?.focus()
  }, [refocus])

  function change(next: DraftRole[]): void {
    setRoles(next)
    setError(null)
  }

  function update(id: string, patch: Partial<DraftRole>): void {
    change(roles.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function move(index: number, to: number): void {
    const next = moveRole(roles, index, to)
    if (next === roles) return
    change(next)
    setRefocus({ id: roles[index]!.id, direction: to < index ? 'up' : 'down' })
  }

  function remove(id: string): void {
    const index = roles.findIndex((r) => r.id === id)
    const next = removeRole(roles, id)
    change(next)
    if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null)
  }

  function add(): void {
    const role = newRole(roles)
    change([...roles, role])
    setSelectedId(role.id)
  }

  function onDragEnd({ active, over }: DragEndEvent): void {
    if (!over) return
    const from = roles.findIndex((r) => r.id === active.id)
    const to = roles.findIndex((r) => r.id === over.id)
    if (from >= 0 && to >= 0) change(moveRole(roles, from, to))
  }

  const dirty = saved !== null && !sameLineup(roles, saved)

  async function save(): Promise<void> {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const selectedIndex = Math.max(0, roles.findIndex((r) => r.id === selectedId))
      adopt(await invoke('lineup.save', roles, kind), selectedIndex)
      onSaved?.()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const selectedIndex = roles.findIndex((r) => r.id === selectedId)
  const selected = selectedIndex >= 0 ? roles[selectedIndex]! : null

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {LINEUP_TEXT[kind]}
      </Text>

      {/* The roles on the left, the open role's form on the right. */}
      <SimpleGrid cols={2} spacing="md" verticalSpacing="md">
        <Stack gap="sm" miw={0}>
          <Text size="xs" fw={700} tt="uppercase" lts="0.04em" c="dimmed">
            Roles, in order
          </Text>
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <Stack component="ol" gap={6} ref={listRef} style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Roles">
              {roles.map((role, i) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  index={i}
                  count={roles.length}
                  selected={role.id === selectedId}
                  onSelect={() => setSelectedId(role.id)}
                  onMove={(to) => move(i, to)}
                  onRemove={() => remove(role.id)}
                />
              ))}
            </Stack>
          </DndContext>
          <Button variant="default" fullWidth onClick={add} styles={{ root: { borderStyle: 'dashed' } }}>
            <span aria-hidden>+ </span>Add role
          </Button>
          <Paper withBorder p="sm" radius="md" data-after-last-role>
            <Text size="xs" fw={700} tt="uppercase" lts="0.04em" c="dimmed" mb={2}>
              After the last role
            </Text>
            <Text size="sm">{AFTER_LAST[kind]}</Text>
          </Paper>
        </Stack>

        {selected && (
          <RoleForm
            key={selected.id}
            role={selected}
            index={selectedIndex}
            earlier={roles.slice(0, selectedIndex)}
            canRemove={roles.length > 1}
            onRemove={() => remove(selected.id)}
            onChange={(patch) => update(selected.id, patch)}
          />
        )}
      </SimpleGrid>

      {error && (
        <Alert color="needs" title="Could not save the lineup">
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button onClick={() => void save()} disabled={!dirty} loading={saving}>
          Save lineup
        </Button>
      </Group>
    </Stack>
  )
}

interface RowProps {
  role: DraftRole
  index: number
  count: number
  selected: boolean
  onSelect: () => void
  onMove: (to: number) => void
  onRemove: () => void
}

function RoleRow({ role, index, count, selected, onSelect, onMove, onRemove }: RowProps): ReactElement {
  const drag = useDraggable({ id: role.id })
  const drop = useDroppable({ id: role.id })
  const name = displayName(role, index)
  const { transform } = drag

  return (
    <Paper
      component="li"
      data-role-id={role.id}
      withBorder
      p={6}
      ref={(node: HTMLLIElement | null) => {
        drag.setNodeRef(node)
        drop.setNodeRef(node)
      }}
      bg={selected ? 'var(--mantine-color-default-hover)' : undefined}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        position: 'relative',
        zIndex: drag.isDragging ? 1 : undefined,
        // The open role: the form below edits this one.
        borderColor: selected ? 'var(--mantine-primary-color-filled)' : undefined,
        outline: drop.isOver && !drag.isDragging ? '2px solid var(--mantine-primary-color-filled)' : undefined
      }}
    >
      {/* Small buttons side by side sit 44 px apart centre to centre, so their hit areas don't overlap. */}
      <Group gap={16} wrap="nowrap" align="flex-start">
        {/* Pointer-only: by keyboard, the Move up and Move down buttons reorder, so the handle is not a tab stop. */}
        <ActionIcon variant="subtle" color="gray" aria-label={`Drag ${name}`} style={{ cursor: 'grab' }} {...drag.attributes} {...drag.listeners} tabIndex={-1}>
          <span aria-hidden>⠿</span>
        </ActionIcon>
        <Stack gap={0} flex={1} miw={0}>
          <Group gap={6} wrap="nowrap">
            {/* The button holds only the name, so its label "Edit <role>" contains its visible text. */}
            <Text size="sm" c="dimmed">
              {index + 1}.
            </Text>
            <UnstyledButton onClick={onSelect} aria-label={`Edit ${name}`} aria-pressed={selected} style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>
                {name}
              </Text>
            </UnstyledButton>
            {selected && (
              <Text size="xs" c="dimmed" data-editing>
                Editing
              </Text>
            )}
          </Group>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {`${firstSentence(role.instructions)} · ticket shows ${phaseLabel(role.activePhase)}`}
          </Text>
        </Stack>
        <ActionIcon variant="subtle" color="gray" aria-label={`Move ${name} up`} data-move="up" disabled={index === 0} onClick={() => onMove(index - 1)}>
          <span aria-hidden>↑</span>
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Move ${name} down`}
          data-move="down"
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          <span aria-hidden>↓</span>
        </ActionIcon>
        <ActionIcon variant="subtle" color="gray" aria-label={`Remove ${name}`} disabled={count === 1} onClick={onRemove}>
          <span aria-hidden>×</span>
        </ActionIcon>
      </Group>
    </Paper>
  )
}

interface FormProps {
  role: DraftRole
  index: number
  /** The roles before this one: the ones it can hand back to. */
  earlier: DraftRole[]
  canRemove: boolean
  onRemove: () => void
  onChange: (patch: Partial<DraftRole>) => void
}

/** "If it finds problems": Ask me, the previous role (the default), or any earlier role. */
const ASK_ME = 'ask_me'
const PREVIOUS = 'previous'

function RoleForm({ role, index, earlier, canRemove, onRemove, onChange }: FormProps): ReactElement {
  const [modelsOpen, setModelsOpen] = useState(false)
  const offered = useModelOptions()
  const models = [{ value: DEFAULT, label: 'Orchestrator decides' }, ...offered]
  const model = role.model ?? DEFAULT
  const effort = role.effort ?? DEFAULT
  const previous = earlier.at(-1)
  const problem =
    role.onProblem === 'ask_me' ? ASK_ME : role.handBackTo === null || role.handBackTo === previous?.id ? PREVIOUS : role.handBackTo
  const problemOptions = [
    {
      value: PREVIOUS,
      label: previous ? `Hand back to ${displayName(previous, earlier.length - 1)} (previous role)` : 'Hand back to the previous role'
    },
    ...earlier.slice(0, -1).map((r, i) => ({ value: r.id, label: `Hand back to ${displayName(r, i)}` })),
    { value: ASK_ME, label: 'Ask me' }
  ]
  return (
    <Paper withBorder p="md" radius="md" component="section" aria-label={`${displayName(role, index)} settings`}>
      <Stack gap="sm" h="100%">
        <Title order={4}>{displayName(role, index)}</Title>
        <TextInput label="Role name" value={role.name} onChange={(e) => onChange({ name: e.currentTarget.value })} />
        <Textarea
          label="Instructions"
          autosize
          minRows={5}
          maxRows={14}
          value={role.instructions}
          onChange={(e) => onChange({ instructions: e.currentTarget.value })}
        />
        <NativeSelect
          label="Ticket phase while this role works"
          data={PHASES}
          value={role.activePhase}
          onChange={(e) => onChange({ activePhase: e.currentTarget.value as RolePhase })}
        />
        <NativeSelect
          label="Tool profile"
          data={TOOL_PROFILES}
          value={role.toolProfile}
          onChange={(e) => onChange({ toolProfile: e.currentTarget.value as ToolProfile })}
        />
        <NativeSelect
          label="If it finds problems"
          data={problemOptions}
          value={problem}
          onChange={(e) => {
            const value = e.currentTarget.value
            onChange(
              value === ASK_ME
                ? { onProblem: 'ask_me', handBackTo: null }
                : { onProblem: 'hand_back', handBackTo: value === PREVIOUS ? null : value }
            )
          }}
        />
        <Stack gap={6}>
          <UnstyledButton
            aria-expanded={modelsOpen}
            onClick={() => setModelsOpen((o) => !o)}
            style={{ fontSize: 'var(--mantine-font-size-sm)', fontWeight: 500 }}
          >
            <span aria-hidden>{modelsOpen ? '▼' : '▶'}</span> Model and effort (default: orchestrator decides)
          </UnstyledButton>
          <Collapse expanded={modelsOpen}>
            <Stack gap="sm">
              <NativeSelect
                label="Model"
                data={withCurrent(models, model, modelLabel)}
                value={model}
                onChange={(e) => onChange({ model: e.currentTarget.value === DEFAULT ? null : e.currentTarget.value })}
              />
              <NativeSelect
                label="Effort"
                data={withCurrent(EFFORTS, effort)}
                value={effort}
                onChange={(e) =>
                  onChange({ effort: e.currentTarget.value === DEFAULT ? null : (e.currentTarget.value as Effort) })
                }
              />
              <Text size="sm" c="dimmed">
                "Orchestrator decides" lets the orchestrator choose when it proposes a start. Otherwise Mainbus's
                defaults apply: {defaultsText()}.
              </Text>
            </Stack>
          </Collapse>
        </Stack>
        <Group mt="auto" pt="sm">
          <Button variant="default" disabled={!canRemove} onClick={onRemove}>
            Remove role
          </Button>
        </Group>
      </Stack>
    </Paper>
  )
}

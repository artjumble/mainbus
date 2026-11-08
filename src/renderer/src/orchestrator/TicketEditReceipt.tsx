import { Anchor, Button, Collapse, Group, Paper, Stack, Text } from '@mantine/core'
import { useState, type ReactElement, type ReactNode } from 'react'
import type { Criterion, EditedField, TicketEdit } from '../../../shared/domain'
import type { ThreadEvent } from '../../../shared/events'
import { describeEdit } from '../../../shared/ticketEdit'
import { invoke } from '../api'
import { navigateTo } from '../navigation'
import { errorMessage, showError } from '../notify'
import { lineDiff } from './lineDiff'

type Edited = Extract<ThreadEvent, { kind: 'ticket_edited' }>

const FIELD_LABEL: Record<EditedField, string> = { title: 'Title', spec: 'Spec', criteria: 'Criteria', labels: 'Labels', blockedBy: 'Blocked by', runSettings: 'Run settings' }

const criteriaText = (list: Criterion[]): string => (list.length === 0 ? '(none)' : list.map((c) => `${c.checked ? '[x]' : '[ ]'} ${c.text}`).join('\n'))
const blockersText = (list: number[]): string => (list.length === 0 ? '(none)' : list.map((n) => `#${n}`).join(', '))
const labelsText = (list: string[]): string => (list.length === 0 ? '(none)' : list.join(', '))

function Block({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <Stack gap={2}>
      <Text size="xs" fw={600}>
        {label}
      </Text>
      {children}
    </Stack>
  )
}

function Mono({ text, c, prefix }: { text: string; c?: string; prefix?: string }): ReactElement {
  return (
    <Text size="xs" ff="monospace" c={c} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {prefix}
      {text}
    </Text>
  )
}

function Before({ old, next }: { old: string; next: string }): ReactElement {
  return (
    <>
      <Mono text={old} c="red" prefix="Before: " />
      <Mono text={next} c="green" prefix="After: " />
    </>
  )
}

function Changes({ edit }: { edit: TicketEdit }): ReactElement {
  return (
    <Stack gap="xs" pt={6} data-testid="edit-changes">
      {edit.fields.map((field) => {
        const { before, after } = edit
        switch (field) {
          case 'title':
            return (
              <Block key={field} label={FIELD_LABEL.title}>
                <Before old={before.title ?? ''} next={after.title ?? ''} />
              </Block>
            )
          case 'spec':
            return (
              <Block key={field} label={FIELD_LABEL.spec}>
                {lineDiff(before.spec ?? '', after.spec ?? '').map((line, i) => (
                  <Mono
                    key={i}
                    text={line.text}
                    c={line.kind === 'added' ? 'green' : line.kind === 'removed' ? 'red' : 'dimmed'}
                    prefix={line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                  />
                ))}
              </Block>
            )
          case 'criteria':
            return (
              <Block key={field} label={FIELD_LABEL.criteria}>
                <Before old={criteriaText(before.criteria ?? [])} next={criteriaText(after.criteria ?? [])} />
              </Block>
            )
          case 'labels':
            return (
              <Block key={field} label={FIELD_LABEL.labels}>
                <Before old={labelsText(before.labels ?? [])} next={labelsText(after.labels ?? [])} />
              </Block>
            )
          case 'blockedBy':
            return (
              <Block key={field} label={FIELD_LABEL.blockedBy}>
                <Before old={blockersText(before.blockedBy ?? [])} next={blockersText(after.blockedBy ?? [])} />
              </Block>
            )
          case 'runSettings':
            return (
              <Block key={field} label={FIELD_LABEL.runSettings}>
                <Before old={before.runSettings ? 'Custom run settings' : 'Lineup defaults'} next={after.preset ? `${after.preset} preset` : 'Lineup defaults'} />
              </Block>
            )
        }
      })}
      {edit.intentAdded.length > 0 && (
        <Block label="Your words (added)">
          {edit.intentAdded.map((entry, i) => (
            <Mono key={i} text={entry.text} c="green" prefix="+ " />
          ))}
        </Block>
      )}
    </Stack>
  )
}

/**
 * The receipt of an edit the orchestrator made to a ticket that hadn't started: what it changed, a link to the ticket,
 * the changes (before and after) on demand, and Undo, which the engine refuses with its reason once the ticket changed.
 */
export function TicketEditReceipt({ event, edit }: { event: Edited; edit: TicketEdit }): ReactElement {
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const open = (): void => {
    navigateTo({ to: 'ticket', workspaceId: event.workspaceId, ticketId: event.ticket.id }).catch((err: unknown) => showError(err, 'Could not open that ticket'))
  }
  const undo = (): void => {
    setBusy(true)
    setRefusal(null)
    invoke('ticket.undoEdit', edit.id)
      .catch((err: unknown) => setRefusal(errorMessage(err)))
      .finally(() => setBusy(false))
  }
  const undone = edit.undoneAt !== null
  const what = describeEdit(edit.fields, edit.intentAdded.length, 'your words')
  return (
    <Paper withBorder px="sm" py={6} radius="md" data-event="ticket_edited">
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <Text size="sm" c="dimmed">
          {undone ? 'Undone: ' : 'Updated '}
          <Anchor component="button" type="button" size="sm" title={event.ticket.title} onClick={open}>
            #{event.ticket.number}
          </Anchor>
          {undone ? ` (was ${what})` : `: ${what}`}
        </Text>
        <Group gap={4} wrap="nowrap">
          <Button variant="subtle" size="compact-xs" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
            Show changes
          </Button>
          {!undone && (
            <Button variant="light" size="compact-xs" loading={busy} onClick={undo}>
              Undo
            </Button>
          )}
        </Group>
      </Group>
      {refusal !== null && (
        <Text size="xs" c="red" role="alert" pt={4}>
          {refusal}
        </Text>
      )}
      <Collapse expanded={shown} keepMounted={false}>
        <Changes edit={edit} />
      </Collapse>
    </Paper>
  )
}

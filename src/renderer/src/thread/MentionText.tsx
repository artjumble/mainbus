import { Badge, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import { findMentions, type MentionRef } from '../../../shared/mentions'

/** A sent message's words, with each mention the engine resolved shown as a chip with the workspace's name. */
export function MentionText({ text, mentions }: { text: string; mentions?: MentionRef[] }): ReactElement {
  const parts: (string | ReactElement)[] = []
  let at = 0
  for (const m of mentions?.length ? findMentions(text) : []) {
    const ref = mentions!.find((r) => r.token === m.raw)
    if (!ref) continue
    if (m.start > at) parts.push(text.slice(at, m.start))
    parts.push(
      <Badge key={m.start} size="sm" variant="light" radius="sm" tt="none" data-mention={ref.workspaceId}>
        {ref.name}
      </Badge>
    )
    at = m.end
  }
  parts.push(text.slice(at))
  return <Text size="sm">{parts}</Text>
}

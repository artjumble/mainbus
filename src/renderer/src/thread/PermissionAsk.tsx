import { Code, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { permissionRequestOf } from '../../../shared/permissionRequest'
import { CodeBlock } from '../code/CodeBlock'

/** A permission command longer than this many lines is capped, with Show all. */
const MAX_LINES = 12

/**
 * What a decision asks, for the cards that show it. A permission request reads as a plain line ("Implementer wants
 * to run"), the command or input as a code block, and the reason below it. A question, or a permission whose request
 * can't be told apart, is its text.
 */
export function PermissionAsk({ decision }: { decision: Pick<Decision, 'kind' | 'question' | 'request'> }): ReactElement {
  const request = decision.kind === 'permission' ? permissionRequestOf(decision) : null
  if (!request) {
    return (
      <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
        {decision.question}
      </Text>
    )
  }
  const input = request.input && Object.keys(request.input).length > 0 ? JSON.stringify(request.input, null, 2) : null
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>
        {request.command !== null ? (
          `${request.role} wants to run`
        ) : request.path !== null ? (
          <>
            {`${request.role} wants to edit `}
            <Code>{request.path}</Code>
          </>
        ) : (
          `${request.role} wants to use ${request.tool}`
        )}
      </Text>
      {request.command !== null && (
        <CodeBlock
          code={request.command}
          language={request.tool === 'PowerShell' ? 'powershell' : 'bash'}
          copyLabel="Copy command"
          maxLines={MAX_LINES}
        />
      )}
      {request.command === null && request.path === null && input !== null && (
        <CodeBlock code={input} language="json" copyLabel="Copy input" maxLines={MAX_LINES} />
      )}
      {request.reason && (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {request.reason}
        </Text>
      )}
    </Stack>
  )
}

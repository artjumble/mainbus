import { Drawer, Stack, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { UsageTotals } from '../../../shared/usageTotals'
import { invoke } from '../api'
import { UsageTotalsView } from '../ticket/UsageSection'
import { OrchestratorSettings } from './OrchestratorSettings'
import { ThemeSettings } from './ThemeSettings'

interface Props {
  opened: boolean
  onClose: () => void
}

/** One part of the Mainbus settings, under its own heading. */
function Section({ title, label = title, children }: { title: string; label?: string; children: ReactNode }): ReactElement {
  return (
    <Stack gap="sm" component="section" aria-label={label}>
      <Title order={3} size="h4">
        {title}
      </Title>
      {children}
    </Stack>
  )
}

/** What the orchestrator panel's own turns used, read when the drawer opens. */
function OrchestratorUsage({ opened }: { opened: boolean }): ReactElement {
  const [usage, setUsage] = useState<UsageTotals | null>(null)
  useEffect(() => {
    if (!opened) return
    let current = true
    void invoke('orchestrator.usage')
      .then((u) => current && setUsage(u))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [opened])
  return <UsageTotalsView usage={usage} />
}

/** The Mainbus settings drawer: what applies to the whole app, whichever workspace is focused. One section per area. */
export function AppSettings({ opened, onClose }: Props): ReactElement {
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title="Mainbus settings">
      <Stack gap="xl">
        <Section title="Appearance">
          <ThemeSettings opened={opened} />
        </Section>
        <Section title="Orchestrator">
          <OrchestratorSettings opened={opened} />
        </Section>
        <Section title="Usage" label="Orchestrator usage">
          <OrchestratorUsage opened={opened} />
        </Section>
      </Stack>
    </Drawer>
  )
}

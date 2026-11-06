import { Drawer, Stack, Title } from '@mantine/core'
import type { ReactElement, ReactNode } from 'react'
import { ThemeSettings } from './ThemeSettings'

interface Props {
  opened: boolean
  onClose: () => void
}

/** One part of the Mainbus settings, under its own heading. */
function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Stack gap="sm" component="section" aria-label={title}>
      <Title order={3} size="h4">
        {title}
      </Title>
      {children}
    </Stack>
  )
}

/** The Mainbus settings drawer: what applies to the whole app, whichever workspace is focused. One section per area. */
export function AppSettings({ opened, onClose }: Props): ReactElement {
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title="Mainbus settings">
      <Stack gap="xl">
        <Section title="Appearance">
          <ThemeSettings opened={opened} />
        </Section>
      </Stack>
    </Drawer>
  )
}

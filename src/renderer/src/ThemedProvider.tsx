import { MantineProvider, type MantineProviderProps } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { ThemeChoice } from '../../shared/domain'
import { onEngineEvent } from './api'
import { cssVariablesResolver, theme } from './theme'

/** The scheme a Theme choice draws the app in: Match Windows ('system') takes Windows' own. */
export function colorSchemeOf(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' {
  return choice === 'dark' || (choice === 'system' && systemDark) ? 'dark' : 'light'
}

/**
 * The app's MantineProvider, in the scheme of the Theme setting. A change to the setting applies at once, and with Match
 * Windows a change to the Windows setting does too (the main process keeps prefers-color-scheme in line with the choice).
 * `initial` is the setting as read before the first paint, so the page starts in the right scheme.
 */
export function ThemedProvider({
  initial,
  env,
  children
}: {
  initial: ThemeChoice
  env?: MantineProviderProps['env']
  children: ReactNode
}): ReactElement {
  const [choice, setChoice] = useState(initial)
  useEffect(
    () =>
      onEngineEvent((e) => {
        if (e.type === 'theme.changed') setChoice(e.theme)
      }),
    []
  )
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)', undefined, { getInitialValueInEffect: false })
  const scheme = colorSchemeOf(choice, systemDark)
  return (
    // The default too, so Mantine's first, pre-paint pass already sets this scheme rather than light.
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme={scheme} forceColorScheme={scheme} env={env}>
      {children}
    </MantineProvider>
  )
}

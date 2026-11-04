import { MantineProvider, type MantineProviderProps } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { resolveTheme, type ThemeSetting } from '../../shared/domain'
import { onEngineEvent } from './api'
import { mantineThemes } from './theme'

/**
 * The app's MantineProvider, in the theme of the Theme setting. A change to the setting applies at once, and with Match
 * Windows a change to the Windows setting does too (the main process keeps prefers-color-scheme in line with the choice).
 * `initial` is the setting as read before the first paint, so the page starts in the right theme. The theme in use is
 * on the root element as `data-mainbus-theme`.
 */
export function ThemedProvider({
  initial,
  env,
  children
}: {
  initial: ThemeSetting
  env?: MantineProviderProps['env']
  children: ReactNode
}): ReactElement {
  const [setting, setSetting] = useState(initial)
  useEffect(
    () =>
      onEngineEvent((e) => {
        if (e.type === 'theme.changed') setSetting(e.theme)
      }),
    []
  )
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)', undefined, { getInitialValueInEffect: false })
  const id = resolveTheme(setting, systemDark)
  const { scheme, theme, cssVariablesResolver } = mantineThemes[id]
  useEffect(() => {
    document.documentElement.dataset['mainbusTheme'] = id
  }, [id])
  return (
    // The default too, so Mantine's first, pre-paint pass already sets this scheme rather than light.
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme={scheme} forceColorScheme={scheme} env={env}>
      {children}
    </MantineProvider>
  )
}

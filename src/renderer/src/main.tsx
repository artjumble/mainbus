import '@mantine/core/styles.css'
import '@mantine/code-highlight/styles.css'
import '@mantine/notifications/styles.css'

import { Notifications } from '@mantine/notifications'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { THEME_SETTING_DEFAULT, type ThemeSetting } from '../../shared/domain'
import { invoke } from './api'
import { App } from './App'
import { ThemedProvider } from './ThemedProvider'
import { VoiceProvider } from './voice/VoiceProvider'

// The Theme setting is read before the first render, so a dark app never paints light first. The window is already
// painted in its ground meanwhile; if the setting can't be read, the app opens in Light.
void invoke('settings.get')
  .then((s): ThemeSetting => s.theme, (): ThemeSetting => THEME_SETTING_DEFAULT)
  .then((initial) => {
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <ThemedProvider initial={initial}>
          <Notifications />
          <VoiceProvider>
            <App />
          </VoiceProvider>
        </ThemedProvider>
      </StrictMode>
    )
  })

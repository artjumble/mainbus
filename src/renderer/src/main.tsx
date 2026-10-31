import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { cssVariablesResolver, theme } from './theme'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme="light"
    >
      <Notifications />
      <App />
    </MantineProvider>
  </StrictMode>
)

import { notifications } from '@mantine/notifications'
import { isSetupRequired } from '../api'
import { showError } from '../notify'

/** Shows a failed agent or decision command. A "Claude Code is not set up" failure gets a message that says what to do. */
export function showAgentError(err: unknown, title: string): void {
  if (isSetupRequired(err)) {
    notifications.show({
      color: 'needs',
      title,
      message: 'Claude Code is not ready. Restart Mainbus after logging in to Claude Code.'
    })
    return
  }
  showError(err, title)
}

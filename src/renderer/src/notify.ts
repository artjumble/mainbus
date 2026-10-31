import { notifications } from '@mantine/notifications'

// Electron wraps a rejected command's message: "Error invoking remote method 'engine:invoke': Error: <message>".
const ELECTRON_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

/** The message of a failed command, without Electron's wrapper. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(ELECTRON_PREFIX, '')
}

/** Shows a failed command as a notification; never throws. */
export function showError(err: unknown, title = 'Something went wrong'): void {
  notifications.show({ color: 'needs', title, message: errorMessage(err) })
}

/** The OS the app runs on. Falls back to Windows when the bridge isn't there (tests, a plain browser). */
export function platform(): string {
  return window.mainbus?.platform ?? 'win32'
}

/** A path in a temp folder, or a reference to one: those differ run to run without the command being a different one. */
const TEMP_PATH = /(?:^|[\\/="'(])(?:tmp|temp)(?:[\\/]|$)|\/var\/folders\/|\$\{?(?:TEMP|TMP|TMPDIR)\b|%(?:TEMP|TMP)%/i

/**
 * A command with what changes between identical attempts masked: whitespace collapsed, temp paths replaced by
 * `<tmp>` and digits by `N`. Two attempts at the same failing command then compare equal.
 */
export function normalizeCommand(command: string): string {
  return command
    .trim()
    .split(/\s+/)
    .map((token) => (TEMP_PATH.test(token) ? '<tmp>' : token))
    .join(' ')
    .replace(/\d+/g, 'N')
}

/** The text a tool call's input is about: its command, path or pattern when it has one, else the input as JSON. */
export function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (typeof input === 'object' && input !== null) {
    const i = input as Record<string, unknown>
    const key = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description'].find(
      (k) => typeof i[k] === 'string' && i[k] !== ''
    )
    if (key !== undefined) return i[key] as string
  }
  return JSON.stringify(input) ?? ''
}

import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * Where the running app listens for intake requests from this data home.
 * On Windows a named pipe whose name hashes the home root, so stable, dev and test homes each get their
 * own pipe and a client can only reach the board of the home it resolved. Elsewhere a unix socket in the
 * home itself.
 */
export function intakeEndpoint(homeRoot: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.join(homeRoot, 'intake.sock')
  const key = path.win32.resolve(homeRoot).toLowerCase()
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\mainbus-${hash}`
}

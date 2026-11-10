import path from 'node:path'

/** The scheme the renderer's speech worker loads the downloaded models through: `mainbus-model://models/<model>/<file>`. */
export const MODEL_SCHEME = 'mainbus-model'

/**
 * The file a `mainbus-model://models/...` address names inside `modelsDir`, or null when it names anything else:
 * another host, a `..` step (also percent-encoded), a backslash or drive, or a model still being downloaded (`.partial-*`).
 */
export function modelFilePath(url: string, modelsDir: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MODEL_SCHEME}:` || parsed.hostname !== 'models') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (/[\\:\0]/.test(decoded)) return null
  const parts = decoded.split('/').slice(1)
  if (parts.length < 2 || parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.partial'))) return null
  const root = path.resolve(modelsDir)
  const file = path.resolve(root, ...parts)
  return file.startsWith(root + path.sep) ? file : null
}

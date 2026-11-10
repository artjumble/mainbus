import { isAppUrl } from './appUrl'

/** The parts of Electron's permission details that decide the answer. */
export interface PermissionDetails {
  requestingUrl?: string
  /** For a 'media' request: what the page asks for ('audio', 'video'). */
  mediaTypes?: string[]
  /** For a 'media' check: 'audio', 'video' or 'unknown' (listing devices). */
  mediaType?: string
}

/**
 * Whether the page may have the permission. Only the app's own page ever gets one, and of the camera and microphone only
 * the microphone (voice dictation): a request that includes video is refused. Anything that doesn't parse is refused.
 */
export function allowPermission(permission: string, details: PermissionDetails, appUrl: string): boolean {
  const url = details.requestingUrl
  if (typeof url !== 'string' || !isAppUrl(url, appUrl)) return false
  if (permission !== 'media') return true
  if (details.mediaTypes !== undefined) return details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio')
  // A check, not a request: 'unknown' is the page listing its devices.
  return details.mediaType === 'audio' || details.mediaType === 'unknown'
}

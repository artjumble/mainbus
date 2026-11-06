// Shared by the engine and the renderer: no Node imports (the renderer typechecks this file).
// The engine checks every attachment itself; the renderer checks first only to refuse early.

/** An image the user attached to a ticket. Its file lives in Mainbus's data folder, never in the repo. */
export interface Attachment {
  id: string
  ticketId: string
  /** The name as given, sanitised: unique (ignoring case) among the ticket's attachments. */
  filename: string
  mime: ImageMime
  /** In bytes. */
  size: number
  sha256: string
  createdAt: string
}

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const ATTACHMENTS_PER_TICKET = 20
export const IMAGES_PER_MESSAGE = 5

/**
 * An image the user sent the orchestrator with a message. Its file lives in Mainbus's data folder, kept as long as
 * the orchestrator's thread.
 */
export interface OrchestratorImage {
  id: string
  /** The name as given, sanitised: unique (ignoring case) among every image sent to the orchestrator. */
  filename: string
  mime: ImageMime
  size: number
  sha256: string
  createdAt: string
}

/** How a message or a draft names one of those images. */
export interface ImageRef {
  id: string
  filename: string
}

const EXTENSIONS: Record<ImageMime, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp']
}

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b)
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** The image type the leading bytes say, or null: the extension is never trusted. */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

/** True when the bytes look like markup (SVG, XML or HTML) rather than an image. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++
  return bytes[i] === 0x3c // '<'
}

function megabytes(n: number): string {
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
}

/**
 * Why the file can't be attached, in plain words, or null when it can: a PNG, JPEG, GIF or WebP image (by its
 * leading bytes) of at most 10 MB. `count` is how many the ticket has already.
 */
export function whyNotAttachable(name: string, bytes: Uint8Array, count: number): string | null {
  if (count >= ATTACHMENTS_PER_TICKET) return `A ticket can have at most ${ATTACHMENTS_PER_TICKET} attachments; remove one first.`
  return whyNotImage(name, bytes)
}

/**
 * Why the file can't go with a message to the orchestrator, or null when it can: the same rules as an attachment,
 * and at most 5 per message. `count` is how many the message has already.
 */
export function whyNotSendable(name: string, bytes: Uint8Array, count: number): string | null {
  if (count >= IMAGES_PER_MESSAGE) return `A message can have at most ${IMAGES_PER_MESSAGE} images; remove one first.`
  return whyNotImage(name, bytes)
}

function whyNotImage(name: string, bytes: Uint8Array): string | null {
  if (/\.svgz?$/i.test(name.trim()) || looksLikeMarkup(bytes)) return `${name} is an SVG or other markup file: it can carry script, so it can't be attached.`
  if (sniffImage(bytes) === null) return `${name} is not a PNG, JPEG, GIF or WebP image.`
  if (bytes.length > ATTACHMENT_MAX_BYTES) return `${name} is ${megabytes(bytes.length)}; an attachment can be at most ${megabytes(ATTACHMENT_MAX_BYTES)}.`
  return null
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const NAME_MAX = 100

/**
 * A safe file name for the image: the last part of the name given, without path separators, control characters
 * or characters Windows refuses, with the extension of its real type.
 */
export function sanitizeFilename(name: string, mime: ImageMime): string {
  const last = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  let base = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim()
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : ''
  if (dot > 0) base = base.slice(0, dot)
  base = base.replace(/[. ]+$/, '').replace(/^[. ]+/, '')
  if (base === '') base = 'image'
  if (RESERVED.test(base)) base = `_${base}`
  const extension = EXTENSIONS[mime].includes(ext) ? ext : EXTENSIONS[mime][0]!
  return `${base.slice(0, NAME_MAX)}${extension}`
}

/** `filename`, or `name-2.png`, `name-3.png`… when the ticket already has one by that name (ignoring case). */
export function uniqueFilename(filename: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  if (!used.has(filename.toLowerCase())) return filename
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

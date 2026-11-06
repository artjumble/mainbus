import { useEffect, useState } from 'react'
import type { NewAttachment } from '../../../shared/api'
import { whyNotAttachable } from '../../../shared/attachments'
import { invoke } from '../api'
import { showError } from '../notify'

/** The files in a paste or a drop; none when it carries only text. */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = [...(data.files ?? [])]
  if (files.length > 0) return files
  return [...(data.items ?? [])].filter((i) => i.kind === 'file').flatMap((i) => i.getAsFile() ?? [])
}

/** True for a text field that takes pasted text itself: an editable input, textarea or contenteditable element. */
export function takesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'file', 'submit', 'reset', 'range', 'color', 'image'].includes(target.type)
}

/**
 * Ctrl+V with an image on the clipboard calls `onFiles`, while the component is mounted, wherever the focus is but in a
 * text field that takes the paste (the thread input handles its own).
 */
export function useImagePaste(onFiles: (files: File[]) => void): void {
  useEffect(() => {
    function onPaste(e: ClipboardEvent): void {
      if (e.defaultPrevented || takesText(e.target)) return
      const files = filesOf(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      onFiles(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [onFiles])
}

/** True when a drag carries files, so a drop zone can accept it. */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return data !== null && [...(data.types ?? [])].includes('Files')
}

/** A pasted screenshot comes without a name: it gets one. */
function nameOf(file: File): string {
  return file.name.trim() === '' ? 'pasted-image.png' : file.name
}

/**
 * Reads the files and checks them as the engine will: a PNG, JPEG, GIF or WebP of at most 10 MB, at most 20 per
 * ticket counting the `count` it has (or, with `whyNotSendable`, 5 per message). Each refused one is shown with its
 * reason; the rest are returned.
 */
export async function readImages(
  files: File[],
  count: number,
  whyNot: (name: string, bytes: Uint8Array, count: number) => string | null = whyNotAttachable
): Promise<NewAttachment[]> {
  const read: NewAttachment[] = []
  for (const file of files) {
    const image = { name: nameOf(file), bytes: new Uint8Array(await file.arrayBuffer()) }
    const why = whyNot(image.name, image.bytes, count + read.length)
    if (why !== null) showError(new Error(why), "Couldn't attach the image")
    else read.push(image)
  }
  return read
}

/** Attaches the files to the ticket, one at a time; each refusal is shown. */
export async function attachToTicket(ticketId: string, files: File[], count: number): Promise<void> {
  for (const image of await readImages(files, count)) {
    try {
      await invoke('attachment.add', ticketId, image.name, image.bytes)
    } catch (err) {
      showError(err, "Couldn't attach the image")
    }
  }
}

// An attachment or a sent image never changes, so its image is fetched once per id.
const images = new Map<string, Promise<string>>()

/**
 * The image as a data URL, from the engine by id: a ticket's attachment, or (`orchestrator.image`) one the user sent
 * the orchestrator. Null while it loads or when it couldn't be read.
 */
export function useAttachmentImage(id: string, from: 'attachment.data' | 'orchestrator.image' = 'attachment.data'): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const key = `${from}:${id}`
    let image = images.get(key)
    if (!image) {
      image = invoke(from, id)
      images.set(key, image)
      // A failure is not cached: the next look tries again.
      image.catch(() => images.delete(key))
    }
    image.then(
      (url) => live && setSrc(url),
      () => live && setSrc(null)
    )
    return () => {
      live = false
    }
  }, [id, from])
  return src
}

/** A local file's preview, before it is attached: read in the page, never through a URL to the file. */
export function useLocalPreview(bytes: Uint8Array, mime: string): string {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    setSrc(`data:${mime};base64,${btoa(binary)}`)
  }, [bytes, mime])
  return src
}

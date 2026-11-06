import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  IMAGES_PER_MESSAGE,
  sanitizeFilename,
  sniffImage,
  uniqueFilename,
  whyNotSendable,
  type ImageRef,
  type OrchestratorImage
} from '../../shared/attachments'
import { orchestratorFolder } from '../home'
import { oneLine } from '../roles/prompt'
import type { PromptImage } from '../runtime/types'
import type { OrchestratorImageRepo } from '../store/orchestratorImages'

/** An image the user sent, with where its file is. */
export type StoredImage = OrchestratorImage & { path: string }

/** `<MAINBUS_HOME>\orchestrator\images`: inside the orchestrator's own folder, so it can open them with Read. */
export function orchestratorImagesFolder(homeRoot: string): string {
  return path.join(orchestratorFolder(homeRoot), 'images')
}

/** Where an image's file is: `<id>-<filename>` in the images folder. */
export function orchestratorImagePath(homeRoot: string, image: ImageRef): string {
  return path.join(orchestratorImagesFolder(homeRoot), `${image.id}-${image.filename}`)
}

/** What a message's images are, as the orchestrator is told after the user's words: each name and full path. */
export function imageListText(images: { filename: string; path: string }[]): string {
  const lines = images.map((i) => `- ${oneLine(i.filename)}: ${oneLine(i.path)}`).join('\n')
  return `[Mainbus] The user sent ${images.length === 1 ? 'this image' : `these ${images.length} images`} with the message, shown to you above. Refer to one by its name; to look at it again later, open it with Read:\n${lines}`
}

/** The renderer's or IPC's file: bytes as a Uint8Array (a Buffer is one) or an ArrayBuffer. */
function asBytes(bytes: unknown): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  throw new Error('An image must be the bytes of an image file')
}

/**
 * The images the user sends the orchestrator. They are checked like ticket attachments (PNG, JPEG, GIF or WebP by
 * their leading bytes, at most 10 MB) and at most 5 go with one message. They are kept as long as the thread is.
 */
export class OrchestratorImages {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: { repo: OrchestratorImageRepo; homeRoot: string }) {}

  /** The images, checked, or a plain reason why they can't all go with a message. */
  check(files: unknown): { ok: true; files: { name: string; bytes: Uint8Array }[] } | { ok: false; error: string } {
    if (files === undefined || files === null) return { ok: true, files: [] }
    if (!Array.isArray(files)) return { ok: false, error: 'Images must be a list' }
    if (files.length > IMAGES_PER_MESSAGE) return { ok: false, error: `A message can have at most ${IMAGES_PER_MESSAGE} images; remove one first.` }
    const checked: { name: string; bytes: Uint8Array }[] = []
    for (const [i, f] of (files as unknown[]).entries()) {
      const name = (f as { name?: unknown } | null)?.name
      if (typeof name !== 'string') return { ok: false, error: 'An image must have a name' }
      let bytes: Uint8Array
      try {
        bytes = asBytes((f as { bytes?: unknown }).bytes)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      const why = whyNotSendable(name, bytes, i)
      if (why !== null) return { ok: false, error: why }
      checked.push({ name, bytes })
    }
    return { ok: true, files: checked }
  }

  /**
   * Stores checked images, all of them or none, each under a name no earlier image has (ignoring case). One store at a
   * time, so two never take the same name.
   */
  store(files: { name: string; bytes: Uint8Array }[]): Promise<StoredImage[]> {
    if (files.length === 0) return Promise.resolve([])
    const result = this.chain.then(() => this.storeNow(files))
    this.chain = result.catch(() => {})
    return result
  }

  private async storeNow(files: { name: string; bytes: Uint8Array }[]): Promise<StoredImage[]> {
    const taken = await this.deps.repo.filenames()
    const drafts = files.map((f) => {
      const mime = sniffImage(f.bytes)!
      const filename = uniqueFilename(sanitizeFilename(f.name, mime), taken)
      taken.push(filename)
      return { id: randomUUID(), filename, mime, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') }
    })
    const written: string[] = []
    try {
      await fs.mkdir(orchestratorImagesFolder(this.deps.homeRoot), { recursive: true })
      for (const [i, d] of drafts.entries()) {
        const file = this.pathOf(d)
        await fs.writeFile(file, files[i]!.bytes, { flag: 'wx' })
        written.push(file)
      }
      const rows = await this.deps.repo.addMany(drafts)
      return rows.map((r) => ({ ...r, path: this.pathOf(r) }))
    } catch (err) {
      await Promise.all(written.map((f) => fs.rm(f, { force: true }).catch(() => {})))
      throw err
    }
  }

  pathOf(image: ImageRef): string {
    return orchestratorImagePath(this.deps.homeRoot, image)
  }

  /** The image's bytes, checked again: still the image of the type recorded. */
  async read(id: string): Promise<{ image: StoredImage; bytes: Buffer }> {
    const found = typeof id === 'string' ? await this.deps.repo.get(id) : null
    if (!found) throw new Error('Unknown image')
    const file = this.pathOf(found)
    const bytes = await fs.readFile(file)
    if (sniffImage(bytes) !== found.mime) throw new Error(`${found.filename} is no longer the image that was sent`)
    return { image: { ...found, path: file }, bytes }
  }

  /** The image as its session is given it. */
  async forPrompt(id: string): Promise<PromptImage> {
    const { image, bytes } = await this.read(id)
    return { mime: image.mime, base64: bytes.toString('base64') }
  }

  /** The image as a data URL: the one way the renderer sees it. Only by id, so it never names a file itself. */
  async dataUrl(id: string): Promise<string> {
    const { image, bytes } = await this.read(id)
    return `data:${image.mime};base64,${bytes.toString('base64')}`
  }

  /** The images with these ids that still exist, in the order given. */
  async byIds(ids: string[]): Promise<StoredImage[]> {
    const found = new Map((await this.deps.repo.byIds(ids)).map((i) => [i.id, i]))
    return ids.flatMap((id) => {
      const image = found.get(id)
      return image ? [{ ...image, path: this.pathOf(image) }] : []
    })
  }
}

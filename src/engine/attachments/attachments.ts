import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sanitizeFilename, sniffImage, uniqueFilename, whyNotAttachable, type Attachment } from '../../shared/attachments'
import type { Ticket, Workspace } from '../../shared/domain'
import { attachmentFoldersFor, type HomePaths } from '../home'
import type { AttachmentRepo } from '../store/attachments'

/** An attachment with where its file is. */
export type AttachmentWithPath = Attachment & { path: string }

/** One attachment as a role finds it: its copy in the ticket's scratch folder. */
export interface ScratchAttachment {
  filename: string
  path: string
}

export interface AttachmentDeps {
  repo: AttachmentRepo
  paths: HomePaths
  ticket(id: string): Promise<Ticket>
  /** The open workspace; null when it is unknown or was removed. */
  workspace(id: string): Promise<Workspace | null>
}

/** The folder in a ticket's scratch folder that holds the copies of its attachments. */
export const SCRATCH_SUBFOLDER = 'attachments'

/** The file the renderer or IPC sent: bytes, as a Uint8Array (a Buffer is one) or an ArrayBuffer. */
function asBytes(bytes: unknown): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  throw new Error('An attachment must be the bytes of an image file')
}

/** True when the file at `file` is the attachment's image already. */
async function sameContent(file: string, a: Attachment): Promise<boolean> {
  const size = await fs.stat(file).then((s) => s.size, () => null)
  if (size !== a.size) return false
  const data = await fs.readFile(file).catch(() => null)
  return data !== null && createHash('sha256').update(data).digest('hex') === a.sha256
}

/**
 * Images the user attached to tickets. Each file lives in `<MAINBUS_HOME>\attachments\<workspace slug>\<ticket number>\<id>-<filename>`,
 * never in the repo; the database row says what it is. Changes to one ticket's attachments happen one at a time,
 * so the limit of 20 holds and two scratch copies never race.
 */
export class Attachments {
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: AttachmentDeps) {}

  /** Runs `step` after the ticket's earlier attachment changes. */
  private serial<T>(ticketId: string, step: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(ticketId) ?? Promise.resolve()).then(step)
    const tail = result.catch(() => {})
    this.chains.set(ticketId, tail)
    void tail.then(() => {
      if (this.chains.get(ticketId) === tail) this.chains.delete(ticketId)
    })
    return result
  }

  private async workspaceOf(ticket: Ticket): Promise<Workspace> {
    const ws = await this.deps.workspace(ticket.workspaceId)
    if (!ws) throw new Error("This ticket's workspace was removed")
    return ws
  }

  private folderOf(ws: Workspace, ticket: Ticket): string {
    return path.join(attachmentFoldersFor(this.deps.paths, ws.slug), String(ticket.number))
  }

  private fileOf(ws: Workspace, ticket: Ticket, a: Attachment): string {
    return path.join(this.folderOf(ws, ticket), `${a.id}-${a.filename}`)
  }

  /** Why these files can't all be added to a ticket that has `count` already, or null. Checks only, adds nothing. */
  check(files: { name: string; bytes: unknown }[], count: number): string | null {
    for (const [i, f] of files.entries()) {
      if (typeof f?.name !== 'string') return 'An attachment must have a name'
      const why = whyNotAttachable(f.name, asBytes(f.bytes), count + i)
      if (why !== null) return why
    }
    return null
  }

  /** Adds the image to the ticket, or refuses it with a plain reason: not a PNG, JPEG, GIF or WebP, over 10 MB, or the 21st. */
  add(ticketId: string, name: string, bytes: unknown): Promise<AttachmentWithPath> {
    return this.serial(ticketId, async () => {
      if (typeof name !== 'string') throw new Error('An attachment must have a name')
      const data = asBytes(bytes)
      const ticket = await this.deps.ticket(ticketId)
      const ws = await this.workspaceOf(ticket)
      const existing = await this.deps.repo.list(ticketId)
      const why = whyNotAttachable(name, data, existing.length)
      if (why !== null) throw new Error(why)
      return this.write(ws, ticket, name, data, existing)
    })
  }

  private async write(ws: Workspace, ticket: Ticket, name: string, data: Uint8Array, existing: Attachment[]): Promise<AttachmentWithPath> {
    const mime = sniffImage(data)!
    const filename = uniqueFilename(sanitizeFilename(name, mime), existing.map((a) => a.filename))
    const draft = { id: randomUUID(), ticketId: ticket.id, filename, mime, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    const file = path.join(this.folderOf(ws, ticket), `${draft.id}-${filename}`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, data, { flag: 'wx' })
    try {
      return { ...(await this.deps.repo.add(draft)), path: file }
    } catch (err) {
      await fs.rm(file, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Removes the attachment and its file. Returns it, or null when it was already gone. */
  async remove(id: string): Promise<AttachmentWithPath | null> {
    if (typeof id !== 'string') throw new Error('Unknown attachment')
    const found = await this.deps.repo.get(id)
    if (!found) return null
    return this.serial(found.ticketId, async () => {
      const ticket = await this.deps.ticket(found.ticketId)
      const ws = await this.workspaceOf(ticket)
      if (!(await this.deps.repo.remove(id))) return null
      const file = this.fileOf(ws, ticket, found)
      // The row is what counts: a file a program holds open is left behind, harmless.
      await fs.rm(file, { force: true }).catch(() => {})
      return { ...found, path: file }
    })
  }

  /** The ticket's attachments, oldest first, with where their files are. */
  async list(ticketId: string): Promise<AttachmentWithPath[]> {
    const ticket = await this.deps.ticket(ticketId)
    const ws = await this.deps.workspace(ticket.workspaceId)
    if (!ws) return []
    return (await this.deps.repo.list(ticketId)).map((a) => ({ ...a, path: this.fileOf(ws, ticket, a) }))
  }

  /** The image as a data URL: the one way the renderer sees it. Only by id, so it never names a file itself. */
  async dataUrl(id: string): Promise<string> {
    const found = typeof id === 'string' ? await this.deps.repo.get(id) : null
    if (!found) throw new Error('Unknown attachment: it may have been removed')
    const ticket = await this.deps.ticket(found.ticketId)
    const data = await fs.readFile(this.fileOf(await this.workspaceOf(ticket), ticket, found))
    // Checked again: what is shown is an image of the type recorded, whatever happened to the file.
    if (sniffImage(data) !== found.mime) throw new Error(`${found.filename} is no longer the image that was attached`)
    return `data:${found.mime};base64,${data.toString('base64')}`
  }

  /** Copies every attachment of `from` to `to` (a ticket promoted from it), with the same names. */
  async copyAll(from: Ticket, to: Ticket): Promise<void> {
    const source = await this.list(from.id)
    if (source.length === 0) return
    await this.serial(to.id, async () => {
      const ws = await this.workspaceOf(to)
      const existing = await this.deps.repo.list(to.id)
      for (const a of source) {
        const data = await fs.readFile(a.path)
        if (this.check([{ name: a.filename, bytes: data }], existing.length) !== null) continue
        existing.push(await this.write(ws, to, a.filename, data, existing))
      }
    })
  }

  /** Removes every attachment of the workspace's tickets, files and all. */
  async removeWorkspace(ws: Workspace): Promise<void> {
    await this.deps.repo.removeForWorkspace(ws.id)
    await fs.rm(attachmentFoldersFor(this.deps.paths, ws.slug), { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Makes `<scratch>\attachments` hold a copy of each of the ticket's attachments, by its name, and nothing else.
   * Returns the copies, oldest first. The scratch folder is outside the worktree, so a copy is never committed.
   * With `skipIfNone` (a role's launch), a ticket with no attachments touches no files: a removal cleans up when it happens.
   */
  sync(ticketId: string, scratch: string, opts: { skipIfNone?: boolean } = {}): Promise<ScratchAttachment[]> {
    return this.serial(ticketId, async () => {
      const all = await this.list(ticketId)
      if (all.length === 0 && opts.skipIfNone) return []
      const folder = path.join(scratch, SCRATCH_SUBFOLDER)
      const there = await fs.readdir(folder).catch(() => null)
      if (all.length === 0 && there === null) return []
      await fs.mkdir(folder, { recursive: true })
      const wanted = new Set(all.map((a) => a.filename.toLowerCase()))
      for (const name of there ?? []) {
        if (!wanted.has(name.toLowerCase())) await fs.rm(path.join(folder, name), { recursive: true, force: true }).catch(() => {})
      }
      const copies: ScratchAttachment[] = []
      for (const a of all) {
        const copy = path.join(folder, a.filename)
        // A name can come back for another image once the first was removed: the content decides.
        if (!(await sameContent(copy, a))) {
          const copied = await fs.copyFile(a.path, copy).then(() => true, () => false)
          if (!copied) continue
        }
        copies.push({ filename: a.filename, path: copy })
      }
      return copies
    })
  }
}

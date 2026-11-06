import { Box, Button, CloseButton, FileButton, Group, Image, Loader, Modal, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core'
import { useState, type DragEvent, type ReactElement } from 'react'
import type { NewAttachment } from '../../../shared/api'
import { ATTACHMENTS_PER_TICKET, sniffImage, type Attachment, type ImageRef } from '../../../shared/attachments'
import { invoke } from '../api'
import { showError } from '../notify'
import type { BoardTicket } from '../store'
import { attachToTicket, dragHasFiles, filesOf, useAttachmentImage, useLocalPreview } from './files'

/** What the file picker offers; the engine checks the bytes whatever the picker let through. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

const THUMB = 96

/** A drop target for image files, with a picker beside the hint. */
export function DropZone({ onFiles, disabled = false }: { onFiles: (files: File[]) => void; disabled?: boolean }): ReactElement {
  const [over, setOver] = useState(false)
  const accept = (e: DragEvent): void => {
    if (disabled || !dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    setOver(true)
  }
  return (
    <Box
      data-drop-zone
      p="sm"
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const files = filesOf(e.dataTransfer)
        if (disabled || files.length === 0) return
        e.preventDefault()
        onFiles(files)
      }}
      style={{
        border: `1px dashed var(--mantine-color-${over ? 'blue-6' : 'default-border'})`,
        borderRadius: 'var(--mantine-radius-sm)',
        background: over ? 'var(--mantine-color-default-hover)' : undefined
      }}
    >
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Drop images here or paste with Ctrl+V. PNG, JPEG, GIF or WebP, up to 10 MB.
        </Text>
        <FileButton onChange={(files) => onFiles(files)} accept={IMAGE_ACCEPT} multiple disabled={disabled}>
          {(props) => (
            <Button {...props} size="compact-sm" variant="default" style={{ flexShrink: 0 }}>
              Choose images
            </Button>
          )}
        </FileButton>
      </Group>
    </Box>
  )
}

/** A larger view of one image. */
function Preview({ name, src, onClose }: { name: string; src: string | null; onClose: () => void }): ReactElement {
  return (
    <Modal opened onClose={onClose} title={name} size="auto" centered>
      {src === null ? <Loader /> : <Image src={src} alt={name} mah="75vh" maw="80vw" fit="contain" />}
    </Modal>
  )
}

/** A thumbnail that opens the preview, with its own remove button when it can be removed, and its name below. */
function Thumb({
  name,
  src,
  onOpen,
  onRemove,
  size = THUMB,
  caption = true
}: {
  name: string
  src: string | null
  onOpen: () => void
  onRemove?: () => void
  size?: number
  caption?: boolean
}): ReactElement {
  return (
    <Box pos="relative" w={size}>
      <UnstyledButton aria-label={`Preview ${name}`} onClick={onOpen} title={name} w={size} h={size} style={{ display: 'block' }}>
        {src === null ? (
          <Box w={size} h={size} bg="var(--mantine-color-default-hover)" style={{ borderRadius: 'var(--mantine-radius-sm)' }} />
        ) : (
          <Image src={src} alt={name} w={size} h={size} fit="cover" radius="sm" />
        )}
      </UnstyledButton>
      {onRemove && (
        <CloseButton
          aria-label={`Remove ${name}`}
          size={size < THUMB ? 'xs' : 'sm'}
          variant="filled"
          pos="absolute"
          top={2}
          right={2}
          onClick={onRemove}
        />
      )}
      {caption && (
        <Text size="xs" c="dimmed" truncate="end">
          {name}
        </Text>
      )}
    </Box>
  )
}

/** The size of the images in the orchestrator panel's input and thread. */
const SMALL_THUMB = 56

/** An image the user sent the orchestrator, by id: a thumbnail, without its name, that opens a larger view. */
export function SentImage({ image, size = SMALL_THUMB }: { image: ImageRef; size?: number }): ReactElement {
  const src = useAttachmentImage(image.id, 'orchestrator.image')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Thumb name={image.filename} src={src} onOpen={() => setOpen(true)} size={size} caption={false} />
      {open && <Preview name={image.filename} src={src} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The images sent with a message in the orchestrator's thread. */
export function SentImages({ images }: { images: ImageRef[] }): ReactElement {
  return (
    <Group gap={6} justify="flex-end" role="group" aria-label="Images sent">
      {images.map((image) => (
        <SentImage key={image.id} image={image} />
      ))}
    </Group>
  )
}

/** The images of a message being written to the orchestrator: small thumbnails above its box, each removable before sending. */
export function MessageImages({ images, onRemove }: { images: NewAttachment[]; onRemove: (i: number) => void }): ReactElement {
  const [previewing, setPreviewing] = useState<{ name: string; src: string } | null>(null)
  return (
    // Spaced so that a remove button's 44 px hit area stays clear of the next thumbnail.
    <Group gap="md" role="group" aria-label="Images to send">
      {images.map((image, i) => (
        <PendingThumb
          key={i}
          image={image}
          size={SMALL_THUMB}
          onOpen={(src) => setPreviewing({ name: image.name, src })}
          onRemove={() => onRemove(i)}
        />
      ))}
      {previewing && <Preview name={previewing.name} src={previewing.src} onClose={() => setPreviewing(null)} />}
    </Group>
  )
}

function AttachedThumb({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }): ReactElement {
  const src = useAttachmentImage(attachment.id)
  async function remove(): Promise<void> {
    try {
      await invoke('attachment.remove', attachment.id)
    } catch (err) {
      showError(err, "Couldn't remove the image")
    }
  }
  return <Thumb name={attachment.filename} src={src} onOpen={onOpen} onRemove={() => void remove()} />
}

/** The ticket view's Attachments: the images the user attached, which every role of the ticket can read. */
export function AttachmentsSection({ ticket }: { ticket: BoardTicket }): ReactElement {
  const [previewing, setPreviewing] = useState<{ name: string; id: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const full = ticket.attachments.length >= ATTACHMENTS_PER_TICKET

  async function add(files: File[]): Promise<void> {
    setAdding(true)
    try {
      await attachToTicket(ticket.id, files, ticket.attachments.length)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Stack gap="xs">
      {ticket.attachments.length > 0 && (
        <SimpleGrid cols={3} spacing="xs" verticalSpacing="xs">
          {ticket.attachments.map((a) => (
            <AttachedThumb key={a.id} attachment={a} onOpen={() => setPreviewing({ name: a.filename, id: a.id })} />
          ))}
        </SimpleGrid>
      )}
      {full ? (
        <Text size="xs" c="dimmed">{`A ticket can have at most ${ATTACHMENTS_PER_TICKET} images.`}</Text>
      ) : (
        <DropZone onFiles={(files) => void add(files)} disabled={adding} />
      )}
      {previewing && <AttachmentPreview id={previewing.id} name={previewing.name} onClose={() => setPreviewing(null)} />}
    </Stack>
  )
}

function AttachmentPreview({ id, name, onClose }: { id: string; name: string; onClose: () => void }): ReactElement {
  return <Preview name={name} src={useAttachmentImage(id)} onClose={onClose} />
}

function PendingThumb({
  image,
  onOpen,
  onRemove,
  size
}: {
  image: NewAttachment
  onOpen: (src: string) => void
  onRemove: () => void
  size?: number
}): ReactElement {
  const src = useLocalPreview(image.bytes, sniffImage(image.bytes) ?? 'image/png')
  return (
    <Thumb name={image.name} src={src === '' ? null : src} onOpen={() => onOpen(src)} onRemove={onRemove} {...(size !== undefined ? { size, caption: false } : {})} />
  )
}

/** The New ticket dialog's images, attached when the ticket is created. */
export function PendingImages({ images, onAdd, onRemove }: { images: NewAttachment[]; onAdd: (files: File[]) => void; onRemove: (i: number) => void }): ReactElement {
  const [previewing, setPreviewing] = useState<{ name: string; src: string } | null>(null)
  return (
    <Stack gap="xs" aria-label="Images" role="group">
      <Text size="sm" fw={500}>
        Images
      </Text>
      {images.length > 0 && (
        <SimpleGrid cols={4} spacing="xs" verticalSpacing="xs">
          {images.map((image, i) => (
            <PendingThumb key={i} image={image} onOpen={(src) => setPreviewing({ name: image.name, src })} onRemove={() => onRemove(i)} />
          ))}
        </SimpleGrid>
      )}
      {images.length < ATTACHMENTS_PER_TICKET && <DropZone onFiles={onAdd} />}
      {previewing && <Preview name={previewing.name} src={previewing.src} onClose={() => setPreviewing(null)} />}
    </Stack>
  )
}

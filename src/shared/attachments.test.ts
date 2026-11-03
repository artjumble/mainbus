import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TICKET, sanitizeFilename, sniffImage, uniqueFilename, whyNotAttachable } from './attachments'

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))

const PNG =bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13])
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0])
const GIF = bytes('GIF89a', [1, 0])
const WEBP = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')
const SVG = bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

describe('sniffImage', () => {
  test('knows PNG, JPEG, GIF and WebP by their leading bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(GIF)).toBe('image/gif')
    expect(sniffImage(bytes('GIF87a'))).toBe('image/gif')
    expect(sniffImage(WEBP)).toBe('image/webp')
  })

  test('knows nothing else, whatever it is called', () => {
    expect(sniffImage(SVG)).toBeNull()
    expect(sniffImage(bytes('hello, world'))).toBeNull()
    expect(sniffImage(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
    expect(sniffImage(bytes([0x89, 0x50]))).toBeNull()
  })
})

describe('whyNotAttachable', () => {
  test('lets the four image types through', () => {
    for (const [name, data] of [['a.png', PNG], ['b.jpg', JPEG], ['c.gif', GIF], ['d.webp', WEBP]] as const) {
      expect(whyNotAttachable(name, data, 0)).toBeNull()
    }
  })

  test('refuses SVG, by its name or its content, because it can carry script', () => {
    expect(whyNotAttachable('logo.svg', SVG, 0)).toMatch(/SVG .* can carry script/)
    expect(whyNotAttachable('logo.png', SVG, 0)).toMatch(/can carry script/)
    expect(whyNotAttachable('logo.svg', PNG, 0)).toMatch(/can carry script/)
    // A UTF-8 byte order mark and blank space before the markup.
    expect(whyNotAttachable('page.png', bytes([0xef, 0xbb, 0xbf], '  <html>'), 0)).toMatch(/can carry script/)
  })

  test('refuses a renamed non-image with a plain reason', () => {
    expect(whyNotAttachable('notes.png', bytes('just some text'), 0)).toBe('notes.png is not a PNG, JPEG, GIF or WebP image.')
    expect(whyNotAttachable('archive.jpg', bytes([0x50, 0x4b, 3, 4]), 0)).toMatch(/not a PNG, JPEG, GIF or WebP/)
  })

  test('takes up to 10 MB', () => {
    const exactly = new Uint8Array(ATTACHMENT_MAX_BYTES)
    exactly.set(PNG)
    expect(whyNotAttachable('big.png', exactly, 0)).toBeNull()
    const over = new Uint8Array(ATTACHMENT_MAX_BYTES + 1)
    over.set(PNG)
    expect(whyNotAttachable('big.png', over, 0)).toBe('big.png is 10 MB; an attachment can be at most 10 MB.')
  })

  test('takes up to 20 per ticket', () => {
    expect(whyNotAttachable('a.png', PNG, ATTACHMENTS_PER_TICKET - 1)).toBeNull()
    expect(whyNotAttachable('a.png', PNG, ATTACHMENTS_PER_TICKET)).toBe('A ticket can have at most 20 attachments; remove one first.')
  })
})

describe('sanitizeFilename', () => {
  test('keeps a plain name as given', () => {
    expect(sanitizeFilename('Login screen.png', 'image/png')).toBe('Login screen.png')
    expect(sanitizeFilename('photo.JPEG', 'image/jpeg')).toBe('photo.jpeg')
  })

  test('drops folders, control and reserved characters, and gives the extension of the real type', () => {
    expect(sanitizeFilename('..\\..\\evil/../x.png', 'image/png')).toBe('x.png')
    expect(sanitizeFilename('a<b>:c"d|e?f*\u0007.gif', 'image/gif')).toBe('abcdef.gif')
    expect(sanitizeFilename('actually-a-jpeg.png', 'image/jpeg')).toBe('actually-a-jpeg.jpg')
    expect(sanitizeFilename('no extension', 'image/webp')).toBe('no extension.webp')
  })

  test('never gives an empty, hidden or reserved name', () => {
    expect(sanitizeFilename('', 'image/png')).toBe('image.png')
    expect(sanitizeFilename('...', 'image/png')).toBe('image.png')
    expect(sanitizeFilename('.hidden.png', 'image/png')).toBe('hidden.png')
    expect(sanitizeFilename('CON.png', 'image/png')).toBe('_CON.png')
    expect(sanitizeFilename(`${'a'.repeat(300)}.png`, 'image/png')).toBe(`${'a'.repeat(100)}.png`)
  })
})

test('uniqueFilename numbers a name the ticket has already, ignoring case', () => {
  expect(uniqueFilename('shot.png', [])).toBe('shot.png')
  expect(uniqueFilename('shot.png', ['SHOT.png'])).toBe('shot-2.png')
  expect(uniqueFilename('shot.png', ['shot.png', 'shot-2.png'])).toBe('shot-3.png')
})

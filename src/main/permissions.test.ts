import { describe, expect, test } from 'vitest'
import { allowPermission } from './permissions'

const FILE_APP = 'file:///C:/Mainbus/out/renderer/index.html'
const DEV_APP = 'http://localhost:5173/'

describe('allowPermission', () => {
  test.each([
    ['the built page', FILE_APP, FILE_APP],
    ['the built page with a query', FILE_APP, `${FILE_APP}?voice=fake`],
    ['the dev page', DEV_APP, 'http://localhost:5173/#/board']
  ])('lets %s use the microphone', (_name, app, url) => {
    expect(allowPermission('media', { requestingUrl: url, mediaTypes: ['audio'] }, app)).toBe(true)
  })

  test('lets the page list its devices and check for the microphone', () => {
    expect(allowPermission('media', { requestingUrl: FILE_APP, mediaType: 'unknown' }, FILE_APP)).toBe(true)
    expect(allowPermission('media', { requestingUrl: FILE_APP, mediaType: 'audio' }, FILE_APP)).toBe(true)
    expect(allowPermission('media', { requestingUrl: FILE_APP, mediaType: 'video' }, FILE_APP)).toBe(false)
  })

  test('refuses the camera, alone or with the microphone', () => {
    expect(allowPermission('media', { requestingUrl: FILE_APP, mediaTypes: ['video'] }, FILE_APP)).toBe(false)
    expect(allowPermission('media', { requestingUrl: FILE_APP, mediaTypes: ['audio', 'video'] }, FILE_APP)).toBe(false)
    expect(allowPermission('media', { requestingUrl: FILE_APP, mediaTypes: [] }, FILE_APP)).toBe(false)
  })

  test('refuses any other page, and a URL that does not parse', () => {
    expect(allowPermission('media', { requestingUrl: 'https://example.com/', mediaTypes: ['audio'] }, FILE_APP)).toBe(false)
    expect(allowPermission('media', { requestingUrl: 'http://localhost:9999/', mediaTypes: ['audio'] }, DEV_APP)).toBe(false)
    expect(allowPermission('media', { requestingUrl: 'not a url', mediaTypes: ['audio'] }, FILE_APP)).toBe(false)
    expect(allowPermission('media', { mediaTypes: ['audio'] }, FILE_APP)).toBe(false)
  })

  test('keeps the other permissions, the copy buttons need clipboard-sanitized-write, for the app page only', () => {
    expect(allowPermission('clipboard-sanitized-write', { requestingUrl: FILE_APP }, FILE_APP)).toBe(true)
    expect(allowPermission('clipboard-sanitized-write', { requestingUrl: 'https://example.com/' }, FILE_APP)).toBe(false)
  })
})

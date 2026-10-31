import { describe, expect, it } from 'vitest'
import { isAppUrl, isExternalWebUrl } from './appUrl'

describe('isAppUrl', () => {
  const file = 'file:///C:/Program%20Files/Mainbus/resources/app/out/renderer/index.html'

  it('accepts the app page itself, ignoring query and hash', () => {
    expect(isAppUrl(file, file)).toBe(true)
    expect(isAppUrl(`${file}#/board?x=1`, file)).toBe(true)
    expect(isAppUrl('file:///C:/Program Files/Mainbus/resources/app/out/renderer/index.html', file)).toBe(true)
  })

  it('rejects other files, other schemes and the web in a packaged build', () => {
    expect(isAppUrl('file:///C:/Windows/win.ini', file)).toBe(false)
    expect(isAppUrl('file:///C:/Program%20Files/Mainbus/resources/app/out/renderer/other.html', file)).toBe(false)
    expect(isAppUrl('https://example.com/', file)).toBe(false)
    expect(isAppUrl('about:blank', file)).toBe(false)
    expect(isAppUrl('javascript:alert(1)', file)).toBe(false)
    expect(isAppUrl('not a url', file)).toBe(false)
    expect(isAppUrl('', file)).toBe(false)
  })

  it('rejects a file URL on another host', () => {
    expect(isAppUrl('file://evil/C:/Program%20Files/Mainbus/resources/app/out/renderer/index.html', file)).toBe(false)
  })

  it('returns false instead of throwing on malformed percent-encoding', () => {
    expect(isAppUrl('file:///C:/a/%zz', file)).toBe(false)
    expect(isAppUrl('file:///C:/Program%20Files/%E0%A4%A/index.html', file)).toBe(false)
    expect(isAppUrl(file, 'file:///C:/a/%zz')).toBe(false)
    expect(isAppUrl('http://localhost:5173/%zz', 'http://localhost:5173/')).toBe(true)
  })

  it('accepts any page on the dev server origin and nothing else', () => {
    const dev = 'http://localhost:5173/'
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173/src/main.tsx?t=1', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false)
    expect(isAppUrl('http://localhost.evil.com:5173/', dev)).toBe(false)
    expect(isAppUrl('http://localhost:5173@evil.com/', dev)).toBe(false)
    expect(isAppUrl('file:///C:/x/index.html', dev)).toBe(false)
  })

  it('rejects everything when the app URL itself is not valid', () => {
    expect(isAppUrl('http://localhost:5173/', 'nope')).toBe(false)
  })
})

describe('isExternalWebUrl', () => {
  it('allows only http and https', () => {
    expect(isExternalWebUrl('https://example.com/a')).toBe(true)
    expect(isExternalWebUrl('http://example.com')).toBe(true)
    expect(isExternalWebUrl('file:///C:/Windows/win.ini')).toBe(false)
    expect(isExternalWebUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalWebUrl('ms-msdt:/id')).toBe(false)
    expect(isExternalWebUrl('nope')).toBe(false)
    expect(isExternalWebUrl('https://example.com/%zz')).toBe(true)
    expect(isExternalWebUrl('https://exa mple.com/')).toBe(false)
  })
})

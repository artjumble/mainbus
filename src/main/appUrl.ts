/**
 * True when `url` is the app's own page: the same file for a packaged build (`file:` URL), or the same
 * origin for the dev server. Query and hash are ignored. Never throws: anything that does not parse or
 * decode is not the app.
 */
export function isAppUrl(url: string, appUrl: string): boolean {
  try {
    const candidate = new URL(url)
    const app = new URL(appUrl)
    if (candidate.protocol !== app.protocol) return false
    if (app.protocol === 'file:') {
      // A file URL's host names another machine (a network share), so it must match too.
      return candidate.host === app.host && decodeURIComponent(candidate.pathname) === decodeURIComponent(app.pathname)
    }
    return candidate.origin === app.origin
  } catch {
    // Unparseable or badly percent-encoded: not the app.
    return false
  }
}

/** Links the user may open in their own browser. Anything else (file:, javascript:, custom schemes) is dropped. */
export function isExternalWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

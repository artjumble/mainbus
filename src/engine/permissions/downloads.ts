// Downloaders write files only through their output options. This reads those
// options for curl, wget and PowerShell's Invoke-WebRequest / Invoke-RestMethod.

export const DOWNLOAD_COMMANDS = new Set(['iwr', 'irm', 'curl', 'wget'])

const OUT_FILE = /^-out(f(i(l(e)?)?)?)?$/i

/** Files Invoke-WebRequest and Invoke-RestMethod write: the value of -OutFile (or -o). */
function outFileTargets(args: string[], short: boolean): string[] {
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const attached = /^-out(?:f(?:i(?:l(?:e)?)?)?)?:(.+)$/i.exec(args[i])
    if (attached) targets.push(attached[1])
    else if ((OUT_FILE.test(args[i]) || (short && args[i].toLowerCase() === '-o')) && args[i + 1] !== undefined) {
      targets.push(args[++i])
    }
  }
  return targets
}

interface DownloaderOptions {
  /** Short letters that take a value, attached or as the next argument. */
  valued: string
  /** Short letters whose value is a file or folder the tool writes. */
  writes: string
  /** Short letters that write into the current folder without a value. */
  writesHere: string
  /** Short letters whose value holds more options. */
  config: string
  longWrites: string[]
  longWritesHere: string[]
  longConfig: string[]
  /** Other long options with a value, so the value isn't read as a positional path. */
  longValued: string[]
}

const CURL: DownloaderOptions = {
  valued: 'bcCdDeEFHKmoPQrtTuUwxXyYzA',
  writes: 'oDc',
  writesHere: 'O',
  config: 'K',
  longWrites: ['output', 'output-dir', 'dump-header', 'cookie-jar', 'trace', 'trace-ascii', 'stderr', 'libcurl'].concat(
    ['etag-save', 'hsts', 'alt-svc'],
  ),
  longWritesHere: ['remote-name', 'remote-name-all', 'remote-header-name', 'create-dirs'],
  longConfig: ['config'],
  longValued: ['header', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'user', 'user-agent', 'cacert'].concat(
    ['cert', 'key', 'form', 'upload-file', 'request', 'proxy', 'referer', 'cookie', 'max-time', 'connect-timeout'],
    ['retry', 'url', 'write-out', 'range', 'json', 'capath', 'resolve'],
  ),
}
const WGET: DownloaderOptions = {
  valued: 'oaOPeiBtTwQlARDXIUn',
  writes: 'oaOP',
  writesHere: '',
  config: '',
  longWrites: ['output-document', 'output-file', 'append-output', 'directory-prefix', 'save-cookies', 'warc-file'].concat(
    ['rejected-log', 'hsts-file'],
  ),
  longWritesHere: [],
  longConfig: ['config'],
  longValued: ['input-file', 'base', 'tries', 'timeout', 'wait', 'quota', 'level', 'accept', 'reject', 'domains'].concat(
    ['user-agent', 'header', 'post-data', 'post-file', 'user', 'password', 'http-user', 'http-password'],
    ['load-cookies', 'ca-certificate', 'certificate', 'private-key', 'method', 'body-data', 'body-file', 'referer', 'execute'],
  ),
}
// wget -e runs a wgetrc command; these ones name a file or folder that wget writes.
const WGETRC_WRITES = new Set(['dirprefix', 'outputdocument', 'logfile', 'savecookies', 'warcfile', 'rejectedlog', 'hstsfile'])

export interface Download {
  /** The command writes a file (into the current folder when `targets` is empty). */
  writes: boolean
  /** Options come from a file Mainbus can't read (curl -K, wget --config). */
  config: boolean
  /** Option values the tool writes to. */
  targets: string[]
  /** Other arguments: URLs, plus any path a misread option might have hidden. */
  positional: string[]
}

type LongKind = 'write' | 'here' | 'config' | 'value' | 'other'

// An exact name wins (`--cookie` is not `--cookie-jar`); otherwise a prefix, as both
// tools accept abbreviated long options.
function longOption(name: string, o: DownloaderOptions): [LongKind, string] {
  const kinds: [LongKind, string[]][] = [
    ['write', o.longWrites],
    ['here', o.longWritesHere],
    ['config', o.longConfig],
    ['value', o.longValued],
  ]
  for (const [kind, list] of kinds) if (list.includes(name)) return [kind, name]
  for (const [kind, list] of kinds) {
    const option = name === '' ? undefined : list.find((candidate) => candidate.startsWith(name))
    if (option !== undefined) return [kind, option]
  }
  return ['other', name]
}

function readOptions(args: string[], o: DownloaderOptions): Download {
  const d: Download = { writes: false, config: false, targets: [], positional: [] }
  const write = (target: string | undefined): void => {
    d.writes = true
    if (target !== undefined) d.targets.push(target)
  }
  // A value that can name a file: curl -w '%output{file}', wget -e 'dir_prefix=dir'.
  const value = (option: string, v: string | undefined): void => {
    if (v === undefined) return
    if (o === CURL && (option === 'w' || option === 'write-out')) {
      const out = /%output\{>{0,2}([^}]*)\}/.exec(v)
      if (out) write(out[1])
    }
    const eq = v.indexOf('=')
    if (o === WGET && (option === 'e' || option === 'execute') && eq > 0) {
      if (WGETRC_WRITES.has(v.slice(0, eq).replace(/[-_]/g, '').toLowerCase())) write(v.slice(eq + 1))
    }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      d.positional.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase()
      const next = (): string | undefined => (eq < 0 ? args[++i] : a.slice(eq + 1))
      const [kind, option] = longOption(name, o)
      if (kind === 'write') write(next())
      else if (kind === 'here') d.writes = true
      else if (kind === 'config') d.config = true
      else if (kind === 'value') value(option, next())
      continue
    }
    if (a.length < 2 || !a.startsWith('-')) {
      d.positional.push(a)
      continue
    }
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]
      if (o.writesHere.includes(letter)) d.writes = true
      if (o.config.includes(letter)) d.config = true
      if (!o.valued.includes(letter)) continue
      const v = j + 1 < a.length ? a.slice(j + 1) : args[++i]
      if (o.writes.includes(letter)) write(v)
      else value(letter, v)
      break
    }
  }
  return d
}

/** What a downloader writes; null when `name` is not a downloader. */
export function readDownload(name: string, args: string[]): Download | null {
  if (!DOWNLOAD_COMMANDS.has(name)) return null
  // PowerShell's -OutFile also applies to curl and wget, which are aliases of iwr in Windows PowerShell.
  const outFile = outFileTargets(args, name === 'iwr' || name === 'irm')
  const options = name === 'curl' ? CURL : name === 'wget' ? WGET : null
  const d = options ? readOptions(args, options) : { writes: false, config: false, targets: [], positional: [] }
  return { ...d, writes: d.writes || outFile.length > 0, targets: [...outFile, ...d.targets] }
}

/** The most workspaces one message can mention. */
export const MAX_MENTIONS = 20

/** A mention the engine resolved and stored with the user's message: `token` is the raw text, `name` the workspace's name then. */
export interface MentionRef {
  token: string
  workspaceId: string
  name: string
}

export interface MentionToken {
  start: number
  end: number
  /** The text as typed, with the trigger and any quotes. */
  raw: string
  /** The name between the trigger and the end, without quotes. */
  name: string
  quoted: boolean
}

const TRAILING = '.,;:!?)]'
const PLAIN = /[^\s"@]/

function atWordStart(text: string, i: number): boolean {
  return i === 0 || /\s/.test(text[i - 1]!)
}

/** The mentions in `text`: `@name` or `@"two words"`, with the trigger at the start of the text or after whitespace (so `a@b` is none). */
export function findMentions(text: string, trigger = '@'): MentionToken[] {
  const found: MentionToken[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== trigger || !atWordStart(text, i)) {
      i++
      continue
    }
    if (text[i + 1] === '"') {
      let j = i + 2
      while (j < text.length && text[j] !== '"' && text[j] !== '\n' && text[j] !== '\r') j++
      if (text[j] === '"' && j > i + 2) {
        found.push({ start: i, end: j + 1, raw: text.slice(i, j + 1), name: text.slice(i + 2, j), quoted: true })
        i = j + 1
        continue
      }
      i++
      continue
    }
    let j = i + 1
    while (j < text.length && PLAIN.test(text[j]!)) j++
    let end = j
    while (end > i + 1 && TRAILING.includes(text[end - 1]!)) end--
    if (end > i + 1) found.push({ start: i, end, raw: text.slice(i, end), name: text.slice(i + 1, end), quoted: false })
    i = Math.max(j, i + 1)
  }
  return found
}

/** What to insert for a name: `@name`, or `@"name"` when the name would end the token early. */
export function mentionText(name: string, trigger = '@'): string {
  const plain = name !== '' && !/[\s"@]/.test(name) && !TRAILING.includes(name[name.length - 1]!)
  return plain ? `${trigger}${name}` : `${trigger}"${name.replaceAll('"', '')}"`
}

/** The mention being typed at `caret`: where its trigger is and what follows it, or null. */
export function activeMention(text: string, caret: number, trigger = '@'): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const c = text[i]!
    if (c === '\n' || c === '\r') return null
    if (c === trigger) {
      if (!atWordStart(text, i)) return null
      const query = text.slice(i + 1, caret)
      return { start: i, query: query.startsWith('"') ? query.slice(1) : query }
    }
    if (c === '"' && text[i - 1] !== trigger) return null
  }
  return null
}

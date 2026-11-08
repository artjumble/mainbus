import type { Workspace } from '../../shared/domain'
import { findMentions } from '../../shared/mentions'
import { oneLine } from '../roles/prompt'

export interface ResolvedMentions {
  /** One per mentioned workspace, in the order of the text; `token` is the first mention of it. */
  resolved: { token: string; ws: Workspace }[]
  /** Mentions that matched no open workspace, or more than one. */
  unknown: string[]
}

/**
 * Settles which workspaces `text` mentions. A picked id (the user chose it from the list) wins when its workspace's name
 * matches the token; otherwise the token must name exactly one open workspace, case-insensitively.
 */
export function resolveMentions(text: string, picked: string[], all: Workspace[]): ResolvedMentions {
  const resolved: ResolvedMentions['resolved'] = []
  const unknown: string[] = []
  for (const m of findMentions(text)) {
    const key = m.name.toLowerCase()
    const same = all.filter((w) => w.name.toLowerCase() === key)
    const ws = same.find((w) => picked.includes(w.id)) ?? (same.length === 1 ? same[0] : undefined)
    if (!ws) {
      if (!unknown.includes(m.raw)) unknown.push(m.raw)
    } else if (!resolved.some((r) => r.ws.id === ws.id)) resolved.push({ token: m.raw, ws })
  }
  return { resolved, unknown }
}

const CLIP = 60

/** The header line naming the mentioned workspaces, or null when the message has no mentions. */
export function mentionsLine(r: ResolvedMentions): string | null {
  const parts = [
    ...r.resolved.map(({ ws }) => `${oneLine(ws.name)} (id ${ws.id}, ${oneLine(ws.repoPath)})`),
    ...r.unknown.map((t) => `${JSON.stringify(oneLine(t.length > CLIP ? `${t.slice(0, CLIP)}…` : t))} (not a workspace)`)
  ]
  return parts.length === 0 ? null : `[Mainbus] Mentioned workspaces: ${parts.join('; ')}`
}

import type { Workspace } from '../../shared/domain'
import { oneLine } from '../roles/prompt'

export const NO_WORKSPACE = 'No workspace is open.'

/** The workspaces as a list the agent can pick from: name and id. */
export function workspaceChoices(all: Workspace[]): string {
  return all.map((w) => `${oneLine(w.name)} (id ${w.id})`).join(', ')
}

/**
 * The workspace a tool call names, by id, then slug, then name (case-insensitive); the focused one when `ref` is left
 * out. Nothing is guessed: an unknown or ambiguous name is answered with the choices.
 */
export function resolveWorkspaceRef(
  all: Workspace[],
  focused: Workspace | null,
  ref?: string
): { ok: true; ws: Workspace } | { ok: false; text: string } {
  if (ref === undefined || ref.trim() === '') {
    return focused ? { ok: true, ws: focused } : { ok: false, text: NO_WORKSPACE }
  }
  const wanted = ref.trim()
  const lower = wanted.toLowerCase()
  const byId = all.filter((w) => w.id === wanted)
  const matches =
    byId.length > 0
      ? byId
      : (() => {
          const bySlug = all.filter((w) => w.slug.toLowerCase() === lower)
          return bySlug.length > 0 ? bySlug : all.filter((w) => w.name.toLowerCase() === lower)
        })()
  if (matches.length === 1) return { ok: true, ws: matches[0]! }
  const why = matches.length === 0 ? `No workspace "${oneLine(wanted)}".` : `"${oneLine(wanted)}" matches more than one workspace; use its id.`
  return { ok: false, text: `${why} The workspaces are: ${all.length ? workspaceChoices(all) : 'none open'}.` }
}

/**
 * The workspace create_tickets puts tickets in. Never the focused one by default: with more than one open, `ref` must
 * name one, and the orchestrator is told to infer it from the conversation or ask. With one open it may be left out.
 */
export function resolveTargetWorkspace(all: Workspace[], ref?: string): { ok: true; ws: Workspace } | { ok: false; text: string } {
  if (ref === undefined || ref.trim() === '') {
    if (all.length === 0) return { ok: false, text: NO_WORKSPACE }
    if (all.length === 1) return { ok: true, ws: all[0]! }
    return {
      ok: false,
      text:
        `More than one workspace is open: ${workspaceChoices(all)}. Name one with workspace: infer it from the user's words or ` +
        `the recent conversation; if they don't make it clear, ask the user which one and end your turn.`
    }
  }
  return resolveWorkspaceRef(all, null, ref)
}

/** " (workspace app)" after a ticket's title, so a ticket number is never ambiguous across workspaces; nothing when unknown. */
export function wsTag(workspace?: string): string {
  return workspace === undefined ? '' : ` (workspace ${JSON.stringify(oneLine(workspace))})`
}

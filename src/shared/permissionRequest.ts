import type { Decision, PermissionRequestParts } from './domain'

/**
 * The parts of a permission question's text ("Implementer wants to run `cmd` — reason"), for decisions asked before
 * the parts were kept. A text ending in a backtick has no reason (the command may contain " — " itself); otherwise the
 * command ends at the last "` — ". The tool isn't in the text: a run is taken as Bash. Null for anything else.
 */
export function parsePermissionQuestion(question: string): PermissionRequestParts | null {
  const m = /^(.+?) wants to (run|edit) `/s.exec(question)
  if (m) {
    const rest = question.slice(m[0].length)
    let body: string
    let reason: string | null = null
    if (rest.endsWith('`')) body = rest.slice(0, -1)
    else {
      const at = rest.lastIndexOf('` — ')
      if (at < 0) return null
      body = rest.slice(0, at)
      reason = rest.slice(at + 4)
    }
    return m[2] === 'run'
      ? { role: m[1], tool: 'Bash', command: body, path: null, input: null, reason }
      : { role: m[1], tool: 'Edit', command: null, path: body, input: null, reason }
  }
  const use = /^(.+?) wants to use (\S+)(?: — (.*))?$/s.exec(question)
  if (use) return { role: use[1], tool: use[2], command: null, path: null, input: null, reason: use[3] ?? null }
  return null
}

/** The parts of a permission decision's request: the stored ones, else those parsed from its question. */
export function permissionRequestOf(d: Pick<Decision, 'request' | 'question'>): PermissionRequestParts | null {
  return d.request ?? parsePermissionQuestion(d.question)
}

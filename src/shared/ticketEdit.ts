// Shared by the engine and the renderer: types only, no Node imports.
import type { EditedField } from './domain'

/** The edited fields in the order they are listed. */
export const EDITED_FIELD_ORDER: EditedField[] = ['title', 'spec', 'criteria', 'labels', 'blockedBy', 'runSettings']

/** "spec, criteria, your words (+1)": what an edit changed. `words` is how the user's own words are called. */
export function describeEdit(fields: EditedField[], userWords: number, words: string): string {
  const parts: string[] = fields.map((f) => (f === 'blockedBy' ? 'blocked by' : f === 'runSettings' ? 'run settings' : f))
  if (userWords > 0) parts.push(`${words} (+${userWords})`)
  return parts.join(', ')
}

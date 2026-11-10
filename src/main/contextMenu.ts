import { Menu, type ContextMenuParams, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'

/** The most spelling suggestions the menu offers. */
export const MAX_SUGGESTIONS = 5

/** The parts of Electron's context-menu params the menu is built from. */
export type MenuParams = Pick<ContextMenuParams, 'isEditable' | 'misspelledWord' | 'dictionarySuggestions' | 'selectionText'> & {
  editFlags: Pick<ContextMenuParams['editFlags'], 'canUndo' | 'canRedo' | 'canCut' | 'canCopy' | 'canPaste' | 'canSelectAll'>
}

/** What the menu's items do to the page and the spellchecker; Electron's webContents and session in the app, fakes in tests. */
export interface MenuActions {
  replaceMisspelling(suggestion: string): void
  addToDictionary(word: string): void
}

/**
 * The right-click menu for what was clicked: in a text field the spelling fixes (when the word is misspelled) and
 * the edit actions; on selected text elsewhere, Copy; anywhere else none (an empty list).
 */
export function buildContextMenu(params: MenuParams, actions: MenuActions): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  if (!params.isEditable) {
    return params.selectionText.trim() !== '' ? [{ role: 'copy', enabled: flags.canCopy }, { role: 'selectAll' }] : []
  }
  const items: MenuItemConstructorOptions[] = []
  const word = params.misspelledWord
  if (word) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
    if (suggestions.length === 0) items.push({ label: 'No suggestions', enabled: false })
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) })
    }
    items.push({ label: 'Add to dictionary', click: () => actions.addToDictionary(word) }, { type: 'separator' })
  }
  items.push(
    { role: 'undo', enabled: flags.canUndo },
    { role: 'redo', enabled: flags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: flags.canCut },
    { role: 'copy', enabled: flags.canCopy },
    { role: 'paste', enabled: flags.canPaste },
    { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: flags.canPaste },
    { role: 'selectAll', enabled: flags.canSelectAll }
  )
  return items
}

/** The spellchecker languages to use: none when Chromium already has some, else the system locale, else en-US. */
export function spellCheckLanguages(current: string[], available: string[], locale: string): string[] | null {
  if (current.length > 0) return null
  const match = available.find((l) => l.toLowerCase() === locale.toLowerCase()) ?? available.find((l) => l.toLowerCase().startsWith(locale.split('-')[0]!.toLowerCase()))
  return [match ?? 'en-US']
}

/**
 * Shows the menu on a right-click (or the context-menu key, or Shift+F10) in the window. A click the page handled itself
 * (the board's cards) never reaches here. With `onTemplate`, a test run gets the template and no menu is shown.
 */
export function attachContextMenu(contents: WebContents, session: Session, onTemplate?: (items: MenuItemConstructorOptions[]) => void): void {
  contents.on('context-menu', (_event, params) => {
    const items = buildContextMenu(params, {
      replaceMisspelling: (s) => contents.replaceMisspelling(s),
      addToDictionary: (w) => {
        session.addWordToSpellCheckerDictionary(w)
      }
    })
    onTemplate?.(items)
    if (items.length === 0 || onTemplate) return
    Menu.buildFromTemplate(items).popup()
  })
}

/** Sets the spellchecker's language from the system locale when Chromium has picked none. */
export function ensureSpellCheckLanguages(session: Session, locale: string): void {
  const languages = spellCheckLanguages(session.getSpellCheckerLanguages(), session.availableSpellCheckerLanguages, locale)
  if (languages) session.setSpellCheckerLanguages(languages)
}

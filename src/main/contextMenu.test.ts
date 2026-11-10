import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: {} }))

import { buildContextMenu, MAX_SUGGESTIONS, spellCheckLanguages, type MenuParams } from './contextMenu'

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const params = (over: Partial<MenuParams> = {}): MenuParams => ({
  isEditable: true,
  misspelledWord: '',
  dictionarySuggestions: [],
  selectionText: '',
  editFlags: flags,
  ...over
})
const fakes = () => ({ replaceMisspelling: vi.fn(), addToDictionary: vi.fn() })
const labels = (items: { label?: string; role?: string }[]) => items.map((i) => i.label ?? i.role)

describe('buildContextMenu', () => {
  it('offers suggestions, Add to dictionary and the edit items for a misspelled word', () => {
    const actions = fakes()
    const items = buildContextMenu(params({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten', 'tech', 'tel', 'tex', 'tee'] }), actions)
    expect(labels(items).slice(0, MAX_SUGGESTIONS + 1)).toEqual(['the', 'tea', 'ten', 'tech', 'tel', 'Add to dictionary'])
    expect(labels(items)).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'Paste as plain text', 'selectAll']))
    items[1]!.click!(null as never, undefined, null as never)
    expect(actions.replaceMisspelling).toHaveBeenCalledWith('tea')
    items[5]!.click!(null as never, undefined, null as never)
    expect(actions.addToDictionary).toHaveBeenCalledWith('teh')
  })

  it('shows a disabled "No suggestions" when there are none', () => {
    const items = buildContextMenu(params({ misspelledWord: 'xqzv' }), fakes())
    expect(items[0]).toEqual({ label: 'No suggestions', enabled: false })
    expect(items[1]!.label).toBe('Add to dictionary')
  })

  it('enables the edit items by editFlags', () => {
    const items = buildContextMenu(params({ editFlags: { ...flags, canCut: false, canPaste: false, canUndo: false } }), fakes())
    const enabled = (role: string) => items.find((i) => i.role === role)!.enabled
    expect(enabled('cut')).toBe(false)
    expect(enabled('paste')).toBe(false)
    expect(enabled('pasteAndMatchStyle')).toBe(false)
    expect(enabled('undo')).toBe(false)
    expect(enabled('copy')).toBe(true)
    expect(items.some((i) => i.label === 'Add to dictionary')).toBe(false)
  })

  it('gives Copy for selected text outside a field', () => {
    const items = buildContextMenu(params({ isEditable: false, selectionText: 'hello' }), fakes())
    expect(labels(items)).toContain('copy')
    expect(labels(items)).not.toContain('paste')
  })

  it('gives no menu when nothing is editable or selected', () => {
    expect(buildContextMenu(params({ isEditable: false }), fakes())).toEqual([])
  })
})

describe('spellCheckLanguages', () => {
  const available = ['en-US', 'de-DE', 'fr-FR']
  it('keeps what Chromium chose', () => expect(spellCheckLanguages(['en-GB'], available, 'de-DE')).toBeNull())
  it('uses the system locale', () => expect(spellCheckLanguages([], available, 'de-DE')).toEqual(['de-DE']))
  it('falls back to en-US', () => expect(spellCheckLanguages([], available, 'xx-YY')).toEqual(['en-US']))
})

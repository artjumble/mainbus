const COPIED = [
  'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform',
  'wordSpacing', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
  'borderBottomWidth', 'borderLeftWidth', 'tabSize'
] as const

/** Where the caret at `index` is, in pixels from the textarea's top left corner (the bottom of its line): a hidden copy of the box is measured. */
export function caretPosition(box: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const mirror = document.createElement('div')
  const style = getComputedStyle(box)
  for (const key of COPIED) mirror.style[key] = style[key]
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' })
  mirror.textContent = box.value.slice(0, index)
  const marker = document.createElement('span')
  marker.textContent = '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const left = marker.offsetLeft - box.scrollLeft
  const top = marker.offsetTop + marker.offsetHeight - box.scrollTop
  mirror.remove()
  return { left, top }
}

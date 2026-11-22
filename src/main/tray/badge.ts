/** How the taskbar badge is shown: a drawn overlay icon (Windows), a launcher count (Linux), or not at all yet. */
export function badgeKind(platform: NodeJS.Platform): 'overlay' | 'count' | 'none' {
  if (platform === 'win32') return 'overlay'
  if (platform === 'linux') return 'count'
  return 'none'
}

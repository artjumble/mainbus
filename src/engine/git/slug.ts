const MAX_SLUG_LENGTH = 40
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

/** Lowercase ASCII `[a-z0-9-]`, at most 40 chars, safe as a Windows folder name. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  if (slug === '') return 'ticket'
  return WINDOWS_RESERVED.test(slug) ? `${slug}-t` : slug
}

export function branchName(number: number, title: string): string {
  return `mainbus/${number}-${slugify(title)}`
}

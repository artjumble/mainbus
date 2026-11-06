export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

/** A simple line diff of `a` to `b` (the longest common subsequence of their lines), in order. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a === '' ? [] : a.split('\n')
  const y = b === '' ? [] : b.split('\n')
  // lcs[i][j]: the length of the common subsequence of x[i..] and y[j..].
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: x[i++]! })
    } else {
      out.push({ kind: 'added', text: y[j++]! })
    }
  }
  while (i < x.length) out.push({ kind: 'removed', text: x[i++]! })
  while (j < y.length) out.push({ kind: 'added', text: y[j++]! })
  return out
}

import { lineDiff } from './lineDiff'

test('identical text is all unchanged lines', () => {
  expect(lineDiff('a\nb', 'a\nb')).toEqual([
    { kind: 'same', text: 'a' },
    { kind: 'same', text: 'b' }
  ])
})

test('a removed line and an added line sit where they happened', () => {
  expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'same', text: 'c' },
    { kind: 'added', text: 'd' }
  ])
})

test('empty text has no lines', () => {
  expect(lineDiff('', 'x')).toEqual([{ kind: 'added', text: 'x' }])
  expect(lineDiff('x', '')).toEqual([{ kind: 'removed', text: 'x' }])
  expect(lineDiff('', '')).toEqual([])
})
